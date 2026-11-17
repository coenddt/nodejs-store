'use strict';

/**
 * 真实 SQLite 端的会话 / 嵌套事务可见性（D4-4 零语义拆分）。
 *
 * 自 tests/session.test.js 原样迁出 #11（提交可见、异常回滚不可见）与
 * #17/#18（真实库上的嵌套 transaction / session 内层回滚、外层提交）；
 * 用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const {
  store, executors, init, permission, feedback, datasource, schema: _sc,
} = require('../test-support/session-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
  permission.setContext(undefined);
});

// ─── #11 真实 SQLite：提交可见 / 回滚不可见（A1/A2） ─────────

test('#11 真实 SQLite：提交可见、异常回滚不可见（A1/A2）', async () => {
  const file = path.join(os.tmpdir(), `sess-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE sess_real (_id TEXT PRIMARY KEY, v TEXT, __present TEXT)');
    _sc.register({
      name: 'SessRealNode', collection: 'sess_real', idPrefix: 'SR', timestamps: false,
      fields: { v: { type: 'string' } }, relations: {}, datasource: 'sess_real_n',
    });
    await init({ sess_real_n: executors.createConnection('sqlite', db) });

    await store.session(async (s) => {
      await s.insert('SessRealNode', { v: 'keep' });
    });
    const afterCommit = db2.prepare('SELECT COUNT(*) AS c FROM sess_real').get().c;

    await assert.rejects(
      () => store.session(async (s) => {
        await s.insert('SessRealNode', { v: 'drop' });
        throw new Error('boom');
      }),
      /boom/,
    );
    const afterRollback = db2.prepare('SELECT COUNT(*) AS c FROM sess_real').get().c;

    assert.equal(afterCommit, 1, '会话提交后新连接应可见数据');
    assert.equal(afterRollback, 1, '会话异常回滚后数据不可见');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch { /* 清理失败不掩盖用例结论 */ }
  }
});

// ─── #17 真实 SQLite：嵌套 transaction 内层回滚、外层提交 ─────

test('#17 真实 SQLite：嵌套 transaction 内层回滚、外层提交', async () => {
  const file = path.join(os.tmpdir(), `nest-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE nest_t (_id TEXT PRIMARY KEY, v TEXT)');
    datasource.setConnections({ nest_real: executors.createConnection('sqlite', db) });

    const ins = (v) => store.executeRaw(
      'nest_real', 'INSERT INTO nest_t (_id, v) VALUES (?, ?)', [v, v], true);

    await store.transaction('nest_real', async () => {
      await ins('keep');
      await assert.rejects(
        () => store.transaction('nest_real', async () => {
          await ins('drop');
          throw new Error('inner-boom');
        }),
        /inner-boom/,
      );
      await ins('outer');
    });

    const rows = db2.prepare('SELECT _id FROM nest_t ORDER BY _id').all().map((r) => r._id);
    assert.deepEqual(rows, ['keep', 'outer'], '内层写入回滚，外层写入提交');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch { /* 清理失败不掩盖用例结论 */ }
  }
});

// ─── #18 真实 SQLite：嵌套 session 内层回滚、外层提交 ─────────

test('#18 真实 SQLite：嵌套 session 内层回滚、外层提交', async () => {
  const file = path.join(os.tmpdir(), `nest-sess-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  const db2 = new Database(file);
  try {
    db.exec('CREATE TABLE sess_t (_id TEXT PRIMARY KEY, v TEXT)');
    datasource.setConnections({ nest_sess: executors.createConnection('sqlite', db) });

    const ins = (v) => store.executeRaw(
      'nest_sess', 'INSERT INTO sess_t (_id, v) VALUES (?, ?)', [v, v], true);

    await store.session(async () => {
      await ins('keep');
      await assert.rejects(
        () => store.session(async () => {
          await ins('inner');
          throw new Error('inner-boom');
        }),
        /inner-boom/,
      );
      await ins('outer');
    });

    const rows = db2.prepare('SELECT _id FROM sess_t ORDER BY _id').all().map((r) => r._id);
    assert.deepEqual(rows, ['keep', 'outer'], '内层会话写入回滚，外层写入提交');
  } finally {
    db.close();
    db2.close();
    try { fs.unlinkSync(file); } catch { /* 清理失败不掩盖用例结论 */ }
  }
});
