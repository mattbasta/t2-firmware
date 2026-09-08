/*
 * Tessel 2 runtime — the platform constant table.
 *
 * Backs the legacy `constants` core module, and will back os.constants and the
 * signal names when those land. Every value is read from the target's own
 * headers: errno numbers are not portable — EAGAIN is 11 on Linux and 35 on
 * macOS — so a table written in JS would be right on the machine it was written
 * on and wrong on the board.
 *
 * `require('constants')` was deprecated in Node 6 (DEP0008) and is still there
 * in Node 26, because a decade of packages import it. graceful-fs is the one
 * that found it here: it resolves fs, then constants, and stops.
 *
 * Names absent on a platform are simply absent from the object, which is what
 * Node does too.
 *
 * SPDX-License-Identifier: MIT
 */

#include "t2.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

void t2_fill_constants(JSContext *ctx, JSValue obj) {
#define T2_C(name)                                                              \
    JS_SetPropertyStr(ctx, obj, #name, JS_NewInt32(ctx, (int32_t) (name)))

    /* --- errno ------------------------------------------------------------ */
#ifdef E2BIG
    T2_C(E2BIG);
#endif
#ifdef EACCES
    T2_C(EACCES);
#endif
#ifdef EADDRINUSE
    T2_C(EADDRINUSE);
#endif
#ifdef EADDRNOTAVAIL
    T2_C(EADDRNOTAVAIL);
#endif
#ifdef EAFNOSUPPORT
    T2_C(EAFNOSUPPORT);
#endif
#ifdef EAGAIN
    T2_C(EAGAIN);
#endif
#ifdef EALREADY
    T2_C(EALREADY);
#endif
#ifdef EBADF
    T2_C(EBADF);
#endif
#ifdef EBADMSG
    T2_C(EBADMSG);
#endif
#ifdef EBUSY
    T2_C(EBUSY);
#endif
#ifdef ECANCELED
    T2_C(ECANCELED);
#endif
#ifdef ECHILD
    T2_C(ECHILD);
#endif
#ifdef ECONNABORTED
    T2_C(ECONNABORTED);
#endif
#ifdef ECONNREFUSED
    T2_C(ECONNREFUSED);
#endif
#ifdef ECONNRESET
    T2_C(ECONNRESET);
#endif
#ifdef EDEADLK
    T2_C(EDEADLK);
#endif
#ifdef EDESTADDRREQ
    T2_C(EDESTADDRREQ);
#endif
#ifdef EDOM
    T2_C(EDOM);
#endif
#ifdef EDQUOT
    T2_C(EDQUOT);
#endif
#ifdef EEXIST
    T2_C(EEXIST);
#endif
#ifdef EFAULT
    T2_C(EFAULT);
#endif
#ifdef EFBIG
    T2_C(EFBIG);
#endif
#ifdef EHOSTUNREACH
    T2_C(EHOSTUNREACH);
#endif
#ifdef EIDRM
    T2_C(EIDRM);
#endif
#ifdef EILSEQ
    T2_C(EILSEQ);
#endif
#ifdef EINPROGRESS
    T2_C(EINPROGRESS);
#endif
#ifdef EINTR
    T2_C(EINTR);
#endif
#ifdef EINVAL
    T2_C(EINVAL);
#endif
#ifdef EIO
    T2_C(EIO);
#endif
#ifdef EISCONN
    T2_C(EISCONN);
#endif
#ifdef EISDIR
    T2_C(EISDIR);
#endif
#ifdef ELOOP
    T2_C(ELOOP);
#endif
#ifdef EMFILE
    T2_C(EMFILE);
#endif
#ifdef EMLINK
    T2_C(EMLINK);
#endif
#ifdef EMSGSIZE
    T2_C(EMSGSIZE);
#endif
#ifdef EMULTIHOP
    T2_C(EMULTIHOP);
#endif
#ifdef ENAMETOOLONG
    T2_C(ENAMETOOLONG);
#endif
#ifdef ENETDOWN
    T2_C(ENETDOWN);
#endif
#ifdef ENETRESET
    T2_C(ENETRESET);
#endif
#ifdef ENETUNREACH
    T2_C(ENETUNREACH);
#endif
#ifdef ENFILE
    T2_C(ENFILE);
#endif
#ifdef ENOBUFS
    T2_C(ENOBUFS);
#endif
#ifdef ENODEV
    T2_C(ENODEV);
#endif
#ifdef ENOENT
    T2_C(ENOENT);
#endif
#ifdef ENOEXEC
    T2_C(ENOEXEC);
#endif
#ifdef ENOLCK
    T2_C(ENOLCK);
#endif
#ifdef ENOLINK
    T2_C(ENOLINK);
#endif
#ifdef ENOMEM
    T2_C(ENOMEM);
#endif
#ifdef ENOMSG
    T2_C(ENOMSG);
#endif
#ifdef ENOPROTOOPT
    T2_C(ENOPROTOOPT);
#endif
#ifdef ENOSPC
    T2_C(ENOSPC);
#endif
#ifdef ENOSYS
    T2_C(ENOSYS);
#endif
#ifdef ENOTCONN
    T2_C(ENOTCONN);
#endif
#ifdef ENOTDIR
    T2_C(ENOTDIR);
#endif
#ifdef ENOTEMPTY
    T2_C(ENOTEMPTY);
#endif
#ifdef ENOTSOCK
    T2_C(ENOTSOCK);
#endif
#ifdef ENOTSUP
    T2_C(ENOTSUP);
#endif
#ifdef ENOTTY
    T2_C(ENOTTY);
#endif
#ifdef ENXIO
    T2_C(ENXIO);
#endif
#ifdef EOPNOTSUPP
    T2_C(EOPNOTSUPP);
#endif
#ifdef EOVERFLOW
    T2_C(EOVERFLOW);
#endif
#ifdef EPERM
    T2_C(EPERM);
#endif
#ifdef EPIPE
    T2_C(EPIPE);
#endif
#ifdef EPROTO
    T2_C(EPROTO);
#endif
#ifdef EPROTONOSUPPORT
    T2_C(EPROTONOSUPPORT);
#endif
#ifdef EPROTOTYPE
    T2_C(EPROTOTYPE);
#endif
#ifdef ERANGE
    T2_C(ERANGE);
#endif
#ifdef EROFS
    T2_C(EROFS);
#endif
#ifdef ESPIPE
    T2_C(ESPIPE);
#endif
#ifdef ESRCH
    T2_C(ESRCH);
#endif
#ifdef ESTALE
    T2_C(ESTALE);
#endif
#ifdef ETIMEDOUT
    T2_C(ETIMEDOUT);
#endif
#ifdef ETXTBSY
    T2_C(ETXTBSY);
#endif
#ifdef EWOULDBLOCK
    T2_C(EWOULDBLOCK);
#endif
#ifdef EXDEV
    T2_C(EXDEV);
#endif

    /* --- signals ---------------------------------------------------------- */
#ifdef SIGHUP
    T2_C(SIGHUP);
#endif
#ifdef SIGINT
    T2_C(SIGINT);
#endif
#ifdef SIGQUIT
    T2_C(SIGQUIT);
#endif
#ifdef SIGILL
    T2_C(SIGILL);
#endif
#ifdef SIGTRAP
    T2_C(SIGTRAP);
#endif
#ifdef SIGABRT
    T2_C(SIGABRT);
#endif
#ifdef SIGIOT
    T2_C(SIGIOT);
#endif
#ifdef SIGBUS
    T2_C(SIGBUS);
#endif
#ifdef SIGFPE
    T2_C(SIGFPE);
#endif
#ifdef SIGKILL
    T2_C(SIGKILL);
#endif
#ifdef SIGUSR1
    T2_C(SIGUSR1);
#endif
#ifdef SIGSEGV
    T2_C(SIGSEGV);
#endif
#ifdef SIGUSR2
    T2_C(SIGUSR2);
#endif
#ifdef SIGPIPE
    T2_C(SIGPIPE);
#endif
#ifdef SIGALRM
    T2_C(SIGALRM);
#endif
#ifdef SIGTERM
    T2_C(SIGTERM);
#endif
#ifdef SIGCHLD
    T2_C(SIGCHLD);
#endif
#ifdef SIGCONT
    T2_C(SIGCONT);
#endif
#ifdef SIGSTOP
    T2_C(SIGSTOP);
#endif
#ifdef SIGTSTP
    T2_C(SIGTSTP);
#endif
#ifdef SIGTTIN
    T2_C(SIGTTIN);
#endif
#ifdef SIGTTOU
    T2_C(SIGTTOU);
#endif
#ifdef SIGURG
    T2_C(SIGURG);
#endif
#ifdef SIGXCPU
    T2_C(SIGXCPU);
#endif
#ifdef SIGXFSZ
    T2_C(SIGXFSZ);
#endif
#ifdef SIGVTALRM
    T2_C(SIGVTALRM);
#endif
#ifdef SIGPROF
    T2_C(SIGPROF);
#endif
#ifdef SIGWINCH
    T2_C(SIGWINCH);
#endif
#ifdef SIGIO
    T2_C(SIGIO);
#endif
#ifdef SIGSYS
    T2_C(SIGSYS);
#endif

    /* --- open flags and file modes ---------------------------------------- */
#ifdef O_RDONLY
    T2_C(O_RDONLY);
#endif
#ifdef O_WRONLY
    T2_C(O_WRONLY);
#endif
#ifdef O_RDWR
    T2_C(O_RDWR);
#endif
#ifdef O_CREAT
    T2_C(O_CREAT);
#endif
#ifdef O_EXCL
    T2_C(O_EXCL);
#endif
#ifdef O_NOCTTY
    T2_C(O_NOCTTY);
#endif
#ifdef O_TRUNC
    T2_C(O_TRUNC);
#endif
#ifdef O_APPEND
    T2_C(O_APPEND);
#endif
#ifdef O_DIRECTORY
    T2_C(O_DIRECTORY);
#endif
#ifdef O_NOFOLLOW
    T2_C(O_NOFOLLOW);
#endif
#ifdef O_SYNC
    T2_C(O_SYNC);
#endif
#ifdef O_DSYNC
    T2_C(O_DSYNC);
#endif
#ifdef O_NONBLOCK
    T2_C(O_NONBLOCK);
#endif

#ifdef S_IFMT
    T2_C(S_IFMT);
#endif
#ifdef S_IFREG
    T2_C(S_IFREG);
#endif
#ifdef S_IFDIR
    T2_C(S_IFDIR);
#endif
#ifdef S_IFCHR
    T2_C(S_IFCHR);
#endif
#ifdef S_IFBLK
    T2_C(S_IFBLK);
#endif
#ifdef S_IFIFO
    T2_C(S_IFIFO);
#endif
#ifdef S_IFLNK
    T2_C(S_IFLNK);
#endif
#ifdef S_IFSOCK
    T2_C(S_IFSOCK);
#endif
#ifdef S_IRWXU
    T2_C(S_IRWXU);
#endif
#ifdef S_IRUSR
    T2_C(S_IRUSR);
#endif
#ifdef S_IWUSR
    T2_C(S_IWUSR);
#endif
#ifdef S_IXUSR
    T2_C(S_IXUSR);
#endif
#ifdef S_IRWXG
    T2_C(S_IRWXG);
#endif
#ifdef S_IRGRP
    T2_C(S_IRGRP);
#endif
#ifdef S_IWGRP
    T2_C(S_IWGRP);
#endif
#ifdef S_IXGRP
    T2_C(S_IXGRP);
#endif
#ifdef S_IRWXO
    T2_C(S_IRWXO);
#endif
#ifdef S_IROTH
    T2_C(S_IROTH);
#endif
#ifdef S_IWOTH
    T2_C(S_IWOTH);
#endif
#ifdef S_IXOTH
    T2_C(S_IXOTH);
#endif

#ifdef F_OK
    T2_C(F_OK);
#endif
#ifdef R_OK
    T2_C(R_OK);
#endif
#ifdef W_OK
    T2_C(W_OK);
#endif
#ifdef X_OK
    T2_C(X_OK);
#endif

    /* --- dlopen ----------------------------------------------------------- */
#ifdef RTLD_LAZY
    T2_C(RTLD_LAZY);
#endif
#ifdef RTLD_NOW
    T2_C(RTLD_NOW);
#endif
#ifdef RTLD_GLOBAL
    T2_C(RTLD_GLOBAL);
#endif
#ifdef RTLD_LOCAL
    T2_C(RTLD_LOCAL);
#endif

#undef T2_C
}

void t2_register_constants(JSContext *ctx, JSValue natives) {
    JSValue obj = JS_NewObject(ctx);

    t2_fill_constants(ctx, obj);

    JS_SetPropertyStr(ctx, natives, "constants", obj);
}
