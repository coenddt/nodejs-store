'use strict';

/**
 * Mongo 执行器原生边界改写 + 写路径降级反馈（code-review m-10 回归）
 *
 * 覆盖 Host 侧两处新增逻辑（此前无对应测试）：
 *   1. `_explicitNull` 三态改写 —— 「字段 = null」编译为「字段存在且为 null」
 *      （`{$eq: null, $exists: true}`，对齐 SQL `IS NULL`）；嵌套对象 / 数组下钻；
 *      `$` 算子对象不改写（`$ne: null` 维持）。与 `py-store/src/py_store/executors/mongo.py` 同构。
 *   2. `mutation_degraded` —— 规划期降级（`plan.degraded`）经统一 `feedback`
 *      通道发射，禁止静默失守（§11.4）。
 *
 * Python 侧对拍：`py-store/tests/test_mongo_executor.py`。
 * 运行：node scripts/test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { feedback, schema: _sc } = require('../src');
const { execMongo } = require('../src/executors/mongo');

/** 捕获下发给原驱动的 filter / pipeline 的 db 桩 */
function fakeDb () {
  const captured = { filter: null, pipeline: null };
  const coll = {
    find (filter) {
      captured.filter = filter;
      return { toArray: async () => [] };
    },
    aggregate (pipeline) {
      captured.pipeline = pipeline;
      return { toArray: async () => [] };
    },
  };
  return { db: { collection: () => coll }, captured };
}

// ─── 1. _explicitNull 三态改写（经 execMongo 落地） ─────────

test('mongo native boundary: 标量 null → {$eq:null,$exists:true}', async () => {
  const { db, captured } = fakeDb();
  await execMongo(db, { collection: 'c', kind: 'find', filter: { f: null } });
  assert.deepEqual(captured.filter, { f: { $eq: null, $exists: true } });
});

test('mongo native boundary: 嵌套对象 / 数组下钻 + 算子对象不改写', async () => {
  const { db, captured } = fakeDb();
  await execMongo(db, {
    collection: 'c',
    kind: 'find',
    filter: { a: { b: null }, arr: [{ c: null }, null], op: { $ne: null } },
  });
  assert.deepEqual(captured.filter, {
    a: { b: { $eq: null, $exists: true } },
    arr: [{ c: { $eq: null, $exists: true } }, null],
    op: { $ne: null },
  });
});

test('mongo native boundary: aggregate $match 被改写', async () => {
  const { db, captured } = fakeDb();
  await execMongo(db, {
    collection: 'c',
    kind: 'aggregate',
    pipeline: [{ $match: { f: null } }],
  });
  assert.deepEqual(captured.pipeline, [{ $match: { f: { $eq: null, $exists: true } } }]);
});

// ─── 2. mutation_degraded 反馈发射 ──────────────────────────

test('mutation 降级 → feedback sink 收到 mutation_degraded', async () => {
  _sc.register({
    name: 'NbDegradedDoc', collection: 'nb_degraded_docs', timestamps: false,
    fields: { a: { type: 'string' } }, relations: {},
  });

  const { core } = require('../src/schema');
  const orig = core.planMutation;
  core.planMutation = () => ({
    steps: [],
    degraded: [{
      code: 'relationSkipped', layer: 'mutation',
      message: '关系不可读，写入已跳过', hint: '授予 read 权限',
    }],
  });

  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    const { mutation } = require('../src/crud/mutation');
    await mutation('NbDegradedDoc', { _id: 'x' });
  } finally {
    core.planMutation = orig;
    feedback.setSink(null);
  }

  const ev = events.find((e) => e.type === 'mutation_degraded');
  assert.ok(ev, 'sink 应收到 mutation_degraded 事件');
  assert.equal(ev.code, 'relationSkipped');
  assert.equal(ev.layer, 'mutation');
});
