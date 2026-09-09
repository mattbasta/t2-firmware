/*
 * Tessel 2 runtime — filesystem primitives.
 *
 * The bindings under node:fs. One table serves both halves of Node's fs: every
 * uv_fs_* call runs synchronously when handed no callback and on the threadpool
 * when handed one, which is the same switch Node itself is built on, and it is
 * why there is one function per operation here rather than two. See
 * runtime/docs/phase2-plan.md §2.
 *
 * Nothing here is a Node API. These are the thin, uniform primitives that
 * runtime/js/node/fs.js builds fs.readFileSync, fs.read and fs.promises.read
 * out of — argument coercion, flag parsing, Stats objects and the error
 * conventions all live in JS, where they are cheaper to get right.
 *
 * SPDX-License-Identifier: MIT
 */

#include "t2.h"
#include "tjs.h"

#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <uv.h>

/* --- asynchronous requests ------------------------------------------------
 *
 * Every operation below takes an optional trailing callback. With one it runs
 * on libuv's threadpool and reports through the callback; without one it runs
 * inline and throws. The dispatch is the presence of a function, and the result
 * shape comes from req->fs_type, which libuv records for us.
 */

typedef struct {
    uv_fs_t req;
    JSContext *ctx;
    JSValue callback;
    /* Kept alive for the duration of a read/write: the buffer is written to by
     * the threadpool, so it must not be collected while the request is live. */
    JSValue buffer;
    int with_types;
} t2_fs_req_t;

static uv_loop_t *t2_fs_loop(JSContext *ctx) {
    /* TJS_GetLoop is public as of fork patch 0004; before it, an embedder had
     * no way to reach the loop its own runtime runs on. */
    return TJS_GetLoop(TJS_GetRuntime(ctx));
}

/* libuv records the operation on the request; Node's error messages name it. */
static const char *t2_fs_syscall(uv_fs_type type) {
    switch (type) {
        case UV_FS_OPEN: return "open";
        case UV_FS_CLOSE: return "close";
        case UV_FS_READ: return "read";
        case UV_FS_WRITE: return "write";
        case UV_FS_STAT: return "stat";
        case UV_FS_LSTAT: return "lstat";
        case UV_FS_FSTAT: return "fstat";
        case UV_FS_SCANDIR: return "scandir";
        case UV_FS_UNLINK: return "unlink";
        case UV_FS_RMDIR: return "rmdir";
        case UV_FS_MKDIR: return "mkdir";
        case UV_FS_MKDTEMP: return "mkdtemp";
        case UV_FS_ACCESS: return "access";
        case UV_FS_CHMOD: return "chmod";
        case UV_FS_READLINK: return "readlink";
        case UV_FS_RENAME: return "rename";
        case UV_FS_LINK: return "link";
        case UV_FS_SYMLINK: return "symlink";
        case UV_FS_COPYFILE: return "copyfile";
        case UV_FS_FTRUNCATE: return "ftruncate";
        case UV_FS_FSYNC: return "fsync";
        case UV_FS_FDATASYNC: return "fdatasync";
        case UV_FS_UTIME: return "utime";
        default: return "fs";
    }
}

static JSValue t2_stat_object(JSContext *ctx, const uv_stat_t *st);
static JSValue t2_dirent_array(JSContext *ctx, uv_fs_t *req, int with_types);

