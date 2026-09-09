'use strict';

/**
 * mongo-store-js 单元测试（纯逻辑，无真实 DB）：pipeline / permission / computes / crud
 *
 * 由 Python 版 tests/test_mongo_store.py 平移而来；
 * schema 注册用本文件内置的最小模型（替代业务工程 register_all）。
 * JS 无 monkeypatch → 需要 get() 的用例改为注册真实 schema（schema.register 读 _schemas）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const { schema: _sc, computes: comp, crud: _crud_mod, pipeline: ppl, permission: perm } = require('../src');

// ─────────────────────────────────────────────────────────────
// 内置最小 schema（与业务工程 CommercialLedger 同构）
// ─────────────────────────────────────────────────────────────

_sc.register({
  name: 'CommercialLedger', collection: 'commercial_ledger', idPrefix: 'CL', timestamps: true,
  fields: { unit: 'string', income: 'float' }, relations: {}, read: null, write: null,
});
_sc.register({
  name: 'GoalLedger', collection: 'goal_ledger', idPrefix: 'GL', timestamps: true,
  fields: { income: 'float' }, relations: {}, read: null, write: null,
});
// pipeline 嵌套关系 / computes 递归下钻所需
_sc.register({
  name: 'Child', collection: 'child', timestamps: false,
  fields: { name: 'string' }, relations: {}, computes: {},
});
_sc.register({
  name: 'ChildR', collection: 'child_r', timestamps: false,
  fields: { c: { type: 'string', default: 'cd' } }, relations: {}, computes: {},
});
_sc.register({
  name: 'ParentR', collection: 'parent_r', timestamps: false,
  fields: { p: { type: 'string' } }, computes: {},
  relations: { child: { model: 'ChildR', type: 'one' } },
});
// buildPipeline 用例（Python 用 monkeypatch 临时替换 get → JS 用两个真实模型）
_sc.register({
  name: 'XCustom', collection: 'x_custom', timestamps: false,
  fields: {}, relations: {}, computes: {},
});
_sc.register({
  name: 'XStandard', collection: 'x_standard', timestamps: false,
  fields: { a: { type: 'int' } }, relations: {}, computes: {},
});

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

/** 判断 stages 中是否含某个 stage（深比较，替代 Python 的 `x in list`） */
function hasDeep(arr, val) {
  return arr.some((x) => isDeepStrictEqual(x, val));
}

// ---------- pipeline 纯函数（无 DB，内联 schema） ----------

// 构造与 schema.get() 输出同构的内联 schema（fields 为 {type, ...} 字典）
const _PIPE_SRC = {
  name: 'Source', collection: 'src', timestamps: true,
  fields: {
    _id: { type: 'string' },
    unit: { type: 'string' },
    tags: { type: 'array' },
    obj: { type: 'object', fields: { x: { type: 'string' }, y: { type: 'string' } } },
  },
  relations: {
    rows: {
      model: 'Row', type: 'many', localField: '_id', foreignField: 'srcId',
    },
  },
  computes: {},
};
const _PIPE_ROW = {
  name: 'Row', collection: 'row', timestamps: true,
  fields: { income: { type: 'float' }, label: { type: 'string' } },
  relations: {}, computes: {},
};

test('pipeline.tokenize', () => {
  const toks = ppl.tokenize('Model($condition:@c0) { a, b }');
  const k = new Set(toks.map((t) => t.v));
  assert.ok(k.has('Model') && k.has('@c0') && k.has('a'));
});

test('pipeline.parseGql 解析 AST', () => {
  const ast = ppl.parseGql('Model($condition:@c0){a, Row{b, c}}');
  assert.equal(ast.model, 'Model');
  assert.equal(ast.params.condition, '@c0');
  assert.deepEqual(ast.fields, ['a']);
  assert.deepEqual(new Set(ast.relations.Row.fields), new Set(['b', 'c']));
  assert.deepEqual(ast.relations.Row.params, {});
});

test('pipeline.parseGql 带参数的关系节点无子体', () => {
  // 既有解析器局限：带参数的关系节点后不能接花括号子体（hasBrace 在解析参数前取值）
  const ast = ppl.parseGql('Model{a, Row($sort:@s0)}');
  assert.equal(ast.relations.Row.params.sort, '@s0');
  assert.deepEqual(ast.relations.Row.fields, []);
});

test('pipeline.parseGql 未闭合抛错', () => {
  assert.throws(() => ppl.parseGql('Model{$condition:'));
});

test('pipeline.flattenObjectFields 展平 object 子字段', () => {
  const ast = { fields: [], relations: { obj: { fields: ['x', 'y'], params: {} } } };
  ppl.flattenObjectFields(ast, _PIPE_SRC);
  assert.deepEqual(ast.fields, ['obj.x', 'obj.y']);
  assert.ok(!('obj' in ast.relations));
});

