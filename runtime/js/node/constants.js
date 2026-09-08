// node:constants — the legacy flat constant table.
//
// Deprecated in Node 6 (DEP0008) and still shipped in Node 26, because a decade
// of packages import it; graceful-fs is the one that made it necessary here.
// Node's version is the union of os.constants and fs.constants in one flat
// object, which is what runtime/src/constants.c produces — read from the
// target's headers, since errno numbers differ between platforms.

'use strict';

module.exports = __native.constants;