static void t2_fs_async_cb(uv_fs_t *req) {
    t2_fs_req_t *fr = (t2_fs_req_t *) req;
    JSContext *ctx = fr->ctx;

    /* Node's callbacks are (err, result), except read/write, which are
     * (err, bytesTransferred, buffer). */
    JSValue args[3];
    int nargs = 2;

    if (req->result < 0) {
        args[0] = t2_new_uv_error(ctx, (int) req->result, t2_fs_syscall(req->fs_type), req->path, NULL);
        args[1] = JS_UNDEFINED;
    } else {
        args[0] = JS_NULL;

        switch (req->fs_type) {
            case UV_FS_OPEN:
                args[1] = JS_NewInt32(ctx, (int32_t) req->result);
                break;

            case UV_FS_READ:
            case UV_FS_WRITE:
                args[1] = JS_NewInt64(ctx, (int64_t) req->result);
                args[2] = JS_DupValue(ctx, fr->buffer);
                nargs = 3;
                break;

            case UV_FS_STAT:
            case UV_FS_LSTAT:
            case UV_FS_FSTAT:
                args[1] = t2_stat_object(ctx, &req->statbuf);
                break;

            case UV_FS_SCANDIR:
                args[1] = t2_dirent_array(ctx, req, fr->with_types);
                break;

            case UV_FS_READLINK:
                args[1] = JS_NewString(ctx, req->ptr);
                break;

            case UV_FS_MKDTEMP:
                args[1] = JS_NewString(ctx, req->path);
                break;

            default:
                args[1] = JS_UNDEFINED;
                break;
        }
    }

    JSValue ret = JS_Call(ctx, fr->callback, JS_UNDEFINED, nargs, args);

    /* fs.js wraps every callback it hands us, so a throw here means the wrapper
     * itself failed. Nothing can be done from inside a loop callback except say
     * so rather than swallow it. */
    if (JS_IsException(ret)) {
        t2_report_exception(ctx, "an fs callback");
    }

    JS_FreeValue(ctx, ret);

    for (int i = 0; i < nargs; i++) {
        JS_FreeValue(ctx, args[i]);
    }

    JS_FreeValue(ctx, fr->callback);
    JS_FreeValue(ctx, fr->buffer);

    uv_fs_req_cleanup(req);
    js_free(ctx, fr);
}

/* Returns a live request when `cb` is a function, and NULL to mean "run this
 * one synchronously". The uv_fs_t is the first member, so the request and the
 * uv handle are one allocation. */
static t2_fs_req_t *t2_fs_async_begin(JSContext *ctx, JSValue cb, JSValue keep, int with_types) {
    if (!JS_IsFunction(ctx, cb)) {
        return NULL;
    }

    t2_fs_req_t *fr = js_mallocz(ctx, sizeof(*fr));

    if (!fr) {
        return NULL;
    }

    fr->ctx = ctx;
    fr->callback = JS_DupValue(ctx, cb);
    fr->buffer = JS_DupValue(ctx, keep);
    fr->with_types = with_types;

    return fr;
}

/* A negative return from an *async* uv_fs_* call means the request never
 * started — out of memory, essentially. Real I/O failures arrive at the
 * callback instead, so this throws rather than reporting. */
static JSValue t2_fs_async_end(JSContext *ctx, t2_fs_req_t *fr, int r, const char *syscall) {
    if (r < 0) {
        JS_FreeValue(ctx, fr->callback);
        JS_FreeValue(ctx, fr->buffer);
        uv_fs_req_cleanup(&fr->req);
        js_free(ctx, fr);

        return t2_throw_uv(ctx, r, syscall, NULL);
    }

    return JS_UNDEFINED;
}

/* Paths arrive from JS as strings and have to be freed on every exit path.
 * These two keep that from being written out twenty times over. */
#define T2_FS_BEGIN_PATH(argn)                     \
    const char *path = JS_ToCString(ctx, argv[argn]); \
    if (!path) {                                   \
        return JS_EXCEPTION;                       \
    }                                              \
    uv_fs_t req

#define T2_FS_END_PATH(r, syscall)                             \
    do {                                                       \
        if ((r) < 0) {                                         \
            uv_fs_req_cleanup(&req);                           \
            JSValue err = t2_throw_uv(ctx, (r), (syscall), path); \
            JS_FreeCString(ctx, path);                         \
            return err;                                        \
        }                                                      \
    } while (0)

/* --- stat ---------------------------------------------------------------- */

static double t2_timespec_ms(uv_timespec_t ts) {
    return (double) ts.tv_sec * 1000.0 + (double) ts.tv_nsec / 1000000.0;
}

/* A plain object with Node's Stats field names. The class itself — the is*()
 * predicates, the Date mirrors of the *Ms fields — is built in JS: it is pure
 * shaping, and doing it here would mean constructing Dates from C on every
 * stat() the module loader performs. */
