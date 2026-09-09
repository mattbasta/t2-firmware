/*
 * Tessel 2 runtime — native primitives.
 *
 * Everything here is something the JS layer cannot express on its own. The bar
 * for adding to this file is deliberately high: the runtime is JS-first by
 * design so the engine underneath stays swappable (strategy §4).
 *
 * The synchronous file operations are here because CommonJS is synchronous by
 * contract — require() must read and resolve without yielding to the loop — and
 * txiki has no synchronous read at all: its ESM loader does that work in C, and
 * everything it exposes to JS (tjs.readFile and friends) is promise-based. So
 * the loader needs its own primitives, ahead of node:fs proper in Phase 2.
 *
 * SPDX-License-Identifier: MIT
 */

#include "t2.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <uv.h>

/* Node-shaped error, message included: era code branches on `err.code`, but it
 * also prints these, and "ENOENT: no such file or directory, open '/x/y.js'" is
 * the text a decade of Node users can read at a glance. */
JSValue t2_new_uv_error(JSContext *ctx, int r, const char *syscall, const char *path, const char *dest) {
    char message[2 * PATH_MAX + 128];

    if (path && dest) {
        snprintf(message,
                 sizeof(message),
                 "%s: %s, %s '%s' -> '%s'",
                 uv_err_name(r),
                 uv_strerror(r),
                 syscall,
                 path,
                 dest);
    } else if (path) {
        snprintf(message, sizeof(message), "%s: %s, %s '%s'", uv_err_name(r), uv_strerror(r), syscall, path);
    } else {
        snprintf(message, sizeof(message), "%s: %s, %s", uv_err_name(r), uv_strerror(r), syscall);
    }

    JSValue err = JS_NewError(ctx);

    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message));
    JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, uv_err_name(r)));
    JS_SetPropertyStr(ctx, err, "errno", JS_NewInt32(ctx, r));
    JS_SetPropertyStr(ctx, err, "syscall", JS_NewString(ctx, syscall));

    if (path) {
        JS_SetPropertyStr(ctx, err, "path", JS_NewString(ctx, path));
    }

    if (dest) {
        JS_SetPropertyStr(ctx, err, "dest", JS_NewString(ctx, dest));
    }

    return err;
}

JSValue t2_throw_uv2(JSContext *ctx, int r, const char *syscall, const char *path, const char *dest) {
    return JS_Throw(ctx, t2_new_uv_error(ctx, r, syscall, path, dest));
}

JSValue t2_throw_uv(JSContext *ctx, int r, const char *syscall, const char *path) {
    return t2_throw_uv2(ctx, r, syscall, path, NULL);
}

/* A callback invoked from inside a libuv callback has nowhere to throw. The JS
 * layer wraps everything it installs and routes exceptions to
 * process.on('uncaughtException'), so reaching this means the wrapper itself
 * failed — which is worth saying out loud rather than swallowing. */
void t2_report_exception(JSContext *ctx, const char *where) {
    JSValue exc = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, exc);

    fprintf(stderr, "node: unhandled exception in %s: %s\n", where, text ? text : "(unprintable)");

    if (text) {
        JS_FreeCString(ctx, text);
    }

    JS_FreeValue(ctx, exc);
}

/*
 * evalScript(source, filename) -> completion value
 *
 * Compiles and runs source as a *classic script*, not a module. CommonJS needs
 * this: a module is wrapped as
 *
 *     (function (exports, require, module, __filename, __dirname) { ... })
 *
 * and evaluated as an expression yielding the wrapper function. txiki's
 * tjs.engine.compile() cannot do it — it hardcodes JS_EVAL_TYPE_MODULE
 * (deps/txiki.js/src/mod_engine.c) — and the Function constructor, the other
 * route to the same shape, discards the filename, so every frame in every user
 * module would report as <anonymous>.
 */
