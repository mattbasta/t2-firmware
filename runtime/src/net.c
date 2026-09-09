/*
 * Tessel 2 runtime — stream handle primitives.
 *
 * The libuv half of node:net. This exposes raw pipe and TCP handles —
 * connect/read/write/shutdown/close, plus bind/listen/accept — and nothing that
 * looks like Node. net.Socket is a stream.Duplex built on top of these in
 * runtime/js/node/net.js, which is what gives it cork/uncork and _writev for
 * free from the Phase 1 stream port.
 *
 * Why first-party rather than txiki's sockets: its public PipeSocket is built
 * on WHATWG streams and its BaseStreamSocket has no ref, unref or cork. The
 * Tessel's SPI port needs all three — unref() on the spid socket is the reason
 * a Tessel script exits, and cork/uncork wraps every command batch — and the
 * handle-level primitives that do carry them live on tjs:internal/core, which
 * DEPENDENCIES.md puts out of bounds. See runtime/docs/phase2-plan.md §2.
 *
 * Lifetime, which is the subtle part: an open handle holds a strong reference
 * to its own JS wrapper, released when the handle finishes closing. So a socket
 * cannot be collected out from under a pending read — which matches Node, where
 * an open socket keeps itself and the process alive — and the wrapper becomes
 * collectable only once the handle is truly closed. The finalizer refuses to
 * free a struct libuv still owns; the close callback frees one the finalizer
 * already released.
 *
 * SPDX-License-Identifier: MIT
 */

#include "t2.h"
#include "tjs.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
#include <uv.h>

#define T2_COUNTOF(x) (sizeof(x) / sizeof((x)[0]))

/* Hands a js_malloc'd buffer to a Uint8Array and lets the engine own it from
 * there. txiki has the same three lines, but on its internal utils header. */
static void *t2_buf_realloc(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
    return js_realloc_rt(rt, ptr, size);
}

static JSValue t2_new_uint8array(JSContext *ctx, uint8_t *data, size_t size) {
    return JS_NewUint8Array(ctx, data, size, t2_buf_realloc, NULL, false);
}

enum { T2_HANDLE_PIPE, T2_HANDLE_TCP };

typedef struct {
    JSContext *ctx;
    /* Strong reference to the JS wrapper, held while the handle is open. */
    JSValue self;
    int type;
    int closed;
    int finalized;
    int reading;
    union {
        uv_handle_t handle;
        uv_stream_t stream;
        uv_pipe_t pipe;
        uv_tcp_t tcp;
    } h;
    JSValue on_read;
    JSValue on_connection;
    JSValue on_close;
    char *read_buf;
} t2_handle_t;

typedef struct {
    uv_connect_t req;
    JSContext *ctx;
    JSValue callback;
} t2_connect_req_t;

typedef struct {
    uv_write_t req;
    JSContext *ctx;
    JSValue callback;
    /* The buffers being written, held so the GC cannot move or free them while
     * libuv is reading out of them. */
    JSValue buffers;
    uv_buf_t *bufs;
} t2_write_req_t;

typedef struct {
    uv_shutdown_t req;
    JSContext *ctx;
    JSValue callback;
} t2_shutdown_req_t;

typedef struct {
    uv_getaddrinfo_t req;
    JSContext *ctx;
    JSValue callback;
} t2_lookup_req_t;

static JSClassID t2_handle_class_id;

static uv_loop_t *t2_net_loop(JSContext *ctx) {
    return TJS_GetLoop(TJS_GetRuntime(ctx));
}

/* A callback reaching JS from inside a loop callback has nowhere to throw.
 * net.js wraps everything it installs, so this is a last resort. */
static void t2_net_call(JSContext *ctx, JSValue func, int argc, JSValue *argv) {
    if (!JS_IsFunction(ctx, func)) {
        return;
    }

    JSValue ret = JS_Call(ctx, func, JS_UNDEFINED, argc, argv);

    if (JS_IsException(ret)) {
        t2_report_exception(ctx, "a net callback");
    }

    JS_FreeValue(ctx, ret);
}

static t2_handle_t *t2_handle_of(JSContext *ctx, JSValue value) {
    return JS_GetOpaque2(ctx, value, t2_handle_class_id);
}