static JSValue t2_stat_object(JSContext *ctx, const uv_stat_t *st) {
    JSValue obj = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, obj, "dev", JS_NewFloat64(ctx, (double) st->st_dev));
    JS_SetPropertyStr(ctx, obj, "mode", JS_NewFloat64(ctx, (double) st->st_mode));
    JS_SetPropertyStr(ctx, obj, "nlink", JS_NewFloat64(ctx, (double) st->st_nlink));
    JS_SetPropertyStr(ctx, obj, "uid", JS_NewFloat64(ctx, (double) st->st_uid));
    JS_SetPropertyStr(ctx, obj, "gid", JS_NewFloat64(ctx, (double) st->st_gid));
    JS_SetPropertyStr(ctx, obj, "rdev", JS_NewFloat64(ctx, (double) st->st_rdev));
    JS_SetPropertyStr(ctx, obj, "blksize", JS_NewFloat64(ctx, (double) st->st_blksize));
    JS_SetPropertyStr(ctx, obj, "ino", JS_NewFloat64(ctx, (double) st->st_ino));
    JS_SetPropertyStr(ctx, obj, "size", JS_NewFloat64(ctx, (double) st->st_size));
    JS_SetPropertyStr(ctx, obj, "blocks", JS_NewFloat64(ctx, (double) st->st_blocks));
    JS_SetPropertyStr(ctx, obj, "atimeMs", JS_NewFloat64(ctx, t2_timespec_ms(st->st_atim)));
    JS_SetPropertyStr(ctx, obj, "mtimeMs", JS_NewFloat64(ctx, t2_timespec_ms(st->st_mtim)));
    JS_SetPropertyStr(ctx, obj, "ctimeMs", JS_NewFloat64(ctx, t2_timespec_ms(st->st_ctim)));
    JS_SetPropertyStr(ctx, obj, "birthtimeMs", JS_NewFloat64(ctx, t2_timespec_ms(st->st_birthtim)));

    return obj;
}

static JSValue t2_fs_stat(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_stat(t2_fs_loop(ctx), &fr->req, path, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "stat");
    }

    int r = uv_fs_stat(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "stat");

    JSValue ret = t2_stat_object(ctx, &req.statbuf);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

static JSValue t2_fs_lstat(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_lstat(t2_fs_loop(ctx), &fr->req, path, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "lstat");
    }

    int r = uv_fs_lstat(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "lstat");

    JSValue ret = t2_stat_object(ctx, &req.statbuf);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

static JSValue t2_fs_fstat(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_fstat(t2_fs_loop(ctx), &fr->req, fd, t2_fs_async_cb);

        return t2_fs_async_end(ctx, fr, ar, "fstat");
    }

    uv_fs_t req;
    int r = uv_fs_fstat(NULL, &req, fd, NULL);

    if (r < 0) {
        uv_fs_req_cleanup(&req);
        return t2_throw_uv(ctx, r, "fstat", NULL);
    }

    JSValue ret = t2_stat_object(ctx, &req.statbuf);

    uv_fs_req_cleanup(&req);

    return ret;
}

/* --- open / close / read / write ------------------------------------------ */

static JSValue t2_fs_open(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t flags, mode;

    T2_FS_BEGIN_PATH(0);

    if (JS_ToInt32(ctx, &flags, argv[1]) || JS_ToInt32(ctx, &mode, argv[2])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[3], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_open(t2_fs_loop(ctx), &fr->req, path, flags, mode, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "open");
    }

    int r = uv_fs_open(NULL, &req, path, flags, mode, NULL);

    T2_FS_END_PATH(r, "open");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_NewInt32(ctx, r);
}

static JSValue t2_fs_close(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_close(t2_fs_loop(ctx), &fr->req, fd, t2_fs_async_cb);

        return t2_fs_async_end(ctx, fr, ar, "close");
    }

    uv_fs_t req;
    int r = uv_fs_close(NULL, &req, fd, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0) {
        return t2_throw_uv(ctx, r, "close", NULL);
    }

    return JS_UNDEFINED;
}

/* read(fd, buffer, offset, length, position) -> bytesRead
 *
 * position < 0 means "wherever the descriptor is", which is how Node spells
 * null. The buffer is written in place, as Node's is. */
static JSValue t2_fs_read(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;
    int64_t offset, length, position;
    size_t buf_len;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    uint8_t *bytes = JS_GetUint8Array(ctx, &buf_len, argv[1]);

    if (!bytes) {
        return JS_EXCEPTION;
    }

    if (JS_ToInt64(ctx, &offset, argv[2]) || JS_ToInt64(ctx, &length, argv[3]) ||
        JS_ToInt64(ctx, &position, argv[4])) {
        return JS_EXCEPTION;
    }

    if (offset < 0 || length < 0 || (uint64_t) (offset + length) > buf_len) {
        return JS_ThrowRangeError(ctx, "offset/length out of range for the given buffer");
    }

    uv_buf_t b = uv_buf_init((char *) bytes + offset, (unsigned int) length);

    /* The buffer is handed to the threadpool, so the request holds a reference
     * to it until completion — otherwise a collection during the read would
     * leave libuv writing into freed memory. */
    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[5], argv[1], 0);

    if (fr) {
        int ar = uv_fs_read(t2_fs_loop(ctx), &fr->req, fd, &b, 1, position, t2_fs_async_cb);

        return t2_fs_async_end(ctx, fr, ar, "read");
    }

    uv_fs_t req;
    int r = uv_fs_read(NULL, &req, fd, &b, 1, position, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0) {
        return t2_throw_uv(ctx, r, "read", NULL);
    }

    return JS_NewInt64(ctx, r);
}

