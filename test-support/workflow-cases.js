'use strict';

/**
 * 工作流编排测试共用用例数据（D4-4 零语义拆分）。
 *
 * 自 tests/workflow.test.js 原样下沉：Inventory 前置注册、GOOD 正例、损坏 defn 与
 * 逐字节一致的错误文案锚、占位符解析 / when / 权限三张真值表 —— 均与
 * py-store/tests/test_workflow.py 同输入同输出（parity 锚）；数据逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { schema } = require('../src');

// B1 前置：GOOD 的 gql/mutation 引用 Inventory，注册期可规划性校验要求其已注册。
// node --test 按文件隔离进程，且全仓测试无其它 Inventory 注册，故此处安全。
schema.register({
  name: 'Inventory', collection: 'inventory', idPrefix: 'inv',
  fields: {
    _id: { type: 'string' }, stock: { type: 'int' },
    productId: { type: 'string' }, warehouse: { type: 'string' },
  },
});

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
    '未知顶层字段 "retry"（白名单: ["denyRead","description","name","read","run","steps","write"]）'],
  B10_dup_as: ['steps[1]: as "inv" 重复（引用歧义，禁止覆盖）'],
  B11_index_path: [
    'steps[0]: 占位符 {{input.items.0.id}} 路径非法'
    + '（首批不支持数组下标段，需要逐行处理请走宿主代码编排）'],
  B12_missing_required: ['steps[0]: query 步骤缺少必填字段 "as"'],
};

// ─── parity 锚：占位符解析 ───────────────────────────────────

const RESOLVE_CTX = { inv: { _id: 'inv1', stock: 100 } };
const RESOLVE_INPUT = { qty: 30, user: { name: '张三' }, items: [{ id: 'i0' }] };
// 每条: [expr, strict, val, err]——val/err 二选一（err 非 null 即期望报错文案）
/** @type {Array<[string, boolean, any, string|null]>} */
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

// ─── parity 锚：权限真值表 ───────────────────────────────────

const PERM_CASES = [
  [null, null, true],
  // 未配置（null）= 缺省姿态 Open：core 清单化后不再对 guest 硬拒
  [null, { roles: ['guest'] }, true],
  [null, { roles: ['user'] }, true],
  // 显式空名单（[]）= 按「未配置」放行（旧语义，注册期告警）；ctx 缺失 / internal 直通先行
  [[], null, true],
  [[], { roles: ['user'] }, true],
  [[], { roles: ['admin'] }, true],
  [[], { internal: true }, true],
  [['ops'], null, true],
  [['ops'], { roles: ['ops'] }, true],
  [['ops'], { roles: ['user'] }, false],
  [['ops'], { roles: ['user', 'ops'] }, true],
  // 无内置角色硬编码：admin / super_admin 须写进名单才放行（对齐 core 清单化）
  [['ops'], { roles: ['admin'] }, false],
  [['ops'], { roles: ['super_admin'] }, false],
  [['ops'], { roles: ['admin', 'ops'] }, true],
  [['ops'], { roles: ['guest'] }, false],
  [['ops'], { internal: true, roles: ['guest'] }, true],
  [['creator'], { userId: 'u1' }, true],
  [['ops'], { roles: [], role: 'ops' }, true],
];

module.exports = {
  GOOD,
  BAD_DEFS,
  BAD_ERRORS,
  RESOLVE_CTX,
  RESOLVE_INPUT,
  RESOLVE_CASES,
  WHEN_CASES,
  PERM_CASES,
};
