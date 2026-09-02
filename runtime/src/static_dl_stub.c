/* dlsym() replacement for statically linked musl binaries on MIPS.
 *
 * musl's MIPS dlsym is an assembly shim (src/ldso/mips/dlsym.s) that derives
 * $gp from $t9 as the PIC calling convention requires. Callers in a static
 * non-PIC executable do not set $t9, so the shim loads a garbage GOT entry and
 * jumps to it: any dlsym() call segfaults, -static-pie included (found in
 * Phase 0; see runtime/docs/phase0-results.md). libuv calls dlsym() once at
 * startup to probe posix_spawn_file_actions_addchdir, and sqlite's extension
 * loader references it too.
 *
 * A static binary cannot resolve symbols dynamically regardless, so the
 * correct answer is the one musl gives for an unknown symbol: NULL. Defining
 * the symbol here keeps libc's crashing implementation out of the link.
 *
 * On 32-bit targets with 64-bit time_t, <dlfcn.h> redirects dlsym to
 * __dlsym_time64, so that is the name references actually carry; plain dlsym
 * is provided for anything that bypasses the header.
 */

#include <stddef.h>

void *__dlsym_time64(void *handle, const char *symbol, void *caller)
{
    (void)handle;
    (void)symbol;
    (void)caller;
    return NULL;
}

void *dlsym(void *handle, const char *symbol)
{
    (void)handle;
    (void)symbol;
    return NULL;
}
