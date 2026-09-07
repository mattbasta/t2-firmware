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
static JSValue t2_throw_uv(JSContext *ctx, int r, const char *syscall, const char *path) {
    char message[PATH_MAX + 128];

    if (path) {
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

    return JS_Throw(ctx, err);
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

void t2_register_natives(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue natives = JS_NewObjectProto(ctx, JS_NULL);

    JS_SetPropertyStr(ctx, natives, "evalScript", JS_NewCFunction(ctx, t2_eval_script, "evalScript", 2));
    JS_SetPropertyStr(ctx, natives, "readFileSync", JS_NewCFunction(ctx, t2_read_file_sync, "readFileSync", 1));
    JS_SetPropertyStr(ctx, natives, "pathKind", JS_NewCFunction(ctx, t2_path_kind, "pathKind", 1));
    JS_SetPropertyStr(ctx, natives, "realpathSync", JS_NewCFunction(ctx, t2_realpath_sync, "realpathSync", 1));

    JS_SetPropertyStr(ctx, global, "__t2native", natives);

    JS_FreeValue(ctx, global);
}