/* --- lifetime -------------------------------------------------------------- */

static void t2_handle_close_cb(uv_handle_t *handle) {
    t2_handle_t *s = handle->data;
    JSContext *ctx = s->ctx;

    s->closed = 1;

    if (s->finalized) {
        /* The wrapper is already gone; nothing can call back into JS. */
        js_free(ctx, s->read_buf);
        js_free(ctx, s);

        return;
    }

    JSValue on_close = s->on_close;

    s->on_close = JS_UNDEFINED;
    t2_net_call(ctx, on_close, 0, NULL);
    JS_FreeValue(ctx, on_close);

    /* Releasing the self-reference can run the finalizer immediately, so
     * nothing may touch `s` after this line. */
    JSValue self = s->self;

    s->self = JS_UNDEFINED;
    JS_FreeValue(ctx, self);
}

static void t2_handle_finalizer(JSRuntime *rt, JSValue val) {
    t2_handle_t *s = JS_GetOpaque(val, t2_handle_class_id);

    if (!s) {
        return;
    }

    JS_FreeValueRT(rt, s->on_read);
    JS_FreeValueRT(rt, s->on_connection);
    JS_FreeValueRT(rt, s->on_close);

    if (s->closed) {
        js_free_rt(rt, s->read_buf);
        js_free_rt(rt, s);

        return;
    }

    /* libuv still owns the handle — at runtime teardown, say. Mark it and let
     * the close callback do the freeing rather than pulling memory out from
     * under the loop. */
    s->finalized = 1;

    if (!uv_is_closing(&s->h.handle)) {
        uv_close(&s->h.handle, t2_handle_close_cb);
    }
}

static void t2_handle_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_func) {
    t2_handle_t *s = JS_GetOpaque(val, t2_handle_class_id);

    if (s) {
        JS_MarkValue(rt, s->on_read, mark_func);
        JS_MarkValue(rt, s->on_connection, mark_func);
        JS_MarkValue(rt, s->on_close, mark_func);
    }
}

static JSClassDef t2_handle_class = {
    "T2Handle",
    .finalizer = t2_handle_finalizer,
    .gc_mark = t2_handle_mark,
};

static JSValue t2_handle_new(JSContext *ctx, int type) {
    JSValue obj = JS_NewObjectClass(ctx, t2_handle_class_id);

    if (JS_IsException(obj)) {
        return obj;
    }

    t2_handle_t *s = js_mallocz(ctx, sizeof(*s));

    if (!s) {
        JS_FreeValue(ctx, obj);

        return JS_ThrowOutOfMemory(ctx);
    }

    s->ctx = ctx;
    s->type = type;
    s->on_read = JS_UNDEFINED;
    s->on_connection = JS_UNDEFINED;
    s->on_close = JS_UNDEFINED;

    int r = type == T2_HANDLE_PIPE ? uv_pipe_init(t2_net_loop(ctx), &s->h.pipe, 0)
                                   : uv_tcp_init(t2_net_loop(ctx), &s->h.tcp);

    if (r != 0) {
        js_free(ctx, s);
        JS_FreeValue(ctx, obj);

        return t2_throw_uv(ctx, r, "socket", NULL);
    }

    s->h.handle.data = s;
    JS_SetOpaque(obj, s);

    /* The handle keeps its wrapper alive until it is closed. */
    s->self = JS_DupValue(ctx, obj);

    return obj;
}

static JSValue t2_new_pipe(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    return t2_handle_new(ctx, T2_HANDLE_PIPE);
}

static JSValue t2_new_tcp(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    return t2_handle_new(ctx, T2_HANDLE_TCP);
}

static JSValue t2_handle_close(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    if (uv_is_closing(&s->h.handle)) {
        return JS_UNDEFINED;
    }

    JS_FreeValue(ctx, s->on_close);
    s->on_close = JS_DupValue(ctx, argv[0]);

    uv_close(&s->h.handle, t2_handle_close_cb);

    return JS_UNDEFINED;
}

/* --- reading --------------------------------------------------------------- */

static void t2_alloc_cb(uv_handle_t *handle, size_t suggested, uv_buf_t *buf) {
    t2_handle_t *s = handle->data;

    s->read_buf = js_malloc(s->ctx, suggested);
    buf->base = s->read_buf;
    buf->len = s->read_buf ? suggested : 0;
}