test('pipeline.flattenObjectFields 跳过非 object 关系', () => {
  const ast = { fields: ['unit'], relations: { rows: { fields: ['income'], params: {} } } };
  ppl.flattenObjectFields(ast, _PIPE_SRC);
  assert.ok('rows' in ast.relations && isDeepStrictEqual(ast.fields, ['unit']));
});

test('pipeline.buildProjection 基础', () => {
  const schema = { fields: { unit: { type: 'string' }, income: { type: 'float' } }, computes: {} };
  const proj = ppl.buildProjection({ fields: ['unit', 'income'], relations: {} }, schema);
  assert.equal(proj._id, 1);
  assert.equal(proj.unit, 1);
  assert.equal(proj.income, 1);
});

test('pipeline.buildProjection 空字段返回 null', () => {
  assert.equal(ppl.buildProjection({ fields: [], relations: {} }, { fields: {}, computes: {} }), null);
});

test('pipeline.buildProjection 计算列有 depends', () => {
  const schema = {
    fields: { a: { type: 'string' }, dep: { type: 'string' } },
    computes: { total: { type: 'float', fn: () => 0, depends: ['dep'] } },
  };
  const proj = ppl.buildProjection({ fields: ['a'], relations: {} }, schema);
  // 声明了 depends → 仅补依赖字段，计算列名不入投影
  assert.equal(proj.a, 1);
  assert.equal(proj.dep, 1);
  assert.ok(!('total' in proj));
});

test('pipeline.buildProjection 计算列无 depends 兜底', () => {
  const schema = {
    fields: { a: { type: 'string' }, c: { type: 'string' } },
    computes: { total: { type: 'float', fn: () => 0 } },
  };
  const proj = ppl.buildProjection({ fields: ['a'], relations: {} }, schema);
  // 无 depends → 安全兜底包含所有 schema 字段
  assert.equal(proj.a, 1);
  assert.equal(proj.c, 1);
});

test('pipeline.buildProjection 点号字段', () => {
  const schema = { fields: { obj: { type: 'object', fields: { x: {} } } }, computes: {} };
  const proj = ppl.buildProjection({ fields: ['obj.x'], relations: {} }, schema);
  assert.equal(proj['obj.x'], 1);
});

test('pipeline.buildProjection 关系入投影', () => {
  const schema = {
    fields: { unit: { type: 'string' } },
    computes: {},
    relations: { rows: { model: 'Row' } },
  };
  const proj = ppl.buildProjection({ fields: ['unit'], relations: { rows: {} } }, schema);
  assert.equal(proj.rows, 1);
});

test('pipeline.buildComputeLookupStages', () => {
  const schema = {
    computes: {
      a: { type: 'any' },
      b: { type: 'any', lookup: { from: 'refs' } },
    },
  };
  const stages = ppl.buildComputeLookupStages(schema);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].$lookup.from, 'refs');
});

test('pipeline.buildEmptyLookup 数组字段守卫', () => {
  const relDef = { localField: 'tags', foreignField: 'tagId' };
  const out = ppl.buildEmptyLookup('tags', relDef, { collection: 'tag' },
    { fields: { tags: { type: 'array' } } });
  const letExpr = out.$lookup.let.rel_tags;
  assert.ok('$cond' in letExpr); // 数组字段 → $cond/$isArray 守卫
  assert.ok(out.$lookup.pipeline[0].$match.$expr.$in);
});

test('pipeline.buildLookup 标量 + sort/limit', () => {
  const relDef = { localField: '_id', foreignField: 'srcId' };
  const relAst = { params: { condition: '@c0', sort: '@s0', limit: '@l0' }, fields: ['income'] };
  const out = ppl.buildLookup('rows', relAst,
    { c0: { income: { $gt: 0 } }, s0: { income: -1 }, l0: 5 },
    relDef, _PIPE_ROW, _PIPE_SRC);
  const pl = out.$lookup.pipeline;
  assert.deepEqual(pl[0].$match.$and[0].$expr.$eq, ['$srcId', '$$rel__id']);
  assert.ok(hasDeep(pl, { $sort: { income: -1 } }));
  assert.ok(hasDeep(pl, { $limit: 5 }));
  assert.equal(pl[pl.length - 1].$project.income, 1);
});

test('pipeline.buildLookup 深度保护降级为空 lookup', () => {
  const relDef = { localField: '_id', foreignField: 'srcId' };
  const relAst = { params: { limit: '@l0' }, fields: [] };
  const out = ppl.buildLookup('rows', relAst, { l0: 1 }, relDef, _PIPE_ROW, _PIPE_SRC,
    ppl.MAX_DEPTH, 0); // 超 MAX_DEPTH → 空 lookup 降级
  assert.equal(out.$lookup.pipeline.length, 1); // 仅 $match，不再嵌套/投影
});