/* write(fd, buffer, offset, length, position) -> bytesWritten
 *
 * Bytes only. Node also accepts a string here; fs.js encodes it first, so the
 * encoding table stays in one place rather than being split across the boundary. */
static JSValue t2_fs_write(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;
    int64_t offset, length, position;
    size_t buf_len;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    uint8_t *bytes = JS_GetUint8Array(ctx, &buf_len, argv[1]);

    if (!bytes) {
        return JS_EXCEPTION;
    }

    if (JS_ToInt64(ctx, &offset, argv[2]) || JS_ToInt64(ctx, &length, argv[3]) ||
        JS_ToInt64(ctx, &position, argv[4])) {
        return JS_EXCEPTION;
    }

    if (offset < 0 || length < 0 || (uint64_t) (offset + length) > buf_len) {
        return JS_ThrowRangeError(ctx, "offset/length out of range for the given buffer");
    }

    uv_buf_t b = uv_buf_init((char *) bytes + offset, (unsigned int) length);

    /* The buffer is handed to the threadpool, so the request holds a reference
     * to it until completion — otherwise a collection during the read would
     * leave libuv writing into freed memory. */
    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[5], argv[1], 0);

    if (fr) {
        int ar = uv_fs_write(t2_fs_loop(ctx), &fr->req, fd, &b, 1, position, t2_fs_async_cb);

        return t2_fs_async_end(ctx, fr, ar, "write");
    }

    uv_fs_t req;
    int r = uv_fs_write(NULL, &req, fd, &b, 1, position, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0) {
        return t2_throw_uv(ctx, r, "write", NULL);
    }

    return JS_NewInt64(ctx, r);
}

/* --- directory entries ---------------------------------------------------- */

/* readdir(path, withTypes) -> [name, ...] | [{ name, type }, ...]
 *
 * One scandir either way. The type comes back from the same syscall that
 * produced the name, so withFileTypes costs nothing extra — which is the point:
 * Node's alternative is a stat() per entry. */
static JSValue t2_dirent_array(JSContext *ctx, uv_fs_t *req, int with_types) {
    JSValue arr = JS_NewArray(ctx);
    uv_dirent_t ent;
    uint32_t i = 0;

    while (uv_fs_scandir_next(req, &ent) != UV_EOF) {
        JSValue item;

        if (with_types) {
            item = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, item, "name", JS_NewString(ctx, ent.name));
            JS_SetPropertyStr(ctx, item, "type", JS_NewInt32(ctx, ent.type));
        } else {
            item = JS_NewString(ctx, ent.name);
        }

        JS_SetPropertyUint32(ctx, arr, i++, item);
    }

    return arr;
}

static JSValue t2_fs_readdir(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    int with_types = JS_ToBool(ctx, argv[1]);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[2], JS_UNDEFINED, with_types);

    if (fr) {
        int ar = uv_fs_scandir(t2_fs_loop(ctx), &fr->req, path, 0, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "scandir");
    }

    int r = uv_fs_scandir(NULL, &req, path, 0, NULL);

    T2_FS_END_PATH(r, "scandir");

    JSValue arr = t2_dirent_array(ctx, &req, with_types);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return arr;
}

/* --- path operations ------------------------------------------------------ */

static JSValue t2_fs_unlink(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_unlink(t2_fs_loop(ctx), &fr->req, path, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "unlink");
    }

    int r = uv_fs_unlink(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "unlink");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

static JSValue t2_fs_rmdir(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_rmdir(t2_fs_loop(ctx), &fr->req, path, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "rmdir");
    }

    int r = uv_fs_rmdir(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "rmdir");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