/* onread(chunk | null, error). null means EOF, which net.js turns into
 * push(null) and the 'end' event. */
static void t2_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
    t2_handle_t *s = stream->data;
    JSContext *ctx = s->ctx;

    if (nread == 0) {
        js_free(ctx, s->read_buf);
        s->read_buf = NULL;

        return; /* EAGAIN */
    }

    JSValue args[2];

    if (nread < 0) {
        js_free(ctx, s->read_buf);
        s->read_buf = NULL;

        if (nread == UV_EOF) {
            args[0] = JS_NULL;
            args[1] = JS_UNDEFINED;
        } else {
            args[0] = JS_UNDEFINED;
            args[1] = t2_new_uv_error(ctx, (int) nread, "read", NULL, NULL);
        }
    } else {
        /* libuv suggests 64 KB and a chunk is usually far smaller. Shrinking
         * before handing the block to a Uint8Array matters here: otherwise
         * every read holds 64 KB alive until the GC gets to it, on a board with
         * 60 MB of RAM. */
        char *shrunk = js_realloc(ctx, s->read_buf, nread);

        args[0] = t2_new_uint8array(ctx, (uint8_t *) (shrunk ? shrunk : s->read_buf), nread);
        args[1] = JS_UNDEFINED;
        s->read_buf = NULL;
    }

    t2_net_call(ctx, s->on_read, 2, args);

    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
}

static JSValue t2_handle_start_read(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    if (s->reading) {
        return JS_UNDEFINED;
    }

    JS_FreeValue(ctx, s->on_read);
    s->on_read = JS_DupValue(ctx, argv[0]);

    int r = uv_read_start(&s->h.stream, t2_alloc_cb, t2_read_cb);

    if (r != 0) {
        return t2_throw_uv(ctx, r, "read", NULL);
    }

    s->reading = 1;

    return JS_UNDEFINED;
}

static JSValue t2_handle_stop_read(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    if (!s->reading || uv_is_closing(&s->h.handle)) {
        return JS_UNDEFINED;
    }

    uv_read_stop(&s->h.stream);
    s->reading = 0;

    return JS_UNDEFINED;
}

/* --- writing --------------------------------------------------------------- */

static void t2_write_cb(uv_write_t *req, int status) {
    t2_write_req_t *wr = (t2_write_req_t *) req;
    JSContext *ctx = wr->ctx;
    JSValue arg = status < 0 ? t2_new_uv_error(ctx, status, "write", NULL, NULL) : JS_NULL;

    t2_net_call(ctx, wr->callback, 1, &arg);

    JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, wr->callback);
    JS_FreeValue(ctx, wr->buffers);
    js_free(ctx, wr->bufs);
    js_free(ctx, wr);
}

/* write(buffers, callback) -> true when the whole thing went out inline.
 *
 * The inline attempt matters: Node's Writable treats a synchronous completion
 * as "no backpressure", and a corked SPI batch that always took a trip through
 * the loop would cost a turn per command. */
