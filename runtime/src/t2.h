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

#endif
