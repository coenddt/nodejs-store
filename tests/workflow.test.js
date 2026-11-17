'use strict';

/**
 * 工作流编排单测（首批）：校验器白名单 / 占位符解析 / when 真值表 / 权限真值表 / 双宿主 parity。
 * parity 锚：py-store/tests/test_workflow.py 用同一组输入断言相同输出（逐字节一致）。
 * 运行：LOCAL_CORE=1 node --test tests/workflow.test.js
 * （LOCAL_CORE=1 走相邻 rust-store/core-node/dist 调试产物；npm 依赖 rust-store-node@2.x
 *   为旧版 core，不含 JSON 列 $set 下推——workflow e2e 需新版 core）
 *
 * D4-4 零语义拆分：Inventory 前置注册与五张 parity 用例表（GOOD / BAD_DEFS /
 * BAD_ERRORS / 占位符 / when / 权限）下沉 ../test-support/workflow-cases.js；
 * run 文档形状与 B1 注册期可规划性三例迁 workflow-planable.test.js；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workflow, schema } = require('../src');

const {
  GOOD, BAD_DEFS, BAD_ERRORS,
  RESOLVE_CTX, RESOLVE_INPUT, RESOLVE_CASES, WHEN_CASES, PERM_CASES,
} = require('../test-support/workflow-cases');

test('parity 校验器：GOOD 通过', () => {
  assert.deepEqual(workflow.validateDefn(GOOD), []);
});

test('parity 校验器：坏 defn 错误逐字节一致', () => {
  for (const [key, defn] of Object.entries(BAD_DEFS)) {
    assert.deepEqual(workflow.validateDefn(defn), BAD_ERRORS[key], key);
  }
});

test('register：破坏性 defn 拒绝 + 同形幂等 + 异形拒绝', () => {
  assert.throws(() => workflow.register(BAD_DEFS.B1_unknown_op), /WORKFLOW_UNSUPPORTED/);
  try {
    workflow.register(GOOD);
    // 同名同形重复注册幂等通过（对齐 core schema.register 的复跑语义）
    workflow.register(GOOD);
    // 同名异形显式 Err（禁止静默覆盖）
    assert.throws(() => workflow.register({ ...GOOD, description: 'changed' }), /已注册且定义不同/);
  } finally {
    workflow._workflows.delete('placeOrder');
  }
});

test('register + read 过滤（不可见与不存在同形）', () => {
  try {
    workflow.register(GOOD);
    assert.equal(workflow.get('placeOrder'), GOOD);
    assert.ok(workflow.list().includes('placeOrder'));
    assert.throws(() => workflow.get('placeOrder', { roles: ['user'] }), /未注册/);
    assert.deepEqual(workflow.list({ roles: ['user'] }), []);
    assert.throws(() => workflow.get('no-such'), /未注册/);
  } finally {
    // 清理：注册表进程内，便于重复运行（对齐 py wf._workflows.pop）
    workflow._workflows.delete('placeOrder');
  }
});

test('register：定义层门禁（Open 放行 / Closed 拒无 ctx / Closed internal 放行）', () => {
  const gate = { name: 'gateWf', steps: [{ op: 'fail', message: 'x' }] };
  try {
    // Open（缺省）：无 ctx 放行
    schema.setMetaPolicy(false, []);
    workflow.register(gate);
    workflow._workflows.delete('gateWf');

    // Closed：无 ctx → 显式 ERR_PERMISSION，且定义不写入
    schema.setMetaPolicy(true, []);
    assert.throws(() => workflow.register(gate), /ERR_PERMISSION:/);
    assert.equal(workflow._workflows.has('gateWf'), false);

    // Closed：internal 放行
    workflow.register(gate, { internal: true });
    assert.equal(workflow._workflows.has('gateWf'), true);
  } finally {
    workflow._workflows.delete('gateWf');
    schema.setMetaPolicy(false, []); // 复位，防污染后续用例
  }
});

test('parity 占位符解析（整值保类型 / dec / 内嵌 / strict 两态）', () => {
  for (const [s, strict, val, err] of RESOLVE_CASES) {
    if (err !== null) {
      assert.throws(() => workflow._resolveStr(s, RESOLVE_INPUT, RESOLVE_CTX, strict),
        (/** @type {any} */ e) => e.message === err, s);
    } else {
      assert.deepEqual(workflow._resolveStr(s, RESOLVE_INPUT, RESOLVE_CTX, strict), val, s);
    }
  }
});

