// querystring
//
// Written rather than harvested: the module is small, and the npm ports
// (querystring-es3 and friends) are frozen around Node 0.x and get the
// repeated-key and maxKeys behaviour subtly wrong.
//
// Legacy by Node's own reckoning — new code should use URLSearchParams — but
// era code uses it heavily, so the behaviour here follows Node's, including
// the parts that look like bugs: `+` decodes to a space, a key with no `=`
// yields an empty-string value, and a repeated key collapses into an array.

'use strict';

function decodeComponent(value) {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
        // Node does not throw on malformed input here; it hands back the raw
        // text, and a surprising amount of era code depends on that.
        return value;
    }
}

function encodeComponent(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
        return String(value);
    }

    if (typeof value !== 'string') {
        return '';
    }

    return encodeURIComponent(value);
}

function parse(input, sep = '&', eq = '=', options = {}) {
    const result = Object.create(null);

    if (typeof input !== 'string' || input.length === 0) {
        return result;
    }

    const maxKeys = options.maxKeys === undefined ? 1000 : options.maxKeys;
    let pairs = input.split(sep);

    if (maxKeys > 0 && pairs.length > maxKeys) {
        pairs = pairs.slice(0, maxKeys);
    }

    for (const pair of pairs) {
        if (pair.length === 0) {
            continue;
        }

        const index = pair.indexOf(eq);
        const key = decodeComponent(index === -1 ? pair : pair.slice(0, index));
        const value = index === -1 ? '' : decodeComponent(pair.slice(index + eq.length));

        if (!Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = value;
        } else if (Array.isArray(result[key])) {
            result[key].push(value);
        } else {
            result[key] = [result[key], value];
        }
    }

    return result;
}

function stringify(object, sep = '&', eq = '=') {
    if (object === null || typeof object !== 'object') {
        return '';
    }

    const parts = [];

    for (const key of Object.keys(object)) {
        const encodedKey = encodeComponent(key);
        const value = object[key];

        if (Array.isArray(value)) {
            for (const entry of value) {
                parts.push(encodedKey + eq + encodeComponent(entry));
            }
        } else {
            parts.push(encodedKey + eq + encodeComponent(value));
        }
    }

    return parts.join(sep);
}

module.exports = {
    parse,
    decode: parse,
    stringify,
    encode: stringify,
    escape: encodeComponent,
    unescape: decodeComponent
};
