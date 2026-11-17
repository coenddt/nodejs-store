'use strict';

/**
 * 本地磁盘数据源（local）门面与 datasource 接线单测（D4-4 零语义拆分）。
 *
 * 自 tests/local-store.test.js 原样迁出步骤 4（connect 门面 / 快照隔离）与
 * 步骤 5（裸描述符归一 / 无原语降级）；临时目录工厂下沉
 * ../test-support/local-store-support.js；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  tmpDir, readSnapshot, writeCollections, connect, LOCAL_KIND, datasource, feedback,
} = require('../test-support/local-store-support');

// ─── 步骤 4：门面 ───────────────────────────────────────────

test('local/index: connect 产描述符 + 直连读写', async () => {
  const dir = tmpDir('facade');
  writeCollections(dir, ['users'], { users: [{ _id: 'u1', name: 'Ada' }] });

  const conn = connect({ dir });
  assert.equal(conn.kind, LOCAL_KIND);
  assert.equal(conn.kind, 'local');
  assert.equal(conn.dir, path.resolve(dir));
  assert.equal(typeof conn.handle.collection, 'function');
  assert.equal(typeof conn.openTransaction, 'function');
  assert.equal(typeof conn.withTransaction, 'function');

  await conn.handle.collection('users').insertOne({ _id: 'u2', name: 'Bob' });
  assert.equal(readSnapshot(dir).users.length, 2, '直连 ready 后即时落盘');
});

test('local/index: openTransaction 快照隔离（commit 可见 / rollback 丢弃）', async () => {
  const dir = tmpDir('tx');
  writeCollections(dir, ['users'], { users: [{ _id: 'u1' }] });
  const conn = connect({ dir });

  // commit：tx 内写先入内存快照，commit 才落盘
  const tx = await conn.openTransaction();
  await tx.handle.collection('users').insertOne({ _id: 'u2' });
  assert.equal(tx.session.snapshot().users.length, 2, 'tx 内快照含新写');
  assert.equal(readSnapshot(dir).users.length, 1, 'commit 前磁盘不可见（快照隔离）');
  await tx.commit();
  await tx.release();
  assert.equal(readSnapshot(dir).users.length, 2, 'commit 后落盘可见');

  // rollback：丢弃
  const tx2 = await conn.openTransaction();
  await tx2.handle.collection('users').insertOne({ _id: 'u3' });
  await tx2.rollback();
  await tx2.release();
  assert.equal(readSnapshot(dir).users.length, 2, 'rollback 后丢弃');

  // withTransaction 便捷包装
  const out = await conn.withTransaction(async (_s, t) => {
    await t.handle.collection('users').insertOne({ _id: 'u4' });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(readSnapshot(dir).users.length, 3);
});

// ─── 步骤 5：datasource 接线 ────────────────────────────────

test('local/datasource: 裸描述符归一 + 事务作用域（commit 可见 / 无 mongo 告警）', async () => {
  const dir = tmpDir('ds-tx');
  writeCollections(dir, ['users'], { users: [{ _id: 'u1' }] });
  const conn = connect({ dir });
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    assert.equal(datasource.LOCAL_KIND, 'local');
    assert.equal(datasource.isLocalConnection(conn), true);
    datasource.setConnections(conn); // 裸描述符 → { default: conn }
    assert.equal(datasource.getConnection('default'), conn);

    await datasource.runInTransaction('default', async () => {
      const view = datasource.connectionFor('default');
      assert.equal(view.kind, 'local');
      assert.equal(typeof view.handle.collection, 'function', '事务视图须携带 handle');
      await view.handle.collection('users').insertOne({ _id: 'u2' });
      assert.equal(view.session.snapshot().users.length, 2, 'tx 内快照含新写');
      assert.equal(readSnapshot(dir).users.length, 1, 'commit 前磁盘不可见');
    });
    assert.equal(readSnapshot(dir).users.length, 2, 'commit 后落盘可见');
  } finally {
    feedback.setSink(null);
    datasource.setConnections({});
  }
  assert.ok(
    !events.some((e) => e.code === 'mongoTransactionUnsupported'),
    'local 源不得出现 mongo 事务告警',
  );
});

test('local/datasource: 无 withTransaction 原语 → transaction_not_atomic（降级不静默）', async () => {
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    datasource.setConnections({ default: { kind: 'local' } }); // 缺 openTransaction/withTransaction
    const ran = await datasource.runInTransaction('default', async () => 'ok');
    assert.equal(ran, 'ok', '降级后按原样执行');
  } finally {
    feedback.setSink(null);
    datasource.setConnections({});
  }
  assert.ok(
    events.some((e) => e.code === 'transactionNotAtomic'),
    '应声明 transaction_not_atomic',
  );
});