static JSValue t2_fs_mkdir(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t mode;

    T2_FS_BEGIN_PATH(0);

    if (JS_ToInt32(ctx, &mode, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[2], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_mkdir(t2_fs_loop(ctx), &fr->req, path, mode, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "mkdir");
    }

    int r = uv_fs_mkdir(NULL, &req, path, mode, NULL);

    T2_FS_END_PATH(r, "mkdir");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

/* access(path, mode, shouldThrow) -> boolean
 *
 * Two callers with opposite needs, one syscall. fs.existsSync asks about paths
 * that are expected not to exist and must not pay for an exception, like
 * pathKind; fs.accessSync must throw, and with the *real* code — EACCES and
 * ENOENT are different answers and era code tells them apart. So the flag picks
 * the behavior and the error is still built where uv_strerror lives. */
static JSValue t2_fs_access(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t mode;

    T2_FS_BEGIN_PATH(0);

    if (JS_ToInt32(ctx, &mode, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    /* Asynchronously there is no "return false" option: fs.access reports
     * through its callback, so the shouldThrow flag is a synchronous concern. */
    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[3], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_access(t2_fs_loop(ctx), &fr->req, path, mode, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "access");
    }

    int r = uv_fs_access(NULL, &req, path, mode, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0 && JS_ToBool(ctx, argv[2])) {
        JSValue err = t2_throw_uv(ctx, r, "access", path);

        JS_FreeCString(ctx, path);

        return err;
    }

    JS_FreeCString(ctx, path);

    return JS_NewBool(ctx, r == 0);
}

static JSValue t2_fs_chmod(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t mode;

    T2_FS_BEGIN_PATH(0);

    if (JS_ToInt32(ctx, &mode, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[2], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_chmod(t2_fs_loop(ctx), &fr->req, path, mode, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "chmod");
    }

    int r = uv_fs_chmod(NULL, &req, path, mode, NULL);

    T2_FS_END_PATH(r, "chmod");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

static JSValue t2_fs_readlink(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_readlink(t2_fs_loop(ctx), &fr->req, path, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "readlink");
    }

    int r = uv_fs_readlink(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "readlink");

    JSValue ret = JS_NewString(ctx, req.ptr);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

static JSValue t2_fs_mkdtemp(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[1], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_mkdtemp(t2_fs_loop(ctx), &fr->req, path, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "mkdtemp");
    }

    int r = uv_fs_mkdtemp(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "mkdtemp");

    JSValue ret = JS_NewString(ctx, req.path);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

/* --- two-path operations -------------------------------------------------- */

/* rename, link, symlink and copyfile all take a source and a destination, and
 * Node names both in the error: "ENOENT: ..., rename '/a' -> '/b'". */
typedef int (*t2_two_path_fn)(uv_loop_t *loop, uv_fs_t *req, const char *a, const char *b, int flags, uv_fs_cb cb);

static int t2_call_rename(uv_loop_t *loop, uv_fs_t *req, const char *a, const char *b, int flags, uv_fs_cb cb) {
    (void) flags;
    return uv_fs_rename(loop, req, a, b, cb);
}

static int t2_call_link(uv_loop_t *loop, uv_fs_t *req, const char *a, const char *b, int flags, uv_fs_cb cb) {
    (void) flags;
    return uv_fs_link(loop, req, a, b, cb);
}

static int t2_call_symlink(uv_loop_t *loop, uv_fs_t *req, const char *a, const char *b, int flags, uv_fs_cb cb) {
    return uv_fs_symlink(loop, req, a, b, flags, cb);
}

static int t2_call_copyfile(uv_loop_t *loop, uv_fs_t *req, const char *a, const char *b, int flags, uv_fs_cb cb) {
    return uv_fs_copyfile(loop, req, a, b, flags, cb);
}

static JSValue t2_two_path(JSContext *ctx, JSValue *argv, t2_two_path_fn fn, const char *syscall) {
    const char *a = JS_ToCString(ctx, argv[0]);

    if (!a) {
        return JS_EXCEPTION;
    }

    const char *b = JS_ToCString(ctx, argv[1]);

    if (!b) {
        JS_FreeCString(ctx, a);
        return JS_EXCEPTION;
    }

    int32_t flags = 0;

    if (JS_ToInt32(ctx, &flags, argv[2])) {
        JS_FreeCString(ctx, a);
        JS_FreeCString(ctx, b);
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[3], JS_UNDEFINED, 0);

    if (fr) {
        int ar = fn(t2_fs_loop(ctx), &fr->req, a, b, flags, t2_fs_async_cb);

        JS_FreeCString(ctx, a);
        JS_FreeCString(ctx, b);

        return t2_fs_async_end(ctx, fr, ar, syscall);
    }

    uv_fs_t req;
    int r = fn(NULL, &req, a, b, flags, NULL);

    uv_fs_req_cleanup(&req);

    JSValue ret = JS_UNDEFINED;

    if (r < 0) {
        ret = t2_throw_uv2(ctx, r, syscall, a, b);
    }

    JS_FreeCString(ctx, a);
    JS_FreeCString(ctx, b);

    return ret;
}

static JSValue t2_fs_rename(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    return t2_two_path(ctx, argv, t2_call_rename, "rename");
}

static JSValue t2_fs_link(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    return t2_two_path(ctx, argv, t2_call_link, "link");
}

static JSValue t2_fs_symlink(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    return t2_two_path(ctx, argv, t2_call_symlink, "symlink");
}

static JSValue t2_fs_copyfile(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    return t2_two_path(ctx, argv, t2_call_copyfile, "copyfile");
}

/* --- descriptor operations ------------------------------------------------ */

static JSValue t2_fs_ftruncate(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;
    int64_t len;

    if (JS_ToInt32(ctx, &fd, argv[0]) || JS_ToInt64(ctx, &len, argv[1])) {
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[2], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_ftruncate(t2_fs_loop(ctx), &fr->req, fd, len, t2_fs_async_cb);

        return t2_fs_async_end(ctx, fr, ar, "ftruncate");
    }

    uv_fs_t req;
    int r = uv_fs_ftruncate(NULL, &req, fd, len, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0) {
        return t2_throw_uv(ctx, r, "ftruncate", NULL);
    }

    return JS_UNDEFINED;
}

static JSValue t2_fs_fsync(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    int32_t fd;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    int datasync = JS_ToBool(ctx, argv[1]);

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[2], JS_UNDEFINED, 0);

    if (fr) {
        uv_loop_t *loop = t2_fs_loop(ctx);
        int ar = datasync ? uv_fs_fdatasync(loop, &fr->req, fd, t2_fs_async_cb)
                          : uv_fs_fsync(loop, &fr->req, fd, t2_fs_async_cb);

        return t2_fs_async_end(ctx, fr, ar, datasync ? "fdatasync" : "fsync");
    }

    uv_fs_t req;
    int r = datasync ? uv_fs_fdatasync(NULL, &req, fd, NULL) : uv_fs_fsync(NULL, &req, fd, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0) {
        return t2_throw_uv(ctx, r, datasync ? "fdatasync" : "fsync", NULL);
    }

    return JS_UNDEFINED;
}

static JSValue t2_fs_utime(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    double atime, mtime;

    T2_FS_BEGIN_PATH(0);

    if (JS_ToFloat64(ctx, &atime, argv[1]) || JS_ToFloat64(ctx, &mtime, argv[2])) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    t2_fs_req_t *fr = t2_fs_async_begin(ctx, argv[3], JS_UNDEFINED, 0);

    if (fr) {
        int ar = uv_fs_utime(t2_fs_loop(ctx), &fr->req, path, atime, mtime, t2_fs_async_cb);

        JS_FreeCString(ctx, path);

        return t2_fs_async_end(ctx, fr, ar, "utime");
    }

    int r = uv_fs_utime(NULL, &req, path, atime, mtime, NULL);

    T2_FS_END_PATH(r, "utime");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

/* --- constants ------------------------------------------------------------ */

/* fs.constants. libuv's UV_FS_O_* are the portable spellings of the open flags;
 * the S_IF* and *_OK values come from the platform headers. Exposed from C
 * because their numeric values are not knowable in JS. */
static JSValue t2_fs_constants(JSContext *ctx) {
    JSValue c = JS_NewObject(ctx);

#define T2_CONST(name, value) JS_SetPropertyStr(ctx, c, name, JS_NewInt32(ctx, (int32_t) (value)))

    T2_CONST("O_RDONLY", UV_FS_O_RDONLY);
    T2_CONST("O_WRONLY", UV_FS_O_WRONLY);
    T2_CONST("O_RDWR", UV_FS_O_RDWR);
    T2_CONST("O_CREAT", UV_FS_O_CREAT);
    T2_CONST("O_EXCL", UV_FS_O_EXCL);
    T2_CONST("O_TRUNC", UV_FS_O_TRUNC);
    T2_CONST("O_APPEND", UV_FS_O_APPEND);
    T2_CONST("O_SYNC", UV_FS_O_SYNC);
    T2_CONST("O_DSYNC", UV_FS_O_DSYNC);
    T2_CONST("O_DIRECTORY", UV_FS_O_DIRECTORY);
    T2_CONST("O_NOFOLLOW", UV_FS_O_NOFOLLOW);
    T2_CONST("O_NONBLOCK", UV_FS_O_NONBLOCK);

    T2_CONST("F_OK", F_OK);
    T2_CONST("R_OK", R_OK);
    T2_CONST("W_OK", W_OK);
    T2_CONST("X_OK", X_OK);

    T2_CONST("S_IFMT", S_IFMT);
    T2_CONST("S_IFREG", S_IFREG);
    T2_CONST("S_IFDIR", S_IFDIR);
    T2_CONST("S_IFCHR", S_IFCHR);
    T2_CONST("S_IFBLK", S_IFBLK);
    T2_CONST("S_IFIFO", S_IFIFO);
    T2_CONST("S_IFLNK", S_IFLNK);
    T2_CONST("S_IFSOCK", S_IFSOCK);

    T2_CONST("COPYFILE_EXCL", UV_FS_COPYFILE_EXCL);
    T2_CONST("COPYFILE_FICLONE", UV_FS_COPYFILE_FICLONE);

    /* uv_dirent_t types, for readdir(withTypes). */
    T2_CONST("UV_DIRENT_UNKNOWN", UV_DIRENT_UNKNOWN);
    T2_CONST("UV_DIRENT_FILE", UV_DIRENT_FILE);
    T2_CONST("UV_DIRENT_DIR", UV_DIRENT_DIR);
    T2_CONST("UV_DIRENT_LINK", UV_DIRENT_LINK);
    T2_CONST("UV_DIRENT_FIFO", UV_DIRENT_FIFO);
    T2_CONST("UV_DIRENT_SOCKET", UV_DIRENT_SOCKET);
    T2_CONST("UV_DIRENT_CHAR", UV_DIRENT_CHAR);
    T2_CONST("UV_DIRENT_BLOCK", UV_DIRENT_BLOCK);

#undef T2_CONST

    return c;
}

void t2_register_fs(JSContext *ctx, JSValue natives) {
    JSValue fs = JS_NewObjectProto(ctx, JS_NULL);

/* The declared arity includes the trailing callback slot. QuickJS pads argv to
 * the declared length with undefined, so a synchronous call still finds a
 * readable (non-function) value where the callback would be. */
#define T2_FN(name, fn, arity) \
    JS_SetPropertyStr(ctx, fs, name, JS_NewCFunction(ctx, fn, name, arity))

    T2_FN("open", t2_fs_open, 4);
    T2_FN("close", t2_fs_close, 2);
    T2_FN("read", t2_fs_read, 6);
    T2_FN("write", t2_fs_write, 6);
    T2_FN("stat", t2_fs_stat, 2);
    T2_FN("lstat", t2_fs_lstat, 2);
    T2_FN("fstat", t2_fs_fstat, 2);
    T2_FN("readdir", t2_fs_readdir, 3);
    T2_FN("unlink", t2_fs_unlink, 2);
    T2_FN("rmdir", t2_fs_rmdir, 2);
    T2_FN("mkdir", t2_fs_mkdir, 3);
    T2_FN("access", t2_fs_access, 4);
    T2_FN("chmod", t2_fs_chmod, 3);
    T2_FN("readlink", t2_fs_readlink, 2);
    T2_FN("mkdtemp", t2_fs_mkdtemp, 2);
    T2_FN("rename", t2_fs_rename, 4);
    T2_FN("link", t2_fs_link, 4);
    T2_FN("symlink", t2_fs_symlink, 4);
    T2_FN("copyfile", t2_fs_copyfile, 4);
    T2_FN("ftruncate", t2_fs_ftruncate, 3);
    T2_FN("fsync", t2_fs_fsync, 3);
    T2_FN("utime", t2_fs_utime, 4);

#undef T2_FN

    JS_SetPropertyStr(ctx, fs, "constants", t2_fs_constants(ctx));

    JS_SetPropertyStr(ctx, natives, "fs", fs);
}
