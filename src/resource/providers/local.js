'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 本地目录 provider；key 相对 baseDir 解析 */
function create(options = {}) {
  const root = path.resolve(options.baseDir || '.resource-store');
  // 唯一路径拼装点（红线）：key 相对 root 归一化，越出 root（绝对路径 / `..` 段）⇒ 抛错，
  // 防穿越读写删任意文件（对照 src/local/store.js `_dirFor` 同类防护）。
  // 正常 key 为 `objects/<xx>/<sha1>` 子目录形态（core.resourceContentPath 生成），放行。
  const full = (key) => {
    const p = path.resolve(root, key);
    // 归一化后必须是 root 下的子路径（root 本体亦非法——它不是文件）
    if (!p.startsWith(root + path.sep)) {
      throw new Error(`ERR:RESOURCE key 越界（越出 baseDir）: ${key}`);
    }
    return p;
  };
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
      // 越界校验在 try 外显式抛出（不得被下方 not-found → false 吞掉，禁静默失守）
      const p = full(key);
      try { await fs.access(p); return true; } catch { return false; }
    },
  };
}

module.exports = { create };
