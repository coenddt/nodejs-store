'use strict';

/**
 * Host 原生命令 executeNative（原生 Mongo 聚合逃生口）用例（D4-4 零语义拆分）。
 *
 * 自 tests/raw-sql-ddl.test.js 原样迁出 ①″ 段的用例；execMongo 打桩器与事务视图桩
 * 下沉 ../test-support/raw-sql-ddl-support.js；用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  store, datasource, feedback, FakeMongo,
  patchExecMongo, fakeTxMongo, assertOneCallOnTxSession,
} = require('../test-support/raw-sql-ddl-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
});

test('executeNative 构建聚合命令并返回 rows', async () => {
  /** @type {any} */
  let captured;
  const restore = patchExecMongo(async (db, cmd, session) => {
    captured = { cmd, session };
    return [{ n: 1 }];
  });
  try {
    datasource.setConnections({ db: { collection: () => ({}) } });

    const out = await store.executeNative('db', 'orders', [{ $match: { a: 1 } }], { allowDiskUse: true });

    assert.deepEqual(captured.cmd, {
      kind: 'aggregate',
      collection: 'orders',
      pipeline: [{ $match: { a: 1 } }],
      options: { allowDiskUse: true },
    });
    assert.equal(captured.session, null);
    assert.deepEqual(out, { rows: [{ n: 1 }] });
  } finally {
    restore();
  }
});

test('executeNative pipeline 缺省为空数组', async () => {
  /** @type {any} */
  let captured;
  const restore = patchExecMongo(async (db, cmd) => { captured = cmd; return []; });
  try {
    datasource.setConnections({ db: { collection: () => ({}) } });

    const out = await store.executeNative('db', 'orders');

    assert.deepEqual(captured.pipeline, []);
    assert.deepEqual(out, { rows: [] });
  } finally {
    restore();
  }
});

test('executeNative 事务视图自动透传 session', async () => {
  const captured = { calls: [] };
  const fake = fakeTxMongo(captured);
  datasource.setConnections({ db: fake.db });

  await store.transaction('db', async () => {
    const out = await store.executeNative('db', 'orders', [{ $count: 'n' }]);
    assert.deepEqual(out, { rows: [{ n: 1 }] });
  });

  assertOneCallOnTxSession(fake, captured);
});

test('executeNative options.session 不可被用户覆盖', async () => {
  const captured = { calls: [] };
  const fake = fakeTxMongo(captured);
  datasource.setConnections({ db: fake.db });

  await store.transaction('db', async () => {
    await store.executeNative('db', 'orders', [], { session: 'USER' });
  });

  assertOneCallOnTxSession(fake, captured);
});

test('executeNative 对 SQL 源显式报错并指引 executeRaw', async () => {
  datasource.setConnections({
    db: { kind: 'sqlite', exec: async () => ({ rows: [], affectedRows: 0 }) },
  });
  await assert.rejects(
    () => store.executeNative('db', 'orders'),
    (e) => e instanceof store.NativeCommandError
      && /是 SQL 源/.test(e.message)
      && /executeRaw/.test(e.message),
  );
});

test('executeNative 对非 Mongo 源显式报错', async () => {
  datasource.setConnections({ db: new FakeMongo() });
  await assert.rejects(
    () => store.executeNative('db', 'orders'),
    (e) => e instanceof store.NativeCommandError && /不是 Mongo 源/.test(e.message),
  );
});
