'use strict';

/**
 * 覆盖率余量：SQL 执行器分支断言（D4-4 零语义拆分）。
 *
 * 自 tests/coverage-margin.test.js 原样迁出 SQL 执行器段：mysql / postgres / sqlite
 * 的入参守卫、事务 commit/rollback、池 checkout、保存点原语；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const mysqlExec = require('../src/executors/mysql');
const pgExec = require('../src/executors/postgres');
const sqliteExec = require('../src/executors/sqlite');

// ─── SQL 执行器：入参守卫 + 事务 commit/rollback + 池 checkout ──

function mysqlConn ({ fail = false, failOn = null } = {}) {
  let calls = 0;
  return {
    committed: 0,
    rolled: 0,
    released: 0,
    began: 0,
    queries: [],
    async execute () {
      calls += 1;
      if (fail && (failOn === null || calls > failOn)) throw new Error('模拟语句失败');
      return [{ affectedRows: 2 }, []];
    },
    async query (sql) {
      this.queries.push(sql);
      return [{ affectedRows: 0 }, []];
    },
    async beginTransaction () { this.began += 1; },
    async commit () { this.committed += 1; },
    async rollback () { this.rolled += 1; },
    release () { this.released += 1; },
  };
}

const WRITE_PLAN = { stmts: [{ text: 'UPDATE t SET v = ?', params: [1], isWrite: true }] };

test('executors/mysql: 入参守卫 + 事务 commit/rollback + 池连接归还', async () => {
  assert.throws(() => mysqlExec.create(null), /mysql2/);

  const conn = mysqlConn();
  const desc = mysqlExec.create(conn);
  const out = await desc.withTransaction((execOnTx) => execOnTx(WRITE_PLAN));
  assert.equal(out.affectedRows, 2);
  assert.equal(conn.committed, 1, '事务成功后须 commit');
  assert.equal(conn.rolled, 0);

  const bad = mysqlConn({ fail: true });
  await assert.rejects(
    () => mysqlExec.create(bad).withTransaction((execOnTx) => execOnTx(WRITE_PLAN)),
    /模拟语句失败/,
  );
  assert.equal(bad.rolled, 1, '事务体失败须 rollback 后上抛');
  assert.equal(bad.committed, 0);

  // 池形态：getConnection 取专用连接，结束后 release 归还
  const pooled = mysqlConn();
  const pool = {
    execute: pooled.execute.bind(pooled),
    async getConnection () { return pooled; },
  };
  await mysqlExec.create(pool).withTransaction((execOnTx) => execOnTx(WRITE_PLAN));
  assert.equal(pooled.released, 1, '池取出的连接用毕须归还');
});

test('executors/mysql: rollback 自身失败不掩盖原始错误', async () => {
  const conn = mysqlConn({ fail: true });
  conn.rollback = async () => { throw new Error('模拟 rollback 失败'); };
  await assert.rejects(
    () => mysqlExec.create(conn).withTransaction((execOnTx) => execOnTx(WRITE_PLAN)),
    /模拟语句失败/,
  );
});

function pgClient ({ rows = [], rowCount = 0 } = {}) {
  return {
    queries: [],
    async query (sql) {
      this.queries.push(sql);
      return { rows, rowCount };
    },
  };
}

test('executors/postgres: 入参守卫 + 事务 commit/rollback', async () => {
  assert.throws(() => pgExec.create(null), /pg 的 Pool\/Client/);

  const client = pgClient();
  const desc = pgExec.create(client);
  const out = await desc.withTransaction((execOnTx) => execOnTx(WRITE_PLAN));
  assert.equal(out.affectedRows, 0);
  assert.deepEqual(client.queries, ['BEGIN', 'UPDATE t SET v = ?', 'COMMIT']);

  const failing = {
    queries: [],
    async query (sql) {
      this.queries.push(sql);
      if (sql !== 'BEGIN' && sql !== 'ROLLBACK') throw new Error('模拟语句失败');
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => pgExec.create(failing).withTransaction((execOnTx) => execOnTx(WRITE_PLAN)),
    /模拟语句失败/,
  );
  assert.deepEqual(failing.queries, ['BEGIN', 'UPDATE t SET v = ?', 'ROLLBACK'],
    '事务体失败须 ROLLBACK 后上抛');
});

test('executors/postgres: 池 checkout 失败显式上抛（不退回 driver 本体）', async () => {
  const client = pgClient();
  const pool = {
    query: client.query.bind(client),
    totalCount: 0, // openAcquire 的 pg Pool 判据 = connect + totalCount（缺一视为单连接直通）
    async connect () { throw new Error('模拟 checkout 失败'); },
  };
  await assert.rejects(
    () => pgExec.create(pool).withTransaction((execOnTx) => execOnTx(WRITE_PLAN)),
    /模拟 checkout 失败/,
    '禁静默兜底：checkout 失败须显式上抛',
  );
  assert.deepEqual(client.queries, [], 'checkout 失败不得落到池本体上开事务');
});

test('executors/postgres: 显式事务句柄 openTransaction（幂等 commit/rollback/release）', async () => {
  const client = pgClient();
  const desc = pgExec.create(client);
  const tx = await desc.openTransaction();
  await tx.exec(WRITE_PLAN);
  await tx.commit();
  await tx.commit();   // 幂等
  await tx.release();
  await tx.release();
  assert.deepEqual(client.queries, ['BEGIN', 'UPDATE t SET v = ?', 'COMMIT']);

  const tx2 = await desc.openTransaction();
  await tx2.rollback();
  await tx2.rollback(); // 幂等
  await tx2.release();
  assert.deepEqual(client.queries.slice(3), ['BEGIN', 'ROLLBACK']);
});

test('executors/postgres: ROLLBACK 失败不掩盖原始错误', async () => {
  const client = {
    async query (sql) {
      if (sql === 'ROLLBACK') throw new Error('模拟 ROLLBACK 失败');
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      throw new Error('模拟语句失败');
    },
  };
  await assert.rejects(
    () => pgExec.create(client).withTransaction((execOnTx) => execOnTx(WRITE_PLAN)),
    /模拟语句失败/,
  );
});

test('executors/sqlite: 入参守卫 + 事务 commit/rollback', async () => {
  assert.throws(() => sqliteExec.create(null), /better-sqlite3/);

  const execs = [];
  const db = {
    prepare: () => ({ all: () => [], run: () => ({ changes: 3 }) }),
    exec: (sql) => execs.push(sql),
  };
  const out = await sqliteExec.create(db).withTransaction((execOnTx) => execOnTx(WRITE_PLAN));
  assert.equal(out.affectedRows, 3);
  assert.deepEqual(execs, ['BEGIN', 'COMMIT']);

  const failExecs = [];
  const failDb = {
    prepare: () => ({ all: () => [], run: () => ({ changes: 1 }) }),
    exec: (sql) => failExecs.push(sql),
  };
  await assert.rejects(
    () => sqliteExec.create(failDb).withTransaction(async () => {
      throw new Error('模拟事务体失败');
    }),
    /模拟事务体失败/,
  );
  assert.deepEqual(failExecs, ['BEGIN', 'ROLLBACK'], '事务体失败须 ROLLBACK');
});

test('executors/sqlite: ROLLBACK 失败不掩盖原始错误', async () => {
  const db = {
    prepare: () => ({ all: () => [], run: () => ({ changes: 1 }) }),
    exec: (sql) => {
      if (sql === 'ROLLBACK') throw new Error('模拟 ROLLBACK 失败');
    },
  };
  await assert.rejects(
    () => sqliteExec.create(db).withTransaction(async () => { throw new Error('模拟事务体失败'); }),
    /模拟事务体失败/,
  );
});

// ─── 保存点原语：SAVEPOINT / RELEASE / ROLLBACK TO ────────────

test('executors/sqlite: 保存点原语发 SAVEPOINT / RELEASE / ROLLBACK TO', async () => {
  const execs = [];
  const db = {
    prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
    exec: (sql) => execs.push(sql),
  };
  const tx = await sqliteExec.create(db).openTransaction();
  await tx.savepoint('sp_1');
  await tx.releaseSavepoint('sp_1');
  await tx.rollbackToSavepoint('sp_1');
  await tx.commit();
  assert.deepEqual(execs, [
    'BEGIN', 'SAVEPOINT sp_1', 'RELEASE SAVEPOINT sp_1', 'ROLLBACK TO SAVEPOINT sp_1', 'COMMIT',
  ]);
});

test('executors/sqlite: 真实库回滚到保存点后，保存点之后的写入保留', async () => {
  const file = path.join(os.tmpdir(), `sp-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE sp_t (_id TEXT PRIMARY KEY)');
    const ins = (v) => ({ stmts: [{ text: 'INSERT INTO sp_t (_id) VALUES (?)', params: [v], isWrite: true }] });
    const tx = await sqliteExec.create(db).openTransaction();
    await tx.exec(ins('a'));
    await tx.savepoint('sp_1');
    await tx.exec(ins('b'));
    await tx.rollbackToSavepoint('sp_1');
    await tx.releaseSavepoint('sp_1');
    await tx.exec(ins('c'));
    await tx.commit();
    const rows = db2.prepare('SELECT _id FROM sp_t ORDER BY _id').all().map((r) => r._id);
    assert.deepEqual(rows, ['a', 'c'], '回滚到保存点后 b 不可见，保存点之后的 c 保留');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch { /* 清理失败不掩盖用例结论 */ }
  }
});

test('executors/mysql: 保存点原语走 query（预备协议不支持 SAVEPOINT）', async () => {
  const conn = mysqlConn();
  const tx = await mysqlExec.create(conn).openTransaction();
  await tx.savepoint('sp_1');
  await tx.releaseSavepoint('sp_1');
  await tx.rollbackToSavepoint('sp_1');
  assert.deepEqual(conn.queries, [
    'SAVEPOINT sp_1', 'RELEASE SAVEPOINT sp_1', 'ROLLBACK TO SAVEPOINT sp_1',
  ]);
});

test('executors/postgres: 保存点原语发 SAVEPOINT / RELEASE / ROLLBACK TO', async () => {
  const client = pgClient();
  const tx = await pgExec.create(client).openTransaction();
  await tx.savepoint('sp_1');
  await tx.releaseSavepoint('sp_1');
  await tx.rollbackToSavepoint('sp_1');
  await tx.rollback();
  assert.deepEqual(client.queries, [
    'BEGIN', 'SAVEPOINT sp_1', 'RELEASE SAVEPOINT sp_1', 'ROLLBACK TO SAVEPOINT sp_1', 'ROLLBACK',
  ]);
});
