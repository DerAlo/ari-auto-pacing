'use strict';
// Entry point for `node --test test/`: Node 22 treats a directory argument as a module
// path, so it loads this file, which registers every unit test file in one process.
// `npm test` (node --test "test/*.test.js") runs the same files in parallel processes.
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}