static JSValue t2_handle_write(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    if (uv_is_closing(&s->h.handle)) {
        return t2_throw_uv(ctx, UV_EPIPE, "write", NULL);
    }

    uint32_t count;
    JSValue length = JS_GetPropertyStr(ctx, argv[0], "length");

    if (JS_ToUint32(ctx, &count, length)) {
        JS_FreeValue(ctx, length);

        return JS_EXCEPTION;
    }

    JS_FreeValue(ctx, length);

    if (count == 0) {
        return JS_TRUE;
    }

    uv_buf_t *bufs = js_malloc(ctx, sizeof(*bufs) * count);

    if (!bufs) {
        return JS_EXCEPTION;
    }

    for (uint32_t i = 0; i < count; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, argv[0], i);
        size_t len;
        uint8_t *bytes = JS_GetUint8Array(ctx, &len, item);

        JS_FreeValue(ctx, item);

        if (!bytes) {
            js_free(ctx, bufs);

            return JS_EXCEPTION;
        }

        bufs[i] = uv_buf_init((char *) bytes, len);
    }

    /* Try to get it out without touching the loop at all. */
    int r = uv_try_write(&s->h.stream, bufs, count);
    size_t total = 0;

    for (uint32_t i = 0; i < count; i++) {
        total += bufs[i].len;
    }

    if (r >= 0 && (size_t) r == total) {
        js_free(ctx, bufs);

        return JS_TRUE;
    }

    /* Partially written: advance past what went out and queue the rest. */
    if (r > 0) {
        size_t consumed = r;

        for (uint32_t i = 0; i < count && consumed > 0; i++) {
            size_t take = consumed < bufs[i].len ? consumed : bufs[i].len;

            bufs[i].base += take;
            bufs[i].len -= take;
            consumed -= take;
        }
    }

    t2_write_req_t *wr = js_mallocz(ctx, sizeof(*wr));

    if (!wr) {
        js_free(ctx, bufs);

        return JS_EXCEPTION;
    }

    wr->ctx = ctx;
    wr->callback = JS_DupValue(ctx, argv[1]);
    wr->buffers = JS_DupValue(ctx, argv[0]);
    wr->bufs = bufs;

    r = uv_write(&wr->req, &s->h.stream, bufs, count, t2_write_cb);

    if (r != 0) {
        JS_FreeValue(ctx, wr->callback);
        JS_FreeValue(ctx, wr->buffers);
        js_free(ctx, bufs);
        js_free(ctx, wr);

        return t2_throw_uv(ctx, r, "write", NULL);
    }

    return JS_FALSE;
}

static void t2_shutdown_cb(uv_shutdown_t *req, int status) {
    t2_shutdown_req_t *sr = (t2_shutdown_req_t *) req;
    JSContext *ctx = sr->ctx;
    JSValue arg = status < 0 ? t2_new_uv_error(ctx, status, "shutdown", NULL, NULL) : JS_NULL;

    t2_net_call(ctx, sr->callback, 1, &arg);

    JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, sr->callback);
    js_free(ctx, sr);
}

static JSValue t2_handle_shutdown(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    t2_shutdown_req_t *sr = js_mallocz(ctx, sizeof(*sr));

    if (!sr) {
        return JS_EXCEPTION;
    }

    sr->ctx = ctx;
    sr->callback = JS_DupValue(ctx, argv[0]);

    int r = uv_shutdown(&sr->req, &s->h.stream, t2_shutdown_cb);

    if (r != 0) {
        JS_FreeValue(ctx, sr->callback);
        js_free(ctx, sr);

        return t2_throw_uv(ctx, r, "shutdown", NULL);
    }

    return JS_UNDEFINED;
}

/* --- connecting ------------------------------------------------------------ */

static void t2_connect_cb(uv_connect_t *req, int status) {
    t2_connect_req_t *cr = (t2_connect_req_t *) req;
    JSContext *ctx = cr->ctx;
    JSValue arg = status < 0 ? t2_new_uv_error(ctx, status, "connect", NULL, NULL) : JS_NULL;

    t2_net_call(ctx, cr->callback, 1, &arg);

    JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, cr->callback);
    js_free(ctx, cr);
}

/* connect(pathOrHost, port, callback) — port is ignored for a pipe. */
static JSValue t2_handle_connect(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    const char *target = JS_ToCString(ctx, argv[0]);

    if (!target) {
        return JS_EXCEPTION;
    }

    t2_connect_req_t *cr = js_mallocz(ctx, sizeof(*cr));

    if (!cr) {
        JS_FreeCString(ctx, target);

        return JS_EXCEPTION;
    }

    cr->ctx = ctx;
    cr->callback = JS_DupValue(ctx, argv[2]);

    if (s->type == T2_HANDLE_PIPE) {
        uv_pipe_connect(&cr->req, &s->h.pipe, target, t2_connect_cb);
        JS_FreeCString(ctx, target);

        return JS_UNDEFINED;
    }

    int32_t port;

    if (JS_ToInt32(ctx, &port, argv[1])) {
        JS_FreeValue(ctx, cr->callback);
        js_free(ctx, cr);
        JS_FreeCString(ctx, target);

        return JS_EXCEPTION;
    }

    struct sockaddr_storage addr;
    int r = uv_ip4_addr(target, port, (struct sockaddr_in *) &addr);

    if (r != 0) {
        r = uv_ip6_addr(target, port, (struct sockaddr_in6 *) &addr);
    }

    JS_FreeCString(ctx, target);

    if (r == 0) {
        r = uv_tcp_connect(&cr->req, &s->h.tcp, (struct sockaddr *) &addr, t2_connect_cb);
    }

    if (r != 0) {
        JS_FreeValue(ctx, cr->callback);
        js_free(ctx, cr);

        return t2_throw_uv(ctx, r, "connect", NULL);
    }

    return JS_UNDEFINED;
}

