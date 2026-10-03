'use strict';

/**
 * A6 双端拒绝文案对拍：node 与 py 脚本输出须逐字节一致。
 * 相邻 `py-store` 仓缺失时显式 skip（不得静默通过）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PY_SCRIPT = path.join(__dirname, '..', '..', 'py-store', 'scripts', 'parity_deny.py');

test('拒绝文案与 py 端逐字节一致', (t) => {
  if (!fs.existsSync(PY_SCRIPT)) {
    t.skip('相邻 py-store 仓缺失，跳过对拍');
    return;
  }
  const nodeOut = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'parity-deny.js')]).toString().trim();
  const pyOut = execFileSync('python', [PY_SCRIPT]).toString().trim();
  assert.strictEqual(nodeOut, pyOut, `node=${JSON.stringify(nodeOut)} py=${JSON.stringify(pyOut)}`);
  assert.notStrictEqual(nodeOut, 'OK');
});