test('pipeline.buildLookup 嵌套关系追加 $unwind', () => {
  const rowSchema = {
    name: 'Row', collection: 'row',
    relations: {
      child: {
        model: 'Child', type: 'one', localField: '_id', foreignField: 'rowId',
      },
    },
    computes: {}, fields: { income: { type: 'float' } },
  };
  const relAst = {
    params: {},
    fields: ['income'],
    relations: { child: { params: {}, fields: ['name'] } },
  };
  const relDef = { localField: '_id', foreignField: 'rowId' };
  const out = ppl.buildLookup('rows', relAst, {}, relDef, rowSchema, _PIPE_SRC);
  // 嵌套 child + one 关系 → 追加 $unwind
  const pl = out.$lookup.pipeline;
  assert.ok(hasDeep(pl, { $unwind: { path: '$child', preserveNullAndEmptyArrays: true } }));
});

test('pipeline.buildAddFields', () => {
  const schema = {
    computes: {
      b: { type: 'any', lookup: { from: 'refs', addFields: { $size: ['$tags'] } } },
    },
  };
  const out = ppl.buildAddFields(schema, { roles: ['admin'] });
  assert.deepEqual(out.$addFields.b, { $size: ['$tags'] });
});

test('pipeline.buildPipeline 自定义 pipeline 模式', () => {
  const ast = {
    model: 'XCustom',
    params: { pipeline: '@p0', condition: '@c0', limit: '@l0' },
    fields: [],
    relations: {},
  };
  const out = ppl.buildPipeline(ast, {
    p0: [{ $match: {} }, { $limit: 10 }], c0: { a: 1 }, l0: 50,
  });
  assert.deepEqual(out[0].$match, { a: 1 }); // 自定义管道存在 $match → 原地替换
  assert.ok(hasDeep(out, { $limit: 50 }));
});

test('pipeline.buildPipeline 标准模式无上下文', () => {
  const ast = {
    model: 'XStandard',
    params: { condition: '@c0', limit: '@l0' },
    fields: ['a'],
    relations: {},
  };
  const out = ppl.buildPipeline(ast, { c0: { year: 2026 }, l0: 10 });
  assert.deepEqual(out[0], { $match: { year: 2026 } });
  assert.ok(hasDeep(out, { $limit: 10 }));
});

test('pipeline._overrideOrAppend', () => {
  const stages = [{ $match: { a: 1 } }];
  ppl._overrideOrAppend(stages, '$match', { b: 2 }); // 已有 → 覆盖
  assert.deepEqual(stages[0].$match, { b: 2 });
  ppl._overrideOrAppend(stages, '$sort', { x: -1 }); // 无 → 追加
  assert.deepEqual(stages[stages.length - 1], { $sort: { x: -1 } });
});

test('pipeline._appendOrder', () => {
  const stages = [];
  ppl._appendOrder(stages, { t: -1 }, 10, 5);
  assert.deepEqual(stages, [{ $sort: { t: -1 } }, { $skip: 10 }, { $limit: 5 }]);
  ppl._appendOrder(stages, null, null, null); // 全 null → 无变化
  assert.equal(stages.length, 3);
});

test('pipeline._customPipelineBranch', () => {
  const root = [{ $match: { _id: 'r' } }];
  const out = ppl._customPipelineBranch([], root, { y: 2026 }, { income: -1 }, 5, 3);
  assert.deepEqual(out[0].$match, { y: 2026 }); // condition 覆盖已有 $match
  assert.ok(hasDeep(out, { $sort: { income: -1 } }));
  assert.ok(hasDeep(out, { $skip: 5 }));
  assert.ok(hasDeep(out, { $limit: 3 }));
});

test('pipeline._nsLookupStages many 关系无 $unwind', () => {
  const relAst = { fields: ['x'], relations: { rows: { fields: ['v'], params: {} } } };
  const relSchema = {
    name: 'Parent',
    fields: { x: { type: 'string' } },
    relations: {
      rows: {
        type: 'many', model: 'Child', localField: 'rowIds', foreignField: '_id',
      },
    },
  };
  const stages = ppl._nsLookupStages(relAst, relSchema, {}, 1, 0);
  assert.equal(stages.length, 1); // many 关系无 $unwind
  assert.ok('$lookup' in stages[0]);
});

// ---------- permission 纯逻辑 ----------

