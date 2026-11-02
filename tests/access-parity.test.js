'use strict';

/**
 * accessKeys 双端逐字节对拍（执行文档 03 §4.4）
 *
 * 三层断言：
 *   1. 两侧脚本的 `FIXTURE_JSON` 文本**逐字节相等**（含缩进/换行/键序）；
 *   2. 子进程执行 py / node 脚本，各自输出单行 JSON；
 *   3. 逐条比较 `results` 的 `JSON.stringify` 文本（`ok` / `value` / `error` 全量），
 *      拒绝路径的错误文案必须逐字一致。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/access-parity.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NODE_ROOT = path.resolve(__dirname, '..');
const PY_ROOT = path.resolve(NODE_ROOT, '..', 'py-store');
const NODE_SCRIPT = path.join(NODE_ROOT, 'scripts', 'parity_access.js');
const PY_SCRIPT = path.join(PY_ROOT, 'scripts', 'parity_access.py');

function extractFixture(file, re) {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(re);
  assert.ok(m, `未能从 ${file} 提取 FIXTURE_JSON`);
  return m[1];
}

function runJson(cmd, args, opts) {
  const out = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
  return JSON.parse(out.trim());
}

const PY_FIXTURE = /FIXTURE_JSON\s*=\s*r?"""([\s\S]*?)"""/;
const NODE_FIXTURE = /FIXTURE_JSON\s*=\s*String\.raw`([\s\S]*?)`/;

test('accessKeys 对拍：两侧 FIXTURE_JSON 逐字节一致', () => {
  assert.equal(
    extractFixture(PY_SCRIPT, PY_FIXTURE),
    extractFixture(NODE_SCRIPT, NODE_FIXTURE),
    'py / node 的 FIXTURE_JSON 出现字节差异（缩进/换行/键序必须一致）',
  );
});

test('accessKeys 对拍：py / node 结果逐条一致（含拒绝路径）', () => {
  const py = runJson('python', [PY_SCRIPT], {
    cwd: PY_ROOT,
    env: {
      ...process.env,
      LOCAL_CORE: '1',
      PYTHONPATH: path.join(PY_ROOT, 'src'),
    },
  });
  const node = runJson(process.execPath, [NODE_SCRIPT], {
    cwd: NODE_ROOT,
    env: { ...process.env, LOCAL_CORE: '1' },
  });

  assert.equal(py.results.length, node.results.length, '两侧用例数不一致');
  for (let i = 0; i < py.results.length; i += 1) {
    const a = JSON.stringify(py.results[i]);
    const b = JSON.stringify(node.results[i]);
    assert.equal(b, a, `用例 ${py.results[i].name} 两侧输出不一致\npy:   ${a}\nnode: ${b}`);
  }
});