test('parity when 真值表', () => {
  for (const [when, ctx, expect] of WHEN_CASES) {
    assert.equal(workflow._evalWhen(when, RESOLVE_INPUT, ctx), expect, JSON.stringify(when));
  }
  assert.throws(
    () => workflow._evalWhen({ lt: '{{a.v}}', than: 5 }, {}, { a: { v: 'x' } }),
    /操作数类型不可比/);
});

test('when 取值位三态：inv 无结果时路径取值为 null', () => {
  assert.equal(workflow._evalWhen({ exists: '{{inv._id}}', is: null }, {}, {}), true);
});

test('parity 权限真值表', () => {
  for (const [wl, ctx, expect] of PERM_CASES) {
    assert.equal(workflow._evaluate(wl, ctx), expect, JSON.stringify([wl, ctx]));
  }
});

test('run 白名单缺省回退 write（对齐 py wf._run_whitelist）', () => {
  assert.deepEqual(workflow._runWhitelist({ write: ['w1'] }), ['w1']);
  assert.deepEqual(workflow._runWhitelist({ run: ['r1'], write: ['w1'] }), ['r1']);
  assert.equal(workflow._runWhitelist({}), null);
  // 空名单 = 未配置（旧语义）：回退 write，而不是当作「显式不允许」
  assert.equal(workflow._runWhitelist({ run: [] }), null);
  assert.deepEqual(workflow._runWhitelist({ write: [] }), []);
  assert.deepEqual(workflow._runWhitelist({ run: [], write: ['w1'] }), ['w1']);
  assert.deepEqual(workflow._runWhitelist({ run: null, write: [] }), []);
});

test('空名单按未配置放行但注册期告警（可定位 workflow 名与字段）', () => {
  const { feedback } = require('../src');
  const seen = [];
  feedback.setSink((e) => seen.push(e));
  try {
    const defn = { ...GOOD, name: 'wfEmpty', read: [], write: [], run: [] };
    assert.deepEqual(workflow.validateDefn(defn), []);
  } finally {
    feedback.setSink(null);
  }
  const hit = seen.filter((e) => e.code === 'workflowWhitelistEmptyAsUnconfigured');
  assert.equal(hit.length, 3, JSON.stringify(seen));
  assert.ok(hit.every((e) => e.message.includes('wfEmpty')));
  assert.equal(workflow._evaluate([], { roles: ['user'] }), true);
  assert.deepEqual(workflow._runWhitelist({ run: [], write: ['w1'] }), ['w1']);
});

test('显式拒绝唯一入口 denyRead（空名单不再承担拒绝语义）', () => {
  const defn = { ...GOOD, name: 'wfDeny', denyRead: true };
  assert.deepEqual(workflow.validateDefn(defn), []);
  try {
    workflow.register(defn);
    assert.throws(() => workflow.get('wfDeny', { roles: ['admin'] }), /Workflow 未注册/);
    assert.deepEqual(workflow.list({ roles: ['admin'] }), []);
  } finally {
    workflow._workflows.delete('wfDeny');
  }
  assert.deepEqual(workflow.validateDefn({ ...GOOD, denyRead: 'yes' }),
    ['denyRead 须为布尔值（显式拒绝读开关，口径以 core 为准）']);
});

// ─── 内建 run 表自举 ─────────────────────────────────────────

test('内建 __workflowRun 已自举 + 形状', () => {
  assert.equal(schema.has('__workflowRun'), true);
  const mirror = schema.get('__workflowRun');
  assert.equal(mirror.idPrefix, 'wfrun');
  assert.deepEqual(mirror.write, []);
});