test('perm.evaluate 无角色白名单', () => {
  assert.equal(perm.evaluate(null, null), true); // 无上下文 → 权限放行
  assert.equal(perm.evaluate({ roles: ['buyer'] }, null), true); // 无白名单 + 已登录 → 放行
  assert.equal(perm.evaluate({ roles: ['guest'] }, null), false); // 无白名单 + guest → 拒
});

test('perm.evaluate internal 恒放行', () => {
  assert.equal(perm.evaluate({ internal: true }, ['seller']), true);
  assert.equal(perm.evaluate({ internal: true, roles: ['guest'] }, ['seller']), true);
});

test('perm.evaluate 角色匹配与 creator', () => {
  assert.equal(perm.evaluate({ roles: ['admin'] }, ['super_admin', 'admin']), true);
  assert.equal(perm.evaluate({ roles: ['seller'] }, ['admin']), false);
  assert.equal(perm.evaluate({ roles: ['seller'] }, ['creator']), true); // 新插入 doc=_MISSING
  assert.equal(perm.evaluate({ roles: [], userId: 'u1' }, ['creator'], { createdBy: 'u1' }), true);
  assert.equal(perm.evaluate({ roles: [], userId: 'u1' }, ['creator'], { createdBy: 'u2' }), false);
});

test('perm.canReadSchema / canWriteSchema', () => {
  const s = { read: ['admin'], write: ['seller'] };
  assert.equal(perm.canReadSchema(s, { roles: ['admin'] }), true);
  assert.equal(perm.canReadSchema(s, { roles: ['seller'] }), false);
  assert.equal(perm.canWriteSchema(s, { roles: ['seller'] }), true);
  // 游客无论配置如何均无写权限
  assert.equal(perm.canWriteSchema(s, { roles: ['guest'] }), false);
});

test('perm.mergeOwnerCondition', () => {
  // 无 userId / internal / admin → 不注入归属条件
  assert.deepEqual(perm.mergeOwnerCondition({ read: ['creator'] }, { roles: ['admin'] }, {}), {});
  assert.deepEqual(perm.mergeOwnerCondition({ read: ['creator'] }, { internal: true }, { a: 1 }), { a: 1 });
  // seller + 仅 creator 可读 → 注入 createdBy
  const out = perm.mergeOwnerCondition({ read: ['creator'] }, { roles: ['seller'], userId: 'u1' }, null);
  assert.deepEqual(out, { createdBy: 'u1' });
  const out2 = perm.mergeOwnerCondition({ read: ['creator'] }, { roles: ['seller'], userId: 'u1' }, { year: 1 });
  assert.deepEqual(out2, { $and: [{ year: 1 }, { createdBy: 'u1' }] });
});

test('perm.getReadableFields / getReadableComputes', () => {
  const schema = {
    fields: { a: { type: 'string' }, b: { type: 'string', read: ['admin'] } },
    computes: { c: { type: 'any', read: ['admin'] }, d: { type: 'any' } },
  };
  assert.equal(perm.getReadableFields(schema, null), null);
  const f = perm.getReadableFields(schema, { roles: ['seller'] });
  assert.ok(f.has('a') && !f.has('b'));
  const c = perm.getReadableComputes(schema, { roles: ['admin'] });
  assert.ok(c.has('c') && c.has('d'));
});

test('perm.scopedRoles / runAsInternal', async () => {
  perm.setContext(undefined);
  perm.scopedRoles(['seller'], () => {
    assert.deepEqual(perm.getContext().roles, ['seller']);
  });
  assert.equal(perm.getContext(), undefined); // 退出恢复原上下文
  const out = await perm.runAsInternal(async () => perm.getContext().internal);
  assert.equal(out, true);
});

test('perm.filterWritableData / getWritableFields', () => {
  const schema = {
    fields: { a: { type: 'string' }, b: { type: 'string', write: ['admin'] } },
    read: ['admin'],
    write: ['seller', 'admin'],
  };
  assert.deepEqual(perm.filterWritableData(schema, null, { a: 1, b: 1 }), { a: 1, b: 1 }); // 无上下文不过滤
  const keySeller = perm.getWritableFields(schema, { roles: ['seller'] });
  assert.ok(keySeller.has('a') && !keySeller.has('b')); // 字段 b 写了 write 且有白名单 → 非白名单拒
});

// ---------- computes 计算列引擎（纯逻辑） ----------

test('computes._resolveDefault', () => {
  assert.equal(comp._resolveDefault(5), 5);
  assert.equal(comp._resolveDefault('x'), 'x');
  const lst = [1, 2];
  const outLst = comp._resolveDefault(lst);
  assert.deepEqual(outLst, [1, 2]);
  assert.notEqual(outLst, lst); // 新实例
  const d = { a: 1 };
  const outObj = comp._resolveDefault(d);
  assert.deepEqual(outObj, { a: 1 });
  assert.notEqual(outObj, d); // 新实例
  assert.equal(comp._resolveDefault(() => 42), 42); // 函数取调用结果
});

