'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** local 载体 e2e 临时目录：tmpDir(tag) 建 mkdtemp（前缀 nodejs-store-<prefix>-<tag>-）并登记，cleanup() 收尾统一删除（inline-agg / parity-local-memory 共用） */
function makeTmpDirs(prefix) {
  const _dirs = [];
  function tmpDir(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-${prefix}-${tag}-`));
    _dirs.push(dir);
    return dir;
  }
  function cleanup() {
    for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { tmpDir, cleanup };
}

module.exports = { makeTmpDirs };