/* --- listening ------------------------------------------------------------- */

static void t2_connection_cb(uv_stream_t *server, int status) {
    t2_handle_t *s = server->data;
    JSContext *ctx = s->ctx;
    JSValue arg = status < 0 ? t2_new_uv_error(ctx, status, "accept", NULL, NULL) : JS_NULL;

    t2_net_call(ctx, s->on_connection, 1, &arg);

    JS_FreeValue(ctx, arg);
}

/* bind(pathOrHost, port) */
static JSValue t2_handle_bind(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    const char *target = JS_ToCString(ctx, argv[0]);

    if (!target) {
        return JS_EXCEPTION;
    }

    int r;

    if (s->type == T2_HANDLE_PIPE) {
        r = uv_pipe_bind(&s->h.pipe, target);
    } else {
        int32_t port;

        if (JS_ToInt32(ctx, &port, argv[1])) {
            JS_FreeCString(ctx, target);

            return JS_EXCEPTION;
        }

        struct sockaddr_storage addr;

        r = uv_ip4_addr(target, port, (struct sockaddr_in *) &addr);

        if (r != 0) {
            r = uv_ip6_addr(target, port, (struct sockaddr_in6 *) &addr);
        }

        if (r == 0) {
            r = uv_tcp_bind(&s->h.tcp, (struct sockaddr *) &addr, 0);
        }
    }

    JS_FreeCString(ctx, target);

    if (r != 0) {
        return t2_throw_uv(ctx, r, "bind", NULL);
    }

    return JS_UNDEFINED;
}

static JSValue t2_handle_listen(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    int32_t backlog;

    if (JS_ToInt32(ctx, &backlog, argv[0])) {
        return JS_EXCEPTION;
    }

    JS_FreeValue(ctx, s->on_connection);
    s->on_connection = JS_DupValue(ctx, argv[1]);

    int r = uv_listen(&s->h.stream, backlog, t2_connection_cb);

    if (r != 0) {
        return t2_throw_uv(ctx, r, "listen", NULL);
    }

    return JS_UNDEFINED;
}

/* accept() -> a new handle, or null when there is nothing pending. */
static JSValue t2_handle_accept(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    JSValue client = t2_handle_new(ctx, s->type);

    if (JS_IsException(client)) {
        return client;
    }

    t2_handle_t *c = JS_GetOpaque(client, t2_handle_class_id);
    int r = uv_accept(&s->h.stream, &c->h.stream);

    if (r != 0) {
        /* Drops the self-reference too, so the wrapper is collectable. */
        uv_close(&c->h.handle, t2_handle_close_cb);
        JS_FreeValue(ctx, client);

        return r == UV_EAGAIN ? JS_NULL : t2_throw_uv(ctx, r, "accept", NULL);
    }

    return client;
}

/* --- odds and ends --------------------------------------------------------- */

static JSValue t2_handle_ref(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    uv_ref(&s->h.handle);

    return JS_UNDEFINED;
}

/* The reason a Tessel script exits: tessel-export.js unrefs the spid socket so
 * an idle port does not hold the loop open. */
static JSValue t2_handle_unref(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    uv_unref(&s->h.handle);

    return JS_UNDEFINED;
}

static JSValue t2_handle_fileno(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    uv_os_fd_t fd;

    if (uv_fileno(&s->h.handle, &fd) != 0) {
        return JS_NULL;
    }

    return JS_NewInt32(ctx, (int32_t) (intptr_t) fd);
}

static JSValue t2_handle_open(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    int32_t fd;

    if (JS_ToInt32(ctx, &fd, argv[0])) {
        return JS_EXCEPTION;
    }

    int r = s->type == T2_HANDLE_PIPE ? uv_pipe_open(&s->h.pipe, fd) : uv_tcp_open(&s->h.tcp, fd);

    if (r != 0) {
        return t2_throw_uv(ctx, r, "open", NULL);
    }

    return JS_UNDEFINED;
}