test('computes.applyDefaultsAndComputes', () => {
  const schema = {
    fields: {
      unit: { type: 'string', default: '默认' },
      income: { type: 'float' },
      obj: { type: 'object', fields: { x: { type: 'int', default: 7 } } },
    },
    computes: {
      total: { type: 'float', fn: (r) => (r.income || 0) * 2 },
    },
  };
  // 已有值不覆盖；fn 计算列生效
  const out = comp.applyDefaultsAndComputes({ unit: '', income: 10 }, schema);
  assert.equal(out.unit, '');
  assert.equal(out.total, 20);
  // null 补零值 + 嵌套 object 子字段默认值
  const out2 = comp.applyDefaultsAndComputes({ income: null, obj: { x: null } }, schema);
  assert.equal(out2.income, 0);
  assert.equal(out2.obj.x, 7);
});

test('computes.processNode 默认值/fn/裁剪', () => {
  const schema = {
    name: 'T1',
    fields: {
      a: { type: 'string', default: 'd' }, b: { type: 'string' }, income: { type: 'float' },
    },
    computes: {
      total: { type: 'float', fn: (r) => (r.income || 0) * 2, depends: ['income'] },
    },
  };
  const astNode = { fields: ['a', 'b', 'total'], relations: {} };
  const doc = {
    _id: '1', a: null, b: 'keep', income: 5,
  };
  comp.processNode(doc, astNode, schema, null);
  assert.equal(doc.a, 'd');
  assert.equal(doc.b, 'keep');
  assert.equal(doc.total, 10);
  assert.ok('_id' in doc && !('income' in doc)); // 依赖字段被裁，_id 保留
});

test('computes.processNode 点号字段裁剪', () => {
  const schema = {
    name: 'T2',
    fields: { obj: { type: 'object', fields: { x: { type: 'string' }, y: { type: 'string' } } } },
    computes: {},
  };
  const astNode = { fields: ['obj.x'], relations: {} };
  const doc = { _id: '1', obj: { x: 'vx', y: 'vy' }, extra: 1 };
  comp.processNode(doc, astNode, schema, null);
  assert.deepEqual(doc.obj, { x: 'vx' }); // 点号子字段裁剪
  assert.ok(!('extra' in doc));
});

test('computes.processNode 嵌套关系递归补默认值', () => {
  const parent = _sc.get('ParentR');
  const astNode = { fields: ['p'], relations: { child: { fields: ['c'], relations: {} } } };
  const doc = { _id: '1', p: 'pv', child: { c: null } };
  comp.processNode(doc, astNode, parent, null);
  assert.equal(doc.p, 'pv');
  assert.equal(doc.child.c, 'cd'); // 递归补默认值
});

test('computes._mergeDependsIntoAst', () => {
  const schema = {
    name: 'T3',
    fields: {},
    relations: { child: { model: 'ChildR', type: 'one' } },
    computes: { agg: { type: 'any', asyncFn: async () => null, depends: ['child{c, d}'] } },
  };
  const ast = { fields: ['a'], relations: {} };
  const inject = comp._mergeDependsIntoAst(ast, schema);
  assert.deepEqual(new Set(ast.relations.child.fields), new Set(['c', 'd'])); // 依赖注入顺序由 Set 决定
  assert.equal(inject.relations.child, '__all__');
});

test('computes._stripDepInjected', () => {
  const items = [{ child: [{ c: 1, d: 2 }] }, { child: { c: 3, d: 4 } }, { child: [{ c: 5 }] }];
  comp._stripDepInjected(items, { relations: { child: new Set(['c']) } }, null);
  assert.deepEqual(items[0].child[0], { d: 2 }); // 列表子文档，c 被裁
  assert.deepEqual(items[1].child, { d: 4 }); // 单文档，c 被裁
  // __all__ 整条关系移除
  comp._stripDepInjected(items, { relations: { extra: '__all__' } }, null);
  assert.ok(!('extra' in items[0]));
});

test('computes._runAsyncFns 执行 asyncFn', async () => {
  const ran = [];
  const schema = {
    name: 'T_async',
    fields: {},
    computes: { agg: { type: 'any', asyncFn: async (items) => { ran.push(items); } } },
  };
  comp._defaultsCache.clear();
  await comp._runAsyncFns([{ x: 1 }], schema, null);
  assert.ok(ran.length); // 协程 asyncFn 被执行
});

