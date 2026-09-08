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
