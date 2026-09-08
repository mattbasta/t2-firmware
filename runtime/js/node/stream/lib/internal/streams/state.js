// Provenance: readable-stream v3.6.2 (lib/internal/streams/state.js)
//   https://github.com/nodejs/readable-stream @ v3.6.2
//   License: MIT (Joyent, Inc. and other Node contributors).
//   Harvested 2026-09-08.
//   Local modifications: inherits -> util.inherits, util-deprecate -> util.deprecate, string_decoder/ -> string_decoder.
//
// After harvest this is first-party code (runtime/DEPENDENCIES.md, tier 2).

'use strict';

var ERR_INVALID_OPT_VALUE = require('../../../errors').codes.ERR_INVALID_OPT_VALUE;
function highWaterMarkFrom(options, isDuplex, duplexKey) {
  return options.highWaterMark != null ? options.highWaterMark : isDuplex ? options[duplexKey] : null;
}
function getHighWaterMark(state, options, duplexKey, isDuplex) {
  var hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
  if (hwm != null) {
    if (!(isFinite(hwm) && Math.floor(hwm) === hwm) || hwm < 0) {
      var name = isDuplex ? duplexKey : 'highWaterMark';
      throw new ERR_INVALID_OPT_VALUE(name, hwm);
    }
    return Math.floor(hwm);
  }

  // Default value
  return state.objectMode ? 16 : 16 * 1024;
}
module.exports = {
  getHighWaterMark: getHighWaterMark
};