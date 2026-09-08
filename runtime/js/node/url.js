// url
//
// The WHATWG half is inherited: this runtime already has a spec URL and
// URLSearchParams, backed by ada in C. What is written here is the *legacy*
// half — url.parse/format/resolve — which era code uses almost exclusively and
// which no modern source still carries.
//
// Legacy parse cannot be expressed in terms of the WHATWG parser: it accepts
// relative references, protocol-relative URLs, and plenty of input the spec
// parser rejects outright, and it is expected to return a plain object with a
// documented shape rather than throw.

'use strict';

const querystring = require('querystring');

// protocol, slashes, auth, host, path, search, hash
const URL_PATTERN = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*:))?(\/\/)?(?:([^/?#@]*)@)?([^/?#]*)?([^?#]*)?(\?[^#]*)?(#.*)?$/;

class Url {
    constructor() {
        this.protocol = null;
        this.slashes = null;
        this.auth = null;
        this.host = null;
        this.port = null;
        this.hostname = null;
        this.hash = null;
        this.search = null;
        this.query = null;
        this.pathname = null;
        this.path = null;
        this.href = null;
    }

    format() {
        return format(this);
    }
}

function parse(urlString, parseQueryString = false, slashesDenoteHost = false) {
    const url = new Url();

    if (typeof urlString !== 'string') {
        throw new TypeError(`Parameter "url" must be a string, not ${typeof urlString}`);
    }

    const input = urlString.trim();
    const match = URL_PATTERN.exec(input);

    if (!match) {
        url.href = input;
        url.pathname = input;
        url.path = input;

        return url;
    }

    const [, protocol, slashes, auth, hostPart, pathname, search, hash] = match;

    url.protocol = protocol ? protocol.toLowerCase() : null;
    url.slashes = slashes ? true : null;
    url.auth = auth ? decodeURIComponent(auth) : null;

    // Without slashes there is no authority — what looked like a host is the
    // first path segment. `mailto:x@y` and `foo/bar` both land here.
    const hasAuthority = Boolean(slashes) || (slashesDenoteHost && Boolean(auth));

    if (hasAuthority && hostPart) {
        url.host = hostPart.toLowerCase();

        // Bracketed IPv6 literals keep their brackets in hostname.
        const portMatch = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hostPart);

        if (portMatch) {
            url.hostname = portMatch[1].toLowerCase();
            url.port = portMatch[2] ? portMatch[2] : null;
        } else {
            url.hostname = url.host;
        }
    }

    let pathValue = pathname || '';

    if (!hasAuthority && hostPart) {
        pathValue = hostPart + pathValue;
    }

    url.pathname = pathValue || (url.host ? '/' : null);
    url.search = search || null;
    url.hash = hash || null;
    url.query = parseQueryString
        ? querystring.parse(search ? search.slice(1) : '')
        : (search ? search.slice(1) : null);

    url.path = url.pathname ? url.pathname + (url.search || '') : (url.search || null);
    url.href = format(url);

    return url;
}

function format(urlObject) {
    if (typeof urlObject === 'string') {
        return format(parse(urlObject));
    }

    if (urlObject instanceof URL) {
        return urlObject.href;
    }

    const protocol = urlObject.protocol
        ? (urlObject.protocol.endsWith(':') ? urlObject.protocol : `${urlObject.protocol}:`)
        : '';

    const host = urlObject.host ||
        (urlObject.hostname
            ? urlObject.hostname + (urlObject.port ? `:${urlObject.port}` : '')
            : '');

    // Node emits the // when slashes is set, or whenever there is a host and a
    // protocol that is not one of the known slash-less ones.
    const slashes = urlObject.slashes || (host && protocol !== 'mailto:') ? '//' : '';
    const auth = urlObject.auth ? `${encodeURIComponent(urlObject.auth).replace(/%3A/i, ':')}@` : '';
    const pathname = urlObject.pathname || '';

    let search = urlObject.search || '';

    if (!search && urlObject.query && typeof urlObject.query === 'object') {
        const encoded = querystring.stringify(urlObject.query);

        search = encoded ? `?${encoded}` : '';
    }

    if (search && !search.startsWith('?')) {
        search = `?${search}`;
    }

    let hash = urlObject.hash || '';

    if (hash && !hash.startsWith('#')) {
        hash = `#${hash}`;
    }

    return protocol + slashes + auth + host + pathname + search + hash;
}

function resolve(from, to) {
    // The WHATWG parser already implements reference resolution correctly, so
    // use it whenever the base is absolute and fall back only when it is not.
    try {
        return new URL(to, from).href;
    } catch {
        const base = parse(from);
        const target = parse(to);

        if (target.protocol || target.host) {
            return format(target);
        }

        if (to.startsWith('/')) {
            base.pathname = to;
        } else {
            const dir = (base.pathname || '/').replace(/[^/]*$/, '');

            base.pathname = dir + to;
        }

        base.search = target.search;
        base.hash = target.hash;
        base.path = null;
        base.href = null;

        return format(base);
    }
}

function fileURLToPath(url) {
    const parsed = typeof url === 'string' ? new URL(url) : url;

    if (parsed.protocol !== 'file:') {
        const err = new TypeError('The URL must be of scheme file');

        err.code = 'ERR_INVALID_URL_SCHEME';

        throw err;
    }

    return decodeURIComponent(parsed.pathname);
}

function pathToFileURL(path) {
    return new URL(`file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`);
}

module.exports = {
    parse,
    format,
    resolve,
    Url,
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    domainToASCII: domain => {
        try {
            return new URL(`http://${domain}`).hostname;
        } catch {
            return '';
        }
    },
    domainToUnicode: () => ''
};
