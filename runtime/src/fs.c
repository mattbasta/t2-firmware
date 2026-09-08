/*
 * Tessel 2 runtime — filesystem primitives.
 *
 * The bindings under node:fs. One table serves both halves of Node's fs: every
 * uv_fs_* call runs synchronously when handed no callback and on the threadpool
 * when handed one, which is the same switch Node itself is built on. This file
 * is the synchronous half; see runtime/docs/phase2-plan.md §2.
 *
 * Nothing here is a Node API. These are the thin, uniform primitives that
 * runtime/js/node/fs.js builds fs.readFileSync, fs.read and fs.promises.read
 * out of — argument coercion, flag parsing, Stats objects and the error
 * conventions all live in JS, where they are cheaper to get right.
 *
 * SPDX-License-Identifier: MIT
 */

#include "t2.h"

#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <uv.h>

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

    int r = uv_fs_stat(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "stat");

    JSValue ret = t2_stat_object(ctx, &req.statbuf);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

static JSValue t2_fs_lstat(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

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

    uv_fs_t req;
    uv_buf_t b = uv_buf_init((char *) bytes + offset, (unsigned int) length);
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

    uv_fs_t req;
    uv_buf_t b = uv_buf_init((char *) bytes + offset, (unsigned int) length);
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
static JSValue t2_fs_readdir(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    int with_types = JS_ToBool(ctx, argv[1]);
    int r = uv_fs_scandir(NULL, &req, path, 0, NULL);

    T2_FS_END_PATH(r, "scandir");

    JSValue arr = JS_NewArray(ctx);
    uv_dirent_t ent;
    uint32_t i = 0;

    while (uv_fs_scandir_next(&req, &ent) != UV_EOF) {
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

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return arr;
}

/* --- path operations ------------------------------------------------------ */

static JSValue t2_fs_unlink(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    int r = uv_fs_unlink(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "unlink");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

static JSValue t2_fs_rmdir(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

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

    int r = uv_fs_chmod(NULL, &req, path, mode, NULL);

    T2_FS_END_PATH(r, "chmod");

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return JS_UNDEFINED;
}

static JSValue t2_fs_readlink(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

    int r = uv_fs_readlink(NULL, &req, path, NULL);

    T2_FS_END_PATH(r, "readlink");

    JSValue ret = JS_NewString(ctx, req.ptr);

    uv_fs_req_cleanup(&req);
    JS_FreeCString(ctx, path);

    return ret;
}

static JSValue t2_fs_mkdtemp(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    T2_FS_BEGIN_PATH(0);

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
typedef int (*t2_two_path_fn)(uv_fs_t *req, const char *a, const char *b, int flags);

static int t2_call_rename(uv_fs_t *req, const char *a, const char *b, int flags) {
    (void) flags;
    return uv_fs_rename(NULL, req, a, b, NULL);
}

static int t2_call_link(uv_fs_t *req, const char *a, const char *b, int flags) {
    (void) flags;
    return uv_fs_link(NULL, req, a, b, NULL);
}

static int t2_call_symlink(uv_fs_t *req, const char *a, const char *b, int flags) {
    return uv_fs_symlink(NULL, req, a, b, flags, NULL);
}

static int t2_call_copyfile(uv_fs_t *req, const char *a, const char *b, int flags) {
    return uv_fs_copyfile(NULL, req, a, b, flags, NULL);
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

    uv_fs_t req;
    int r = fn(&req, a, b, flags);

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

    uv_fs_t req;
    int r = JS_ToBool(ctx, argv[1]) ? uv_fs_fdatasync(NULL, &req, fd, NULL)
                                    : uv_fs_fsync(NULL, &req, fd, NULL);

    uv_fs_req_cleanup(&req);

    if (r < 0) {
        return t2_throw_uv(ctx, r, "fsync", NULL);
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

#define T2_FN(name, fn, arity) \
    JS_SetPropertyStr(ctx, fs, name, JS_NewCFunction(ctx, fn, name, arity))

    T2_FN("open", t2_fs_open, 3);
    T2_FN("close", t2_fs_close, 1);
    T2_FN("read", t2_fs_read, 5);
    T2_FN("write", t2_fs_write, 5);
    T2_FN("stat", t2_fs_stat, 1);
    T2_FN("lstat", t2_fs_lstat, 1);
    T2_FN("fstat", t2_fs_fstat, 1);
    T2_FN("readdir", t2_fs_readdir, 2);
    T2_FN("unlink", t2_fs_unlink, 1);
    T2_FN("rmdir", t2_fs_rmdir, 1);
    T2_FN("mkdir", t2_fs_mkdir, 2);
    T2_FN("access", t2_fs_access, 3);
    T2_FN("chmod", t2_fs_chmod, 2);
    T2_FN("readlink", t2_fs_readlink, 1);
    T2_FN("mkdtemp", t2_fs_mkdtemp, 1);
    T2_FN("rename", t2_fs_rename, 3);
    T2_FN("link", t2_fs_link, 3);
    T2_FN("symlink", t2_fs_symlink, 3);
    T2_FN("copyfile", t2_fs_copyfile, 3);
    T2_FN("ftruncate", t2_fs_ftruncate, 2);
    T2_FN("fsync", t2_fs_fsync, 2);
    T2_FN("utime", t2_fs_utime, 3);

#undef T2_FN

    JS_SetPropertyStr(ctx, fs, "constants", t2_fs_constants(ctx));

    JS_SetPropertyStr(ctx, natives, "fs", fs);
}
