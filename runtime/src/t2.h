/*
 * Tessel 2 runtime — first-party declarations.
 *
 * SPDX-License-Identifier: MIT
 */

#ifndef T2_H
#define T2_H

#include <quickjs.h>

/* Installs the native primitives the JS bootstrap needs, as a null-prototype
 * object at globalThis.__t2native. The bootstrap captures it and deletes the
 * global, so user code never sees it. */
void t2_register_natives(JSContext *ctx);

/* The filesystem primitives, under __t2native.fs. Split out of natives.c
 * because there are twenty-odd of them; see runtime/src/fs.c. */
void t2_register_fs(JSContext *ctx, JSValue natives);

/* The platform constant table (errno, signals, open flags, file modes), read
 * from the target's own headers. Backs the legacy `constants` core module and,
 * later, os.constants. t2_fill_constants writes into an existing object so the
 * same table can be reused under a different name. See runtime/src/constants.c. */
void t2_fill_constants(JSContext *ctx, JSValue obj);
void t2_register_constants(JSContext *ctx, JSValue natives);

/* The libuv stream handles behind node:net — pipes and TCP, plus name
 * resolution. See runtime/src/net.c. */
void t2_register_net(JSContext *ctx, JSValue natives);

/* Reports an exception that escaped a callback invoked from inside a libuv
 * callback, where there is nowhere to throw it. */
void t2_report_exception(JSContext *ctx, const char *where);

/* Throws a Node-shaped error for a libuv status: `code`, `errno`, `syscall`,
 * `path`, and Node's own message text, which era code prints as often as it
 * branches on it. The two-path form is for rename/link/symlink/copyfile, whose
 * messages name both ends ("... rename '/a' -> '/b'") and which carry `dest`
 * alongside `path`. */
JSValue t2_throw_uv(JSContext *ctx, int r, const char *syscall, const char *path);
JSValue t2_throw_uv2(JSContext *ctx, int r, const char *syscall, const char *path, const char *dest);

/* The same error as a value rather than a throw: an asynchronous completion
 * hands it to a callback instead of raising it. */
JSValue t2_new_uv_error(JSContext *ctx, int r, const char *syscall, const char *path, const char *dest);

/* One core module, precompiled to QuickJS bytecode. Each entry's bytecode is a
 * *script* whose completion value is the CommonJS wrapper function, so it can be
 * read and called only when something actually requires that module — the
 * kernel bundle is eager, the standard library is not. Generated into
 * runtime/src/bundles/core_modules.c by runtime/scripts/build-js.sh. */
typedef struct {
    const char *name;
    const uint8_t *data;
    uint32_t size;
} t2_builtin_t;

extern const t2_builtin_t t2_core_modules[];

#endif
