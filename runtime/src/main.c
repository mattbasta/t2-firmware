/*
 * Tessel 2 runtime — entrypoint.
 *
 * Embeds txiki.js as a library rather than patching its CLI: this binary is
 * `node`, not `tjs`. The one thing txiki does not offer an embedder is a way to
 * choose the entrypoint — TJS_Run() otherwise evaluates its own CLI bundle — so
 * the fork carries a small patch adding entry/entry_size to TJSRunOptions. See
 * runtime/docs/phase1-plan.md §1.
 *
 * SPDX-License-Identifier: MIT
 */

#include "t2.h"
#include "tjs.h"

/* Our JS bootstrap, compiled to QuickJS bytecode by runtime/scripts/build-js.sh
 * and committed as runtime/src/bundles/entry.c. */
extern const uint8_t t2__entry[];
extern const uint32_t t2__entry_size;

int main(int argc, char **argv) {
    TJS_Initialize(argc, argv);

    TJSRunOptions options;

    TJS_DefaultOptions(&options);
    options.entry = t2__entry;
    options.entry_size = t2__entry_size;

    TJSRuntime *qrt = TJS_NewRuntimeOptions(&options);

    if (!qrt) {
        return 1;
    }

    t2_register_natives(TJS_GetJSContext(qrt));

    int exit_code = TJS_Run(qrt);

    TJS_FreeRuntime(qrt);

    return exit_code;
}