test('computes._runAsyncFns 空 items 直接返回', async () => {
  comp._defaultsCache.clear();
  await comp._runAsyncFns([], { name: 'T_a2', fields: {}, computes: {} }, null);
  await comp._runAsyncFns([{ x: 1 }], { name: 'T_a3', fields: {}, computes: {} }, null);
});

test('computes._runAsyncFns ctx 读权限过滤', async () => {
  const ran = [];
  const allowed = [];
  const schema = {
    name: 'T_afilter',
    fields: {},
    computes: {
      a: { type: 'any', asyncFn: async (items) => { allowed.push(items); }, read: ['operator'] },
      b: { type: 'any', asyncFn: async () => { ran.push('denied-triggered'); }, read: ['hr'] },
    },
  };
  const ctx = { roles: ['operator'] };
  comp._defaultsCache.clear();
  await comp._runAsyncFns([{ x: 1 }], schema, ctx);
  assert.ok(allowed.length && !ran.length); // 仅 operator 可读的 asyncFn 被执行
});

test('computes._collectRelDeps', () => {
  const schema = {
    name: 'CR',
    fields: {},
    relations: { child: { model: 'Child' } },
    computes: {
      agg: {
        type: 'any',
        asyncFn: async () => null,
        depends: ['child{x, y}', 'child', 'norel', '', '_id'],
      },
    },
  };
  comp._defaultsCache.clear();
  const deps = comp._collectRelDeps(schema);
  assert.ok('child' in deps);
  // child{x,y} 收集了 {x,y}；裸 child 关系项已存在；norel/空/_id 被跳过
});

test('computes._injectIntoAst 合并与新建', () => {
  const astMerged = { relations: { child: { fields: ['x'], relations: {}, params: {} } } };
  const info = comp._injectIntoAst(astMerged, { child: new Set(['x', 'y']) });
  assert.deepEqual(new Set(astMerged.relations.child.fields), new Set(['x', 'y']));
  assert.deepEqual(new Set(info.relations.child), new Set(['y'])); // 仅新增字段被记录

  const astNew = { fields: [] };
  const info2 = comp._injectIntoAst(astNew, { rel2: new Set(['x']) });
  assert.deepEqual(astNew.relations.rel2.fields, ['x']);
  assert.equal(info2.relations.rel2, '__all__');
});

test('computes.processNode ctx 权限裁剪', () => {
  // ctx 权限裁剪：角色白名单不可读字段被移除，可读字段保留
  const schema = {
    name: 'PERM',
    fields: {
      secret: { type: 'string', read: ['admin'] },
      own: { type: 'string', read: ['hr'] },
      pub: { type: 'string' },
    },
    computes: {},
    relations: {},
  };
  const astNode = { fields: ['secret', 'own', 'pub'], relations: {} };
  const d2 = {
    _id: '1', secret: 's', own: 'o', pub: 'p',
  };
  comp.processNode(d2, astNode, schema, { roles: ['user'], userId: 'x' });
  assert.ok('pub' in d2); // 无 read → 默认可读
  assert.ok(!('secret' in d2) && !('own' in d2)); // 角色白名单不匹配 → 移除
});

// ---------- crud.query 分支测试（find 优化 / 两阶段 / 标准批次） ----------

class _MemCursor {
  constructor(docs) {
    this.docs = docs;
  }

  async toArray() {
    return [...this.docs];
  }
}

class _MemColl {
  /** 内存版 collection：覆盖 crud 写路径所需全部方法 */
  constructor(docs) {
    this.docs = docs !== undefined ? docs : [];
  }

  find(query, projection) {
    return new _MemCursor(this.docs);
  }

  aggregate(pipeline) {
    return new _MemCursor(this.docs);
  }

  async findOne(query, projection) {
    return this.docs.length ? { ...this.docs[0] } : null;
  }

  async countDocuments(filter) {
    return this.docs.length;
  }

  async insertOne(doc) {
    this.docs.push(doc);
    return { insertedId: doc._id };
  }

  async insertMany(docs) {
    this.docs.push(...docs);
    return { insertedCount: docs.length };
  }

  async findOneAndUpdate(condition, update, options) {
    const base = this.docs.length ? { ...this.docs[0] } : {};
    for (const st of Object.values(update)) {
      if (st && typeof st === 'object') Object.assign(base, st);
    }
    if (options && options.upsert && !this.docs.length) this.docs.push(base);
    return base;
  }

  async updateMany(condition, data) {
    return { modifiedCount: this.docs.length };
  }

  async deleteMany(condition) {
    const n = this.docs.length;
    this.docs = [];
    return { deletedCount: n };
  }

  listIndexes() {
    return new _MemCursor([]);
  }
}