static JSValue t2_eval_script(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    size_t len;
    const char *source = JS_ToCStringLen(ctx, &len, argv[0]);

    if (!source) {
        return JS_EXCEPTION;
    }

    const char *filename = JS_ToCString(ctx, argv[1]);

    if (!filename) {
        JS_FreeCString(ctx, source);
        return JS_EXCEPTION;
    }

    JSValue ret = JS_Eval(ctx, source, len, filename, JS_EVAL_TYPE_GLOBAL);

    JS_FreeCString(ctx, filename);
    JS_FreeCString(ctx, source);

    return ret;
}

/* readFileSync(path) -> string
 *
 * UTF-8 decoded here rather than in JS: the loader reads every module through
 * this, and a TextDecoder round-trip per module is not free on a 580 MHz core. */
static JSValue t2_read_file_sync(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    const char *path = JS_ToCString(ctx, argv[0]);

    if (!path) {
        return JS_EXCEPTION;
    }

    uv_fs_t req;
    const char *syscall = "open";
    int fd = uv_fs_open(NULL, &req, path, UV_FS_O_RDONLY, 0, NULL);

    uv_fs_req_cleanup(&req);

    if (fd < 0) {
        JSValue err = t2_throw_uv(ctx, fd, syscall, path);

        JS_FreeCString(ctx, path);

        return err;
    }

    syscall = "fstat";

    int r = uv_fs_fstat(NULL, &req, fd, NULL);
    uint64_t size = (r == 0) ? req.statbuf.st_size : 0;

    uv_fs_req_cleanup(&req);

    char *buf = NULL;
    size_t off = 0;

    if (r == 0) {
        buf = js_malloc(ctx, size + 1);

        if (!buf) {
            r = UV_ENOMEM;
        }
    }

    /* Loop rather than trusting one read to return st_size: short reads are
     * legal, and the file may have changed size since the fstat. */
    syscall = "read";

    while (r == 0 && off < size) {
        uv_buf_t b = uv_buf_init(buf + off, size - off);
        int n = uv_fs_read(NULL, &req, fd, &b, 1, -1, NULL);

        uv_fs_req_cleanup(&req);

        if (n < 0) {
            r = n;
        } else if (n == 0) {
            break; /* EOF early — file shrank. */
        } else {
            off += n;
        }
    }

    uv_fs_close(NULL, &req, fd, NULL);
    uv_fs_req_cleanup(&req);

    if (r != 0) {
        js_free(ctx, buf);

        JSValue err = t2_throw_uv(ctx, r, syscall, path);

        JS_FreeCString(ctx, path);

        return err;
    }

    JS_FreeCString(ctx, path);

    JSValue ret = JS_NewStringLen(ctx, buf, off);

    js_free(ctx, buf);

    return ret;
}

/* pathKind(path) -> 'file' | 'dir' | null
 *
 * The resolver's probe. Deliberately not fs.statSync: resolution walks a long
 * list of candidate paths that mostly do not exist, so a miss returns null
 * instead of throwing — building and unwinding an exception per candidate is
 * exactly the cost this needs to avoid. */
static JSValue t2_path_kind(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    const char *path = JS_ToCString(ctx, argv[0]);

    if (!path) {
        return JS_EXCEPTION;
    }

    uv_fs_t req;
    int r = uv_fs_stat(NULL, &req, path, NULL);
    uint64_t mode = req.statbuf.st_mode;

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    if (r != 0) {
        return JS_NULL;
    }

    if (S_ISDIR(mode)) {
        return JS_NewString(ctx, "dir");
    }

    return JS_NewString(ctx, "file");
}

/* realpathSync(path) -> string. Resolution keys require.cache, so it has to be
 * the canonical path, not whatever spelling the caller used. */
