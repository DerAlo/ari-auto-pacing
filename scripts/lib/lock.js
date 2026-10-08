'use strict';
// mkdir is atomic on every platform Node supports, so a directory works as a mutex.
// If the lock cannot be taken in time we run anyway (fail-open): a rare double count
// is better than a hook that stalls Claude Code.
const fs = require('fs');
const path = require('path');
const { ensureDir, sleepMs } = require('./util');

function withLock(lockPath, fn, { waitMs = 1500, staleMs = 5000 } = {}) {
  const started = Date.now();
  let acquired = false;
  try { ensureDir(path.dirname(lockPath)); } catch { /* fall through */ }
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch { /* lock vanished between calls: retry */ }
      if (Date.now() - started > waitMs) break;
      sleepMs(5 + Math.random() * 15);
    }
  }
  try {
    return fn(acquired);
  } finally {
    if (acquired) {
      try { fs.rmdirSync(lockPath); } catch { /* ignore */ }
    }
  }
}

module.exports = { withLock };
