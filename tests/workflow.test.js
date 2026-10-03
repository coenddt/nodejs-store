'use strict';

/**
 * 工作流编排单测（首批）：校验器白名单 / 占位符解析 / when 真值表 / 权限真值表 / 双宿主 parity。
 * parity 锚：py-store/tests/test_workflow.py 用同一组输入断言相同输出（逐字节一致）。
 * 运行：LOCAL_CORE=1 node --test tests/workflow.test.js
 * （LOCAL_CORE=1 走相邻 rust-store/core-node/dist 调试产物；npm 依赖 rust-store-node@2.x
 *   为旧版 core，不含 JSON 列 $set 下推——workflow e2e 需新版 core）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workflow, schema } = require('../src');

const GOOD = {
  name: 'placeOrder',
  read: ['admin', 'ops'],
  write: ['admin'],
  run: ['admin', 'ops', 'seller'],
  steps: [
    { op: 'query', as: 'inv',
      gql: 'Inventory($condition:@c0){_id, stock}',
      params: { c0: { productId: '{{input.productId}}', warehouse: '{{input.warehouse}}' } } },
    { op: 'fail', when: { exists: '{{inv._id}}', is: null }, message: '库存记录不存在' },
    { op: 'fail', when: { lt: '{{inv.stock}}', than: '{{input.qty}}' }, message: '库存不足' },
    { op: 'mutation', model: 'Inventory',
      data: { _id: '{{inv._id}}', stock: '{{dec:{{inv.stock}},{{input.qty}}}}' } },
  ],
};

// ─── parity 锚：校验器（与 py-store/tests/test_workflow.py 同输入同输出） ──

const BAD_DEFS = {
  B1_unknown_op: { ...GOOD, steps: [{ op: 'loop' }] },
  B2_backward_ref: { ...GOOD, steps: [
    { op: 'mutation', as: 'm1', model: 'Inventory', data: { stock: '{{m2._id}}' } },
    { op: 'mutation', as: 'm2', model: 'Inventory', data: { stock: 1 } }] },
  B3_dangling_as: { ...GOOD, steps: [
    { op: 'mutation', model: 'Inventory', data: { stock: '{{ghost._id}}' } }] },
  B4_dec_shape: { ...GOOD, steps: [
    { op: 'mutation', model: 'Inventory', data: { stock: '{{dec:{{inv.stock}}}}' } }] },
  B5_gql_ph: { ...GOOD, steps: [
    { op: 'query', as: 'inv',
      gql: 'Inventory($condition:@c0){_id, {{input.field}}}',
      params: { c0: { w: '{{input.warehouse}}' } } }] },
  B13_self_ref: { ...GOOD, steps: [
    { op: 'query', as: 'inv', gql: 'Inventory{_id}',
      params: { c0: { _id: '{{inv._id}}' } } }] },
  B6_upsert_no_match: { ...GOOD, steps: [
    { op: 'mutation', model: 'Inventory', upsert: true, data: { stock: 1 } }] },
  B7_when_shape: { ...GOOD, steps: [
    { op: 'fail', when: { lt: '{{input.qty}}' }, message: 'x' }] },
  B8_dunder_name: { ...GOOD, name: '__mine' },
  B9_unknown_top: { ...GOOD, retry: 3 },
  B10_dup_as: { ...GOOD, steps: [
    { op: 'query', as: 'inv', gql: 'Inventory{_id}' },
    { op: 'query', as: 'inv', gql: 'Inventory{_id}' }] },
  B11_index_path: { ...GOOD, steps: [
    { op: 'mutation', model: 'Inventory', data: { stock: '{{input.items.0.id}}' } }] },
  B12_missing_required: { ...GOOD, steps: [{ op: 'query', gql: 'Inventory{_id}' }] },
};

const BAD_ERRORS = {
  B1_unknown_op: [
    'steps[0]: WORKFLOW_UNSUPPORTED 未知步骤类型 "loop"'
    + '（首批白名单: ["query","mutation","fail"]；循环/并行/子工作流/审批节点均不支持）'],
  B2_backward_ref: [
    'steps[0]: 占位符 {{m2._id}} 引用了不存在的 as "m2"'
    + '（前向可用: 无；后向引用不支持）'],
  B3_dangling_as: [
    'steps[0]: 占位符 {{ghost._id}} 引用了不存在的 as "ghost"'
    + '（前向可用: 无；后向引用不支持）'],
  B4_dec_shape: [
    'steps[0]: 占位符 {{dec:{{inv.stock}}}} dec 须恰两个操作数 dec:<a>,<b>'],
  B5_gql_ph: [
    'steps[0]: gql 内嵌占位符不支持（注入面）；动态参数请走 params 绑定'],
  B13_self_ref: [
    'steps[0]: 占位符 {{inv._id}} 引用了不存在的 as "inv"'
    + '（前向可用: 无；后向引用不支持）'],
  B6_upsert_no_match: ['steps[0]: upsert: true 须提供 match 条件'],
  B7_when_shape: ['steps[0].when: lt 算子缺少右值键 "than"'],
  B8_dunder_name: ['name "__mine" 以 __ 开头（前缀保留给内建 schema，禁止用于工作流）'],
  B9_unknown_top: [
    '未知顶层字段 "retry"（白名单: ["description","name","read","run","steps","write"]）'],
  B10_dup_as: ['steps[1]: as "inv" 重复（引用歧义，禁止覆盖）'],
  B11_index_path: [
    'steps[0]: 占位符 {{input.items.0.id}} 路径非法'
    + '（首批不支持数组下标段，需要逐行处理请走宿主代码编排）'],
  B12_missing_required: ['steps[0]: query 步骤缺少必填字段 "as"'],
};

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

// ─── parity 锚：占位符解析 ───────────────────────────────────

const RESOLVE_CTX = { inv: { _id: 'inv1', stock: 100 } };
const RESOLVE_INPUT = { qty: 30, user: { name: '张三' }, items: [{ id: 'i0' }] };
// 每条: [expr, strict, val, err]——val/err 二选一（err 非 null 即期望报错文案）
const RESOLVE_CASES = [
  ['{{input.qty}}', false, 30, null],
  ['{{input.user.name}}', false, '张三', null],
  ['{{inv._id}}', false, 'inv1', null],
  ['{{dec:{{inv.stock}},{{input.qty}}}}', false, 70, null],
  ['{{dec:10,4}}', false, 6, null],
  ['n={{input.qty}}', false, 'n=30', null],
  ['{{inv.missing}}', true, null, '占位符 {{inv.missing}} 解析失败: 路径 "missing" 不存在'],
  ['{{ghost.x}}', true, null,
    '占位符 {{ghost.x}} 引用的 as "ghost" 无可用结果（该步骤可能被 when 跳过或尚未执行）'],
  ['{{inv.missing}}', false, null, null],
  ['{{input.items.0.id}}', true, null, '占位符 {{input.items.0.id}} 解析失败: 路径 "items.0.id" 不存在'],
  ['{{dec:{{input.user}},1}}', true, null,
    '占位符 {{dec:{{input.user}},1}} dec 操作数 a 须为数值，收到 dict'],
  ['{{input.qty}}', true, 30, null],
];

test('parity 占位符解析（整值保类型 / dec / 内嵌 / strict 两态）', () => {
  for (const [s, strict, val, err] of RESOLVE_CASES) {
    if (err !== null) {
      assert.throws(() => workflow._resolveStr(s, RESOLVE_INPUT, RESOLVE_CTX, strict),
        (e) => e.message === err, s);
    } else {
      assert.deepEqual(workflow._resolveStr(s, RESOLVE_INPUT, RESOLVE_CTX, strict), val, s);
    }
  }
});

// ─── parity 锚：when 真值表 ──────────────────────────────────

const WHEN_CASES = [
  [{ exists: '{{inv._id}}', is: null }, { inv: { _id: 'x' } }, false],
  [{ exists: '{{inv._id}}' }, { inv: { _id: 'x' } }, true],
  [{ lt: '{{inv.stock}}', than: 10 }, { inv: { stock: 5 } }, true],
  [{ lt: '{{inv.stock}}', than: 10 }, { inv: { stock: 15 } }, false],
  [{ is: '{{a.v}}', than: 5 }, { a: { v: 5 } }, true],
  [{ ne: '{{a.v}}', than: 5 }, { a: { v: 5 } }, false],
  [{ lte: '{{a.v}}', than: 5.5 }, { a: { v: 5.5 } }, true],
  [{ gte: '{{a.v}}', than: 6 }, { a: { v: 5.5 } }, false],
  [{ gt: '{{a.v}}', than: '{{b.v}}' }, { a: { v: 5 }, b: { v: 3 } }, true],
  [{ eq: '{{a.v}}', than: 5 }, { a: { v: 5 } }, true],
];

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

// ─── parity 锚：权限真值表 ───────────────────────────────────

const PERM_CASES = [
  [null, null, true],
  [null, { roles: ['guest'] }, false],
  [null, { roles: ['user'] }, true],
  [['ops'], null, true],
  [['ops'], { roles: ['ops'] }, true],
  [['ops'], { roles: ['user'] }, false],
  [['ops'], { roles: ['user', 'ops'] }, true],
  [['ops'], { roles: ['admin'] }, true],
  [['ops'], { roles: ['super_admin'] }, true],
  [['ops'], { roles: ['guest'] }, false],
  [['ops'], { internal: true, roles: ['guest'] }, true],
  [['creator'], { userId: 'u1' }, true],
  [['ops'], { roles: [], role: 'ops' }, true],
];

test('parity 权限真值表', () => {
  for (const [wl, ctx, expect] of PERM_CASES) {
    assert.equal(workflow._evaluate(wl, ctx), expect, JSON.stringify([wl, ctx]));
  }
});

test('run 白名单缺省回退 write（对齐 py wf._run_whitelist）', () => {
  assert.deepEqual(workflow._runWhitelist({ write: ['w1'] }), ['w1']);
  assert.deepEqual(workflow._runWhitelist({ run: ['r1'], write: ['w1'] }), ['r1']);
  assert.equal(workflow._runWhitelist({}), null);
});

// ─── 内建 run 表自举 ─────────────────────────────────────────

test('内建 __workflowRun 已自举 + 形状', () => {
  assert.equal(schema.has('__workflowRun'), true);
  const mirror = schema.get('__workflowRun');
  assert.equal(mirror.idPrefix, 'wfrun');
  assert.deepEqual(mirror.write, []);
});


// ─── parity 锚：run 文档与步骤迹形状（双宿主逐字段一致） ─────────

test('parity run 文档形状（keys 与迹条目形状）', async () => {
  const Database = require('better-sqlite3');
  const { init, store, schema, executors, permission, ddl } = require('../src');
  schema.register({ name: 'ShapeItem', collection: 'shape_items', idPrefix: 'sh',
    fields: { _id: { type: 'string' }, n: { type: 'int' } } });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE shape_items (_id VARCHAR(64) PRIMARY KEY, n INTEGER, '
    + 'createdAt BIGINT, updatedAt BIGINT, deletedAt BIGINT, __present TEXT)');
  for (const st of String(ddl.generate('sqlite', ['__workflowRun'])).split('\n\n')) {
    if (st.trim()) db.exec(st);
  }
  await init({ default: executors.createConnection('sqlite', db) });
  permission.setContext({ userId: 'u1', roles: ['admin'] });
  await store.insert('ShapeItem', { _id: 'sh1', n: 5 });
  workflow.register({ name: 'shapeWf', steps: [
    { op: 'query', as: 'it', gql: 'ShapeItem{_id, n}' },
    { op: 'fail', when: { lt: '{{it.n}}', than: 0 }, message: 'neg' },
    { op: 'mutation', as: 'w', model: 'ShapeItem', data: { n: 1 } },
  ] });
  try {
    const runDoc = await store.runWorkflow('shapeWf', {});
    assert.deepEqual(Object.keys(runDoc).sort(),
      ['_id', 'createdAt', 'dryRun', 'error', 'input',
        'now', 'status', 'stepIndex', 'steps', 'updatedAt', 'workflow']);
    assert.equal(runDoc.status, 'succeeded');
    assert.equal(runDoc.error, null);
    assert.deepEqual(runDoc.steps.map((st) => st.state), ['ran', 'skipped', 'ran']);
    assert.deepEqual(Object.keys(runDoc.steps[0]).sort(), ['as', 'op', 'result', 'state']);
    assert.deepEqual(Object.keys(runDoc.steps[1]).sort(), ['as', 'op', 'state']);
  } finally {
    workflow._workflows.delete('shapeWf');
    db.close();
  }
});
