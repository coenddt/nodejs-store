'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 本地目录 provider；key 相对 baseDir 解析 */
function create(options = {}) {
  const root = path.resolve(options.baseDir || '.resource-store');
  const full = (key) => path.join(root, key);
  return {
    kind: options.kind || 'local',
    async put(key, bytes) {
      const p = full(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, bytes);
    },
    async get(key) { return fs.readFile(full(key)); },
    async remove(key) { await fs.rm(full(key), { force: true }); },
    async exists(key) {
      try { await fs.access(full(key)); return true; } catch { return false; }
    },
  };
}

module.exports = { create };