static JSValue t2_addr_object(JSContext *ctx, const struct sockaddr_storage *addr) {
    char ip[INET6_ADDRSTRLEN + 1] = { 0 };
    JSValue obj = JS_NewObject(ctx);

    if (addr->ss_family == AF_INET) {
        const struct sockaddr_in *in = (const struct sockaddr_in *) addr;

        uv_ip4_name(in, ip, sizeof(ip) - 1);
        JS_SetPropertyStr(ctx, obj, "address", JS_NewString(ctx, ip));
        JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, ntohs(in->sin_port)));
        JS_SetPropertyStr(ctx, obj, "family", JS_NewString(ctx, "IPv4"));
    } else if (addr->ss_family == AF_INET6) {
        const struct sockaddr_in6 *in6 = (const struct sockaddr_in6 *) addr;

        uv_ip6_name(in6, ip, sizeof(ip) - 1);
        JS_SetPropertyStr(ctx, obj, "address", JS_NewString(ctx, ip));
        JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, ntohs(in6->sin6_port)));
        JS_SetPropertyStr(ctx, obj, "family", JS_NewString(ctx, "IPv6"));
    }

    return obj;
}

static JSValue t2_handle_sockname(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s) {
        return JS_EXCEPTION;
    }

    int peer = JS_ToBool(ctx, argv[0]);

    if (s->type == T2_HANDLE_PIPE) {
        char path[1024];
        size_t len = sizeof(path);
        int r = peer ? uv_pipe_getpeername(&s->h.pipe, path, &len)
                     : uv_pipe_getsockname(&s->h.pipe, path, &len);

        if (r != 0) {
            return JS_NULL;
        }

        JSValue obj = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, obj, "address", JS_NewStringLen(ctx, path, len));

        return obj;
    }

    struct sockaddr_storage addr;
    int namelen = sizeof(addr);
    int r = peer ? uv_tcp_getpeername(&s->h.tcp, (struct sockaddr *) &addr, &namelen)
                 : uv_tcp_getsockname(&s->h.tcp, (struct sockaddr *) &addr, &namelen);

    if (r != 0) {
        return JS_NULL;
    }

    return t2_addr_object(ctx, &addr);
}

static JSValue t2_handle_set_no_delay(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s || s->type != T2_HANDLE_TCP) {
        return JS_UNDEFINED;
    }

    uv_tcp_nodelay(&s->h.tcp, JS_ToBool(ctx, argv[0]));

    return JS_UNDEFINED;
}

static JSValue t2_handle_set_keep_alive(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    t2_handle_t *s = t2_handle_of(ctx, this_val);

    if (!s || s->type != T2_HANDLE_TCP) {
        return JS_UNDEFINED;
    }

    int32_t delay = 0;

    JS_ToInt32(ctx, &delay, argv[1]);
    uv_tcp_keepalive(&s->h.tcp, JS_ToBool(ctx, argv[0]), delay);

    return JS_UNDEFINED;
}

/* --- name resolution ------------------------------------------------------- */

static void t2_lookup_cb(uv_getaddrinfo_t *req, int status, struct addrinfo *res) {
    t2_lookup_req_t *lr = (t2_lookup_req_t *) req;
    JSContext *ctx = lr->ctx;
    JSValue args[2];

    if (status < 0) {
        args[0] = t2_new_uv_error(ctx, status, "getaddrinfo", NULL, NULL);
        args[1] = JS_UNDEFINED;
    } else {
        args[0] = JS_NULL;
        args[1] = JS_NewArray(ctx);

        uint32_t i = 0;

        for (struct addrinfo *it = res; it != NULL; it = it->ai_next) {
            char ip[INET6_ADDRSTRLEN + 1] = { 0 };
            int family;

            if (it->ai_family == AF_INET) {
                uv_ip4_name((struct sockaddr_in *) it->ai_addr, ip, sizeof(ip) - 1);
                family = 4;
            } else if (it->ai_family == AF_INET6) {
                uv_ip6_name((struct sockaddr_in6 *) it->ai_addr, ip, sizeof(ip) - 1);
                family = 6;
            } else {
                continue;
            }

            JSValue entry = JS_NewObject(ctx);

            JS_SetPropertyStr(ctx, entry, "address", JS_NewString(ctx, ip));
            JS_SetPropertyStr(ctx, entry, "family", JS_NewInt32(ctx, family));
            JS_SetPropertyUint32(ctx, args[1], i++, entry);
        }
    }

    t2_net_call(ctx, lr->callback, 2, args);

    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, lr->callback);
    uv_freeaddrinfo(res);
    js_free(ctx, lr);
}

