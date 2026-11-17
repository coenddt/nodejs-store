'use strict';

/**
 * store.aggregate（schema 名聚合别名，opt-in）+ execMongo 原生 options 转发
 * 用例（D4-4 零语义拆分）。
 *
 * 自 tests/raw-sql-ddl.test.js 原样迁出 ①⃗ 段；事务视图桩、调用断言与 aggregate db 桩
 * 下沉 ../test-support/raw-sql-ddl-support.js；用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  store, datasource, feedback, init, mongoExecutor,
  patchExecMongo, fakeTxMongo, assertOneCallOnTxSession, fakeAggDb,
} = require('../test-support/raw-sql-ddl-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
});

// ─── ①⃗ store.aggregate（schema 名聚合别名，opt-in 默认关闭；03 执行文档）───

test('aggregate 默认关闭：未开启抛 ERR_NATIVE_AGGREGATE_DISABLED', async () => {
  await init({ db: { collection: () => ({}) } }); // 第二参缺省 → 开关保持 false

  await assert.rejects(
    () => store.aggregate('Anything', [{ $match: { a: 1 } }]),
    (/** @type {any} */ e) => e.code === 'ERR_NATIVE_AGGREGATE_DISABLED'
      && /allowNativeAggregate/.test(e.message),
  );
});

test('aggregate 开启后按 schema 解析并转调 executeNative', async () => {
  store.register({
    name: 'AggModel',
    collection: 'agg_models',
    idPrefix: 'am',
    datasource: 'db',
    fields: { a: { type: 'int' } },
    relations: {},
  });
  /** @type {any} */
  let captured;
  const restore = patchExecMongo(async (db, cmd, session) => {
    captured = { cmd, session };
    return [{ _id: 'g1', total: 3 }];
  });
  try {
    await init(
      { db: { collection: () => ({ listIndexes: () => ({ toArray: async () => [] }) }) } },
      { allowNativeAggregate: true },
    );

    const out = await store.aggregate(
      'AggModel',
      [{ $match: { a: 1 } }, { $group: { _id: '$a', total: { $sum: 1 } } }],
    );

    // schema 名 → (datasource, collection) 解析正确，管道原样透传（不校验不拦截）
    assert.deepEqual(captured.cmd, {
      kind: 'aggregate',
      collection: 'agg_models',
      pipeline: [{ $match: { a: 1 } }, { $group: { _id: '$a', total: { $sum: 1 } } }],
      options: {},
    });
    assert.equal(captured.session, null);
    assert.deepEqual(out, { rows: [{ _id: 'g1', total: 3 }] });

    // 未知 schema 显式报错（fail-explicit，不静默返回空）
    await assert.rejects(
      () => store.aggregate('NoSuchModel', []),
      (/** @type {any} */ e) => e.code === 'ERR_AGGREGATE_SCHEMA' && /NoSuchModel/.test(e.message),
    );
  } finally {
    restore();
  }
});

test('aggregate 事务内自动透传 session（复用 executeNative 通道）', async () => {
  store.register({
    name: 'AggTx',
    collection: 'agg_tx',
    idPrefix: 'at',
    datasource: 'db',
    fields: { a: { type: 'int' } },
    relations: {},
  });
  const captured = { calls: [] };
  const fake = fakeTxMongo(captured);
  await init({ db: fake.db }, { allowNativeAggregate: true });

  await store.transaction('db', async () => {
    const out = await store.aggregate('AggTx', [{ $count: 'n' }]);
    assert.deepEqual(out, { rows: [{ n: 1 }] });
  });

  assertOneCallOnTxSession(fake, captured);
});

test('execMongo aggregate 转发原生 options', async () => {
  const { db, calls } = fakeAggDb([{ n: 1 }]);

  const rows = await mongoExecutor.execMongo(
    db,
    { kind: 'aggregate', collection: 'orders', pipeline: [{ $count: 'n' }], options: { allowDiskUse: true } },
    null,
  );

  assert.deepEqual(rows, [{ n: 1 }]);
  assert.deepEqual(calls[0], { name: 'orders', pipeline: [{ $count: 'n' }], opts: { allowDiskUse: true } });
});

test('execMongo aggregate 无 options 时零回归', async () => {
  const { db, calls } = fakeAggDb([]);

  await mongoExecutor.execMongo(db, { kind: 'aggregate', collection: 'orders', pipeline: [{ $match: { a: 1 } }] }, null);

  assert.deepEqual(calls[0].opts, {});
});