class _FakeDb {
  /** 按 collection 名分配独立 coll；未知名自动建空 _MemColl（供 queryOne 空结果等） */
  constructor(coll) {
    this._colls = {};
    if (coll !== undefined) this._colls.commercial_ledger = coll;
  }

  collection(name) {
    if (!this._colls[name]) this._colls[name] = new _MemColl();
    return this._colls[name];
  }
}

/** 读路径 mock：内存 coll + 空权限 ctx，返回 fake coll */
function _crudMock() {
  const docs = [{ unit: 'a', income: 100.0, _id: '1' }];
  const coll = new _MemColl(docs);
  perm.setContext(undefined);
  _crud_mod.setDb(new _FakeDb(coll));
  return [coll, docs];
}

/** 写路径 mock：ctx=空 + 内存 coll + CommercialLedger schema */
function _crudWMock(docs) {
  const coll = new _MemColl(docs);
  perm.setContext(undefined);
  _crud_mod.setDb(new _FakeDb(coll));
  return coll;
}

test('crud.query 纯 $match / 标准聚合', async () => {
  _crudMock();
  const items = await _crud_mod.query('CommercialLedger{unit, income}');
  assert.ok(Array.isArray(items));
  assert.equal(items[0].unit, 'a');
});

test('crud.query 带关系与排序仍返回裁剪结果', async () => {
  _crudMock();
  const items = await _crud_mod.query('CommercialLedger{unit}');
  assert.ok(items.length && items[0].unit === 'a');
});

test('crud._toNumber 数字解析', () => {
  assert.equal(_crud_mod._toNumber(42), 42);
  assert.equal(_crud_mod._toNumber('3.9'), 3.9); // 字符串可转 int 失败 → 回退 float
  assert.equal(_crud_mod._toNumber(3.9), 3); // 浮点 → int 截断
  assert.equal(_crud_mod._toNumber('abc'), 0); // 不可转换 → 0
});

test('crud._toBase36', () => {
  assert.equal(_crud_mod._toBase36(0), '0');
  assert.equal(_crud_mod._toBase36(1), '1');
  assert.equal(_crud_mod._toBase36(35), 'z');
  assert.equal(_crud_mod._toBase36(36), '10');
});

test('crud._removeUndefined', () => {
  const d = { a: 1, b: null, c: 0 };
  _crud_mod._removeUndefined(d);
  assert.deepEqual(d, { a: 1, c: 0 }); // null 剔除，0 保留
});

test('crud._generateId 带前缀', () => {
  const id = _crud_mod._generateId({ idPrefix: 'T' });
  assert.ok(id.startsWith('T') && id.length > 1);
});

test('crud._hasCreatorPermission', () => {
  assert.equal(_crud_mod._hasCreatorPermission({ read: ['creator'] }), true);
  assert.equal(_crud_mod._hasCreatorPermission({ write: ['user'] }), false);
  assert.equal(_crud_mod._hasCreatorPermission({}), false);
});

test('crud.queryOne', async () => {
  _crudMock();
  const one = await _crud_mod.queryOne('CommercialLedger{unit, income}');
  assert.ok(one && one.unit === 'a');
  assert.equal(await _crud_mod.queryOne('GoalLedger{income}'), null); // 无结果 → null
});

test('crud.queryWithCount 分页元数据', async () => {
  const [coll] = _crudMock();
  coll.countDocuments = async () => 200;
  const r = await _crud_mod.queryWithCount(
    'CommercialLedger($skip:@s,$limit:@l){unit, income}',
    { s: 0, l: 50 },
  );
  assert.equal(r.total, 200);
  assert.equal(r.pageSize, 50);
  assert.equal(r.page, 0);
});

test('crud.queryWithCount pageSize 上限 5000', async () => {
  _crudMock();
  const r = await _crud_mod.queryWithCount('CommercialLedger{unit}', { pageSize: 99999, page: 0 });
  assert.equal(r.pageSize, 5000); // 上限 5000 防拖库
});

test('crud.insert 自动 ID + 时间戳', async () => {
  const coll = _crudWMock();
  const doc = await _crud_mod.insert('CommercialLedger', { unit: 'x', income: 9.0 });
  assert.ok(doc._id.startsWith('CL')); // idPrefix 自动生成
  assert.ok(doc.createdAt && doc.updatedAt); // 时间戳补默认
  assert.equal(coll.docs[0].unit, 'x');
});

test('crud.insertMany 空数组返回空', async () => {
  _crudWMock();
  assert.deepEqual(await _crud_mod.insertMany('CommercialLedger', []), []);
});

