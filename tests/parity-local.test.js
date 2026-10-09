'use strict';

/**
 * 本地磁盘数据源 双端对拍（A6）—— node 侧驱动测试
 *
 *   1. 两侧脚本内嵌的 FIXTURE_JSON 文本**逐字一致**（禁各写一份场景定义）；
 *   2. `node scripts/parity-local.js` 输出单行合法 JSON、无 `ERR:`（node 自身合法，不依赖 py 仓）；
 *   3. node 与 py 两侧输出**逐字节相等**（py 仓缺失 → `t.skip` 显式跳过，禁静默通过）。
 *
 * 对拍失败时断言 message 打出双方原文（对齐 parity-deny.test.js 范式，便于逐场景定位）。
 * 注意：子进程按宿主环境加载 rust core（开发期需 LOCAL_CORE=1；发版后走正式依赖）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NODE_SCRIPT = path.join(__dirname, '..', 'scripts', 'parity-local.js');
const PY_SCRIPT = path.join(__dirname, '..', '..', 'py-store', 'scripts', 'parity_local.py');

test('两侧脚本共用同一份 fixture（逐字一致）', (t) => {
  if (!fs.existsSync(PY_SCRIPT)) {
    t.skip('相邻 py-store 仓缺失，跳过 fixture 一致性断言');
    return;
  }
  const nodeText = fs.readFileSync(NODE_SCRIPT, 'utf8');
  const pyText = fs.readFileSync(PY_SCRIPT, 'utf8');
  const nodeM = nodeText.match(/const FIXTURE_JSON = `([\s\S]*?)`;/);
  const pyM = pyText.match(/FIXTURE_JSON = """([\s\S]*?)"""/);
  assert.ok(nodeM, 'node 侧 FIXTURE_JSON 提取失败');
  assert.ok(pyM, 'py 侧 FIXTURE_JSON 提取失败');
  assert.strictEqual(nodeM[1], pyM[1], '两侧 fixture 文本不一致（禁各写一份场景定义）');
});

test('node 侧对拍输出单行合法 JSON（自身合法，不依赖 py 仓）', () => {
  const out = execFileSync(process.execPath, [NODE_SCRIPT], { encoding: 'utf8' });
  assert.ok(!out.startsWith('ERR:'), `node 侧不得以错误输出结束: ${out}`);
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 1, 'node 侧必须输出单行 JSON');
  const parsed = JSON.parse(lines[0]);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, 'node 侧输出必须是非空 JSON 数组');
});

test('local 数据源双端逐字节一致', (t) => {
  if (!fs.existsSync(PY_SCRIPT)) {
    t.skip('相邻 py-store 仓缺失，跳过对拍');
    return;
  }
  const nodeOut = execFileSync(process.execPath, [NODE_SCRIPT], { encoding: 'utf8' }).trim();
  const pyOut = execFileSync('python', [PY_SCRIPT], {
    cwd: path.join(__dirname, '..', '..', 'py-store'),
    encoding: 'utf8',
  }).trim();
  assert.ok(!nodeOut.startsWith('ERR:'), `node 侧不得以错误输出对拍: ${nodeOut}`);
  assert.ok(!pyOut.startsWith('ERR:'), `py 侧不得以错误输出对拍: ${pyOut}`);
  assert.strictEqual(nodeOut, pyOut, `\nnode=${nodeOut}\npy  =${pyOut}`);
});
