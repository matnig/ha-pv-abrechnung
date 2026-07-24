'use strict';

const fs = require('fs');
const path = require('path');

// Im Add-on ist /data persistent. Lokal (Dev) fällt es auf ./data zurück.
// Dynamisch ausgewertet (nicht gecacht), damit Tests DATA_DIR pro Fall setzen können.
function dataDir() {
  return process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', '..', 'data'));
}

function file(name) {
  return path.join(dataDir(), name);
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  ensureDir();
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name)); // atomar
}

module.exports = { dataDir, file, ensureDir, readJson, writeJson };