/* lookup(hostname, family, callback) -> [{ address, family }, ...] */
static JSValue t2_net_lookup(JSContext *ctx, JSValue this_val, int argc, JSValue *argv) {
    const char *hostname = JS_ToCString(ctx, argv[0]);

    if (!hostname) {
        return JS_EXCEPTION;
    }

    int32_t family;

    if (JS_ToInt32(ctx, &family, argv[1])) {
        JS_FreeCString(ctx, hostname);

        return JS_EXCEPTION;
    }

    t2_lookup_req_t *lr = js_mallocz(ctx, sizeof(*lr));

    if (!lr) {
        JS_FreeCString(ctx, hostname);

        return JS_EXCEPTION;
    }

    lr->ctx = ctx;
    lr->callback = JS_DupValue(ctx, argv[2]);

    struct addrinfo hints;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = family == 4 ? AF_INET : family == 6 ? AF_INET6 : AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    int r = uv_getaddrinfo(t2_net_loop(ctx), &lr->req, t2_lookup_cb, hostname, NULL, &hints);

    JS_FreeCString(ctx, hostname);

    if (r != 0) {
        JS_FreeValue(ctx, lr->callback);
        js_free(ctx, lr);

        return t2_throw_uv(ctx, r, "getaddrinfo", NULL);
    }

    return JS_UNDEFINED;
}

/* --- registration ---------------------------------------------------------- */

static const JSCFunctionListEntry t2_handle_proto[] = {
    JS_CFUNC_DEF("connect", 3, t2_handle_connect),
    JS_CFUNC_DEF("bind", 2, t2_handle_bind),
    JS_CFUNC_DEF("listen", 2, t2_handle_listen),
    JS_CFUNC_DEF("accept", 0, t2_handle_accept),
    JS_CFUNC_DEF("startRead", 1, t2_handle_start_read),
    JS_CFUNC_DEF("stopRead", 0, t2_handle_stop_read),
    JS_CFUNC_DEF("write", 2, t2_handle_write),
    JS_CFUNC_DEF("shutdown", 1, t2_handle_shutdown),
    JS_CFUNC_DEF("close", 1, t2_handle_close),
    JS_CFUNC_DEF("ref", 0, t2_handle_ref),
    JS_CFUNC_DEF("unref", 0, t2_handle_unref),
    JS_CFUNC_DEF("fileno", 0, t2_handle_fileno),
    JS_CFUNC_DEF("open", 1, t2_handle_open),
    JS_CFUNC_DEF("sockname", 1, t2_handle_sockname),
    JS_CFUNC_DEF("setNoDelay", 1, t2_handle_set_no_delay),
    JS_CFUNC_DEF("setKeepAlive", 2, t2_handle_set_keep_alive),
};

void t2_register_net(JSContext *ctx, JSValue natives) {
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &t2_handle_class_id);
    JS_NewClass(rt, t2_handle_class_id, &t2_handle_class);

    JSValue proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, proto, t2_handle_proto, T2_COUNTOF(t2_handle_proto));
    JS_SetClassProto(ctx, t2_handle_class_id, proto);

    JSValue net = JS_NewObjectProto(ctx, JS_NULL);

    JS_SetPropertyStr(ctx, net, "pipe", JS_NewCFunction(ctx, t2_new_pipe, "pipe", 0));
    JS_SetPropertyStr(ctx, net, "tcp", JS_NewCFunction(ctx, t2_new_tcp, "tcp", 0));
    JS_SetPropertyStr(ctx, net, "lookup", JS_NewCFunction(ctx, t2_net_lookup, "lookup", 3));

    JS_SetPropertyStr(ctx, natives, "net", net);
}
