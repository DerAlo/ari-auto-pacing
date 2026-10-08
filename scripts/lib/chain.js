'use strict';
// The status line that was configured before setup ("chain"). It lives in its own state
// file, not in config.json: users edit config.json by hand and often replace it with an
// example, which silently dropped the previous status line (and made uninstall delete it).
// 1.0.0 stored it as config.json "chain"; that is still read as a fallback.
const fs = require('fs');
const path = require('path');
const { pacerHome, readJson, writeJsonAtomic } = require('./util');
const { readUserConfigStrict } = require('./config');

function chainFile() {
  return path.join(pacerHome(), 'chain.json');
}

function validChain(c) {
  return c !== null && typeof c === 'object' && !Array.isArray(c) && typeof c.command === 'string' && c.command.trim() !== '';
}

// { chain, source } or null.
function readChain() {
  const s = readJson(chainFile(), null);
  if (s && validChain(s.chain)) return { chain: s.chain, source: 'chain.json' };
  const legacy = readUserConfigStrict();
  if (legacy.ok && validChain(legacy.config.chain)) return { chain: legacy.config.chain, source: 'config.json' };
  return null;
}

function writeChain(chain) {
  writeJsonAtomic(chainFile(), { chain });
}

function clearChain() {
  try { fs.rmSync(chainFile(), { force: true }); } catch { /* best effort */ }
}

module.exports = { chainFile, readChain, writeChain, clearChain, validChain };
