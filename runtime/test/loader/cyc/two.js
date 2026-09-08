const one = require('./one.js');

// Observed while one.js is still mid-evaluation.
exports.sawPartial = one.done === undefined && one.name === 'one';
