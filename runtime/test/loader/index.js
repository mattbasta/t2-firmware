// CommonJS loader conformance.
//
// Runs from inside its own fixture tree on purpose: bare specifiers resolve
// against the directory of the module doing the require, so the node_modules
// walk can only be exercised from a module that actually lives here.

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

// paths
eq(require('./lib/a'), 'a', 'relative, extensionless');
eq(require('./lib/a.js'), 'a', 'relative, explicit .js');
eq(require('./lib/b.json').v, 2, 'json');
eq(require('./lib/dirmain'), 'dirmain', 'directory package.json main');
eq(require('./lib/dirindex'), 'dirindex', 'directory index.js');

// node_modules
eq(require('plain'), 'plain', 'node_modules index');
eq(require('withmain'), 'withmain', 'node_modules package.json main');
eq(require('@scope/pkg'), 'scoped', 'scoped package');
eq(require('./sub/uses'), 'inner', 'node_modules walk from a subdirectory');

// exports maps
eq(require('exp'), 'exp-main', 'exports "."');
eq(require('exp/sub'), 'exp-sub', 'exports subpath');
eq(require('exp/glob/x'), 'exp-glob', 'exports pattern');
eq(require('cond'), 'cond-require', 'exports: require condition beats default');

try {
    require('exp/hidden');
    fail++;
    console.log('FAIL exports gate let an unexported file through');
} catch (err) {
    eq(err.code, 'MODULE_NOT_FOUND', 'exports gate blocks an unexported file');
}

// cycles — one.js requires two.js midway through its own evaluation
eq(require('./cyc/one').done, true, 'circular dependency completes');
eq(require('./cyc/two').sawPartial, true, 'circular dependency sees partial exports');

// cache
eq(require('./lib/a') === require('./lib/a'), true, 'cache returns the same exports');
eq(typeof require.cache[require.resolve('./lib/a')], 'object', 'require.cache keyed by resolved path');
eq(require.resolve('./lib/a').endsWith('/lib/a.js'), true, 'require.resolve');

// module metadata
eq(__filename.endsWith('/loader/index.js'), true, '__filename');
eq(__dirname.endsWith('/loader'), true, '__dirname');
eq(module.id, '.', 'main module id is "."');
eq(require.main === module, true, 'require.main');
eq(process.mainModule === module, true, 'process.mainModule is set before the main module runs');

// core modules
eq(typeof require('path').join, 'function', 'core: path');
eq(typeof require('node:path').join, 'function', 'core: node: prefix');
eq(require('buffer').Buffer === Buffer, true, 'core: buffer');

// A core module that is named but not yet built must say so, distinguishably
// from one that does not exist. Track this to whatever is still pending: fs
// moved out of this slot in Phase 2, and net will move out of it too.
try {
    require('net');
    fail++;
    console.log('FAIL unimplemented core module did not throw');
} catch (err) {
    eq(err.code, 'ERR_MODULE_NOT_IMPLEMENTED', 'unimplemented core module is distinguishable');
}

eq(typeof require('fs').readFileSync, 'function', 'core: fs');

try {
    require('./nope');
    fail++;
    console.log('FAIL missing relative module did not throw');
} catch (err) {
    eq(err.code, 'MODULE_NOT_FOUND', 'missing relative module');
}

console.log(fail === 0 ? 'LOADER: all pass' : `LOADER: ${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
