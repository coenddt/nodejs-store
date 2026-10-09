'use strict';

/**
 * A6 双端作用域对拍（R2 03 §5 步骤 6）—— node 侧驱动测试。
 *
 *   1. 两侧脚本内嵌的 `FIXTURE_JSON` 文本**逐字一致**（禁各写一份用例定义）；
 *   2. `node scripts/parity-scope.js` 输出单行合法 JSON（node 自身合法，不依赖 py 仓），
 *      且快照有判别力（档位 / rbac 判决 / 非法覆盖拒绝文案均随视图变化——防「空对拍」假绿）；
 *   3. node 与 py 两侧输出**逐字节相等**（py 仓缺失 / 本机无 python → `t.skip` 显式跳过，
 *      禁静默通过）。
 *
 * 注意：子进程按宿主环境加载 rust core（开发期需 `LOCAL_CORE=1`；默认绑定为旧版、无
 * `withPolicy`，脚本会以 `ERR:` 前缀显式失守——不静默降级）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const NODE_SCRIPT = path.join(__dirname, '..', 'scripts', 'parity-scope.js');
const PY_SCRIPT = path.join(__dirname, '..', '..', 'py-store', 'scripts', 'parity_scope.py');

function runNode() {
  return execFileSync(process.execPath, [NODE_SCRIPT], { encoding: 'utf8' });
}

function hasPython() {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function runPy() {
  return execFileSync('python', [PY_SCRIPT], { encoding: 'utf8' });
}

function snapshotOf(parsed, viewName) {
  const found = parsed.views.find((v) => v.view === viewName);
  assert.ok(found, `fixture 视图缺失: ${viewName}`);
  return found.snapshot;
}

test('两侧脚本共用同一份 fixture（逐字一致）', (t) => {
  if (!fs.existsSync(PY_SCRIPT)) {
    t.skip('相邻 py-store 仓缺失，跳过 fixture 一致性断言');
    return;
  }
  const nodeM = fs.readFileSync(NODE_SCRIPT, 'utf8').match(/const FIXTURE_JSON = `([\s\S]*?)`;/);
  const pyM = fs.readFileSync(PY_SCRIPT, 'utf8').match(/FIXTURE_JSON = """([\s\S]*?)"""/);
  assert.ok(nodeM, 'node 侧 FIXTURE_JSON 提取失败');
  assert.ok(pyM, 'py 侧 FIXTURE_JSON 提取失败');
  assert.strictEqual(nodeM[1], pyM[1], '两侧 fixture 文本不一致（禁各写一份用例定义）');
});

test('node 侧对拍输出单行合法 JSON 且快照有判别力（自身合法，不依赖 py 仓）', () => {
  const out = runNode();
  assert.ok(!out.startsWith('ERR:'), `node 侧不得以错误输出结束（开发期须 LOCAL_CORE=1）: ${out}`);
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 1, 'node 侧必须输出单行 JSON');
  const parsed = JSON.parse(lines[0]);

  assert.deepStrictEqual(parsed.views.map((v) => v.view), [
    'standard', 'text2query', 'rbacGranted', 'rbacDenied', 'locked',
  ]);

  // 判别力①：档位随视图变化
  assert.strictEqual(snapshotOf(parsed, 'standard').profile, 'standard');
  assert.strictEqual(snapshotOf(parsed, 'text2query').profile, 'text2query');

  // 判别力②：rbac 判决随视图变化（同一 ctx）
  assert.deepStrictEqual(snapshotOf(parsed, 'rbacGranted')['rbac:ScopePost:read:viewer'], { ok: true, value: true });
  assert.deepStrictEqual(snapshotOf(parsed, 'rbacDenied')['rbac:ScopePost:read:viewer'], { ok: true, value: false });

  // 判别力③：三开关视图（requireContext + unconfigured closed）确实拦截
  const locked = snapshotOf(parsed, 'locked');
  assert.strictEqual(locked['plan:condition:viewer'].ok, false, 'closed 策略下无授权模型须被拦');
  assert.ok(locked['plan:condition:viewer'].error.startsWith('ERR_'), JSON.stringify(locked['plan:condition:viewer']));

  // 判别力④：plan 为规范化 JSON 文本（非空命令）
  const plan = JSON.parse(snapshotOf(parsed, 'standard')['plan:condition:viewer'].value);
  assert.ok(['find', 'aggregate'].includes(plan.mode) && plan.commands.length > 0, JSON.stringify(plan));

  // 判别力⑤：非法覆盖逐条被拒，文案原文非空
  assert.deepStrictEqual(parsed.badViews.map((b) => b.view), [
    'unknownKey', 'badProfile', 'unknownRoleRule', 'unknownMetaPolicy', 'notObject',
  ]);
  for (const b of parsed.badViews) {
    assert.strictEqual(b.ok, false, `${b.view} 应被拒（禁静默派生）`);
    assert.ok(b.error, `${b.view} 拒绝文案不得为空`);
  }

  // 域外零变更：作用域前后 base 快照逐字段一致
  assert.deepStrictEqual(parsed.base, parsed.baseAfter, '各视图退出后 base 须零变更');
});

test('作用域快照与 py 端逐字节一致', (t) => {
  if (!fs.existsSync(PY_SCRIPT)) {
    t.skip('相邻 py-store 仓缺失，跳过对拍');
    return;
  }
  if (!hasPython()) {
    t.skip('本机无 python，跳过对拍');
    return;
  }
  const nodeOut = runNode().trim();
  const pyOut = runPy().trim();
  assert.ok(!nodeOut.startsWith('ERR:'), `node 侧不得以错误输出对拍: ${nodeOut}`);
  assert.ok(!pyOut.startsWith('ERR:'), `py 侧不得以错误输出对拍: ${pyOut}`);
  assert.strictEqual(
    nodeOut,
    pyOut,
    `双端快照不一致（node ${nodeOut.length} 字节 / py ${pyOut.length} 字节）`,
  );
});