test('crud.insertMany 填充 ID', async () => {
  const coll = _crudWMock();
  const out = await _crud_mod.insertMany('CommercialLedger', [{ unit: 'a' }, { unit: 'b' }]);
  assert.equal(out.length, 2);
  assert.ok(out.every((d) => d._id.startsWith('CL')));
  assert.equal(coll.docs.length, 2);
});

test('crud.update $set 模式', async () => {
  _crudWMock([{
    _id: '1', unit: 'a', income: 100.0, createdAt: 1, updatedAt: 1,
  }]);
  const out = await _crud_mod.update('CommercialLedger', { _id: '1' }, { income: 200.0 });
  assert.ok(out && out.income === 200.0);
  assert.ok(out.updatedAt); // $set 模式自动刷 updatedAt
});

test('crud.update 原生操作符透传', async () => {
  _crudWMock([{
    _id: '1', income: 100.0, createdAt: 1, updatedAt: 1,
  }]);
  const out = await _crud_mod.update('CommercialLedger', { _id: '1' }, { $inc: { income: 5 } });
  assert.ok(out !== null);
  // 原生 $inc 透传，不触发 $set 字段校验
});

test('crud.update 空 $set 抛错', async () => {
  _crudWMock([{ _id: '1', unit: 'a' }]);
  await assert.rejects(
    () => _crud_mod.update('CommercialLedger', { _id: '1' }, { _id: '1' }),
    /没有提供要更新的字段/,
  );
});

test('crud.updateMany 原生与 $set', async () => {
  _crudWMock([{ income: 1.0 }]);
  const r1 = await _crud_mod.updateMany('CommercialLedger', {}, { $inc: { income: 1 } });
  assert.equal(r1.modifiedCount, 1);
  const r2 = await _crud_mod.updateMany('CommercialLedger', {}, { income: 2.0 });
  assert.equal(r2.modifiedCount, 1);
});

test('crud.remove 归档 + 物理删除', async () => {
  // CommercialLedger 注册时已自动注册 CommercialLedgerDeleted，归档分支命中
  const coll = _crudWMock([{
    _id: '1', unit: 'a', income: 1.0,
  }]);
  const r = await _crud_mod.remove('CommercialLedger', { _id: '1' });
  assert.equal(r.deletedCount, 1);
  assert.equal(r.archivedCount, 1); // 归档一条 + 物理删除一条
  coll.docs = [{ _id: '2', unit: 'b' }];
  const r2 = await _crud_mod.remove('CommercialLedger', { _id: '2' });
  assert.equal(r2.archivedCount, 1);
});

test('crud.exists / count', async () => {
  _crudWMock([{ _id: '1' }]);
  assert.equal(await _crud_mod.exists('CommercialLedger', { _id: '1' }), true);
  assert.equal(await _crud_mod.count('CommercialLedger', { _id: '1' }), 1);
});

test('crud._buildUpsertConditions', () => {
  const schema = {
    indexes: [
      { keys: { year: 1 }, options: { unique: true } },
      { keys: { industry: 1 }, options: {} }, // 非 unique → 跳过
    ],
  };
  const conds = _crud_mod._buildUpsertConditions(schema, { _id: 'k1', year: 2026 });
  assert.ok(hasDeep(conds, { _id: 'k1' }));
  assert.ok(hasDeep(conds, { year: 2026 }));
  const empties = _crud_mod._buildUpsertConditions(schema, { _id: '', year: '' });
  assert.deepEqual(empties, []); // 空字符串不构成条件
});

test('crud.upsert 按条件命中', async () => {
  _crudWMock();
  const out = await _crud_mod.upsert('CommercialLedger', { _id: 'u1' }, { unit: 'upserted' });
  assert.ok(out && out.unit === 'upserted');
});

test('crud.upsert 生成新 ID', async () => {
  _crudWMock();
  const out = await _crud_mod.upsert('CommercialLedger', { year: 2026 }, { unit: 'x' });
  assert.ok(out && out._id.startsWith('CL'));
});

test('crud.mutation 单条与数组', async () => {
  _crudWMock();
  const single = await _crud_mod.mutation('CommercialLedger', { year: 2026, unit: 'solo' });
  assert.ok(single && single._id.startsWith('CL'));
  const arr = await _crud_mod.mutation('CommercialLedger', [{ unit: 'a' }, { unit: 'b' }]);
  assert.ok(Array.isArray(arr) && arr.length === 2);
});

test('crud.mutation 空数组返回空数组', async () => {
  _crudWMock();
  assert.deepEqual(await _crud_mod.mutation('CommercialLedger', []), []);
});

test('crud.aggregate', async () => {
  _crudWMock([{ unit: 'a' }]);
  const out = await _crud_mod.aggregate('CommercialLedger', [{ $match: { unit: 'a' } }]);
  assert.ok(out.length && out[0].unit === 'a');
});