static JSValue t2_realpath_sync(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    const char *path = JS_ToCString(ctx, argv[0]);

    if (!path) {
        return JS_EXCEPTION;
    }

    uv_fs_t req;
    int r = uv_fs_realpath(NULL, &req, path, NULL);

    if (r != 0) {
        uv_fs_req_cleanup(&req);

        JSValue err = t2_throw_uv(ctx, r, "realpath", path);

        JS_FreeCString(ctx, path);

        return err;
    }

    JSValue ret = JS_NewString(ctx, req.ptr);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

/* writeSync(fd, string) -> bytes written
 *
 * process.stdout.write is synchronous in Node for files and TTYs, and era code
 * relies on that ordering. txiki's tjs.stdout is a WHATWG WritableStream whose
 * only path is an async writer, and its synchronous printer lives on the
 * internal `core` namespace — reaching into that would couple us to txiki's
 * internals, which is the thing R5 tells us not to do. */
static JSValue t2_write_sync(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    /* Strings go out as UTF-8; a Uint8Array goes out byte for byte. Routing
     * binary through a string conversion would mangle anything not valid UTF-8,
     * and process.stdout.write(buffer) is how era code emits binary. */
    size_t len;
    const char *str = NULL;
    const char *data;

    if (JS_IsString(argv[1])) {
        str = JS_ToCStringLen(ctx, &len, argv[1]);

        if (!str) {
            return JS_EXCEPTION;
        }

        data = str;
    } else {
        uint8_t *bytes = JS_GetUint8Array(ctx, &len, argv[1]);

        if (!bytes) {
            return JS_EXCEPTION;
        }

        data = (const char *) bytes;
    }

    uv_fs_t req;
    size_t off = 0;
    int r = 0;

    while (off < len) {
        uv_buf_t b = uv_buf_init((char *) data + off, len - off);
        int n = uv_fs_write(NULL, &req, fd, &b, 1, -1, NULL);

        uv_fs_req_cleanup(&req);

        if (n == UV_EAGAIN) {
            continue; /* non-blocking stdio: the fd is not ready yet */
        }

        if (n < 0) {
            r = n;
            break;
        }

        if (n == 0) {
            break;
        }

        off += n;
    }

    if (str) {
        JS_FreeCString(ctx, str);
    }

    if (r != 0) {
        return t2_throw_uv(ctx, r, "write", NULL);
    }

    return JS_NewInt64(ctx, (int64_t) off);
}

/* isTTY(fd) -> boolean, for process.stdout.isTTY. */
static JSValue t2_is_tty(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    return JS_NewBool(ctx, uv_guess_handle(fd) == UV_TTY);
}

/* runMicrotasks() -> drains the job queue to completion.
 *
 * Node drains microtasks the moment the main script returns, before any timer
 * fires. libuv runs timers *before* its prepare handler, so an already-due
 * setTimeout(0) would otherwise beat process.nextTick and promise callbacks on
 * the first turn of the loop — observable, and wrong. Draining explicitly when
 * the entry script returns restores Node's ordering.
 *
 * txiki has core.drainMicrotasks(), but only on its internal namespace; this is
 * the same few lines without the coupling. */
static JSValue t2_run_microtasks(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    JSRuntime *rt = JS_GetRuntime(ctx);

    for (;;) {
        JSContext *job_ctx;
        int err = JS_ExecutePendingJob(rt, &job_ctx);

        if (err == 0) {
            break;
        }

        if (err < 0) {
            /* Ours to propagate; anything else belongs to txiki's own loop. */
            if (job_ctx == ctx) {
                return JS_EXCEPTION;
            }

            break;
        }
    }

    return JS_UNDEFINED;
}

/* process.platform / process.arch. txiki's tjs.system reports cpus, load and
 * interfaces but not these, so they come from the compiler. Values are Node's
 * spellings, since era code switches on them. */
#if defined(__APPLE__)
#define T2_PLATFORM "darwin"
#elif defined(__linux__)
#define T2_PLATFORM "linux"
#else
#define T2_PLATFORM "unknown"
#endif

#if defined(__mips__) && defined(__MIPSEL__)
#define T2_ARCH "mipsel"
#elif defined(__mips__)
#define T2_ARCH "mips"
#elif defined(__x86_64__)
#define T2_ARCH "x64"
#elif defined(__aarch64__)
#define T2_ARCH "arm64"
#elif defined(__arm__)
#define T2_ARCH "arm"
#else
#define T2_ARCH "unknown"
#endif

/* coreModuleNames() -> string[]
 *
 * The names only. The loader needs to know what counts as a core module before
 * it touches the filesystem, and answering that must not cost a deserialization
 * of every module in the table. */
static JSValue t2_core_module_names(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    JSValue names = JS_NewArray(ctx);
    uint32_t i = 0;

    for (const t2_builtin_t *p = t2_core_modules; p->name != NULL; ++p) {
        JS_SetPropertyUint32(ctx, names, i++, JS_NewString(ctx, p->name));
    }

    return names;
}

/* loadCoreModule(name) -> CommonJS wrapper function, or null
 *
 * Deserializes one module's bytecode and evaluates it. The blob is a script
 * whose completion value is
 *
 *     (function (exports, require, module, __filename, __dirname) { ... })
 *
 * so what comes back is the wrapper, ready for the loader to call with a real
 * module object. Nothing is deserialized until this runs, which is the whole
 * point: a program that never requires node:events never pays for it. */
static JSValue t2_load_core_module(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    const char *name = JS_ToCString(ctx, argv[0]);

    if (!name) {
        return JS_EXCEPTION;
    }

    const t2_builtin_t *found = NULL;

    for (const t2_builtin_t *p = t2_core_modules; p->name != NULL; ++p) {
        if (strcmp(p->name, name) == 0) {
            found = p;
            break;
        }
    }

    JS_FreeCString(ctx, name);

    if (!found) {
        return JS_NULL;
    }

    JSValue obj = JS_ReadObject(ctx, found->data, found->size, JS_READ_OBJ_BYTECODE);

    if (JS_IsException(obj)) {
        return obj;
    }

    return JS_EvalFunction(ctx, obj);
}

void t2_register_natives(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue natives = JS_NewObjectProto(ctx, JS_NULL);

    JS_SetPropertyStr(ctx, natives, "evalScript", JS_NewCFunction(ctx, t2_eval_script, "evalScript", 2));
    JS_SetPropertyStr(ctx, natives, "readFileSync", JS_NewCFunction(ctx, t2_read_file_sync, "readFileSync", 1));
    JS_SetPropertyStr(ctx, natives, "pathKind", JS_NewCFunction(ctx, t2_path_kind, "pathKind", 1));
    JS_SetPropertyStr(ctx, natives, "realpathSync", JS_NewCFunction(ctx, t2_realpath_sync, "realpathSync", 1));
    JS_SetPropertyStr(ctx, natives, "writeSync", JS_NewCFunction(ctx, t2_write_sync, "writeSync", 2));
    JS_SetPropertyStr(ctx, natives, "isTTY", JS_NewCFunction(ctx, t2_is_tty, "isTTY", 1));
    JS_SetPropertyStr(ctx, natives, "runMicrotasks", JS_NewCFunction(ctx, t2_run_microtasks, "runMicrotasks", 0));
    JS_SetPropertyStr(ctx, natives, "coreModuleNames", JS_NewCFunction(ctx, t2_core_module_names, "coreModuleNames", 0));
    JS_SetPropertyStr(ctx, natives, "loadCoreModule", JS_NewCFunction(ctx, t2_load_core_module, "loadCoreModule", 1));
    JS_SetPropertyStr(ctx, natives, "platform", JS_NewString(ctx, T2_PLATFORM));
    JS_SetPropertyStr(ctx, natives, "arch", JS_NewString(ctx, T2_ARCH));

    t2_register_fs(ctx, natives);
    t2_register_constants(ctx, natives);
    t2_register_net(ctx, natives);

    JS_SetPropertyStr(ctx, global, "__t2native", natives);

    JS_FreeValue(ctx, global);
}
