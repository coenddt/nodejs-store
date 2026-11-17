'use strict';

/**
 * Host 原生 SQL（executeRaw / transaction）与 DDL 生成（ddl.generate）测试
 *
 * 依据执行文档：py-store/doc/execution/2026/09/处理中-Host原生SQL与DDL生成-执行.md §4.8
 * 运行：node scripts/test.js（或 node --test tests/raw-sql-ddl.test.js）
 * Py 侧对拍：py-store/tests/test_raw_sql_and_ddl.py
 *
 * D4-4 零语义拆分：非 Mongo 源桩 / execMongo 打桩器 / 事务视图桩 / aggregate db 桩
 * 下沉 ../test-support/raw-sql-ddl-support.js；executeNative 迁 raw-sql-native.test.js，
 * aggregate 与 execMongo 转发迁 raw-sql-aggregate.test.js，ddl.generate 迁
 * raw-sql-ddl-generate.test.js；用例名与断言逐字未改。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  store, datasource, feedback, FakeMongo,
} = require('../test-support/raw-sql-ddl-support');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
});

// ─── ① executeRaw ──────────────────────────────────────────

test('executeRaw 构建 plan 并返回 rows', async () => {
  /** @type {any} */
  let captured;
  datasource.setConnections({
    db: {
      kind: 'sqlite',
      exec: async (plan) => { captured = plan; return { rows: [{ a: 1 }], affectedRows: 0 }; },
    },
  });

  const out = await store.executeRaw('db', 'SELECT 1', [7]);

  assert.deepEqual(captured, { stmts: [{ text: 'SELECT 1', params: [7], isWrite: false }] });
  assert.deepEqual(out, { rows: [{ a: 1 }], affectedRows: 0 });
});

test('executeRaw isWrite 与 affectedRows', async () => {
  /** @type {any} */
  let captured;
  datasource.setConnections({
    db: {
      kind: 'mysql',
      exec: async (plan) => { captured = plan; return { rows: null, affectedRows: 3 }; },
    },
  });

  const out = await store.executeRaw('db', 'UPDATE t SET a = ?', [1], true);

  assert.equal(captured.stmts[0].isWrite, true);
  assert.deepEqual(out, { rows: null, affectedRows: 3 });
});

test('executeRaw 对 Mongo 源显式报错', async () => {
  datasource.setConnections({ db: new FakeMongo() });
  await assert.rejects(
    () => store.executeRaw('db', 'SELECT 1'),
    (e) => e instanceof store.RawSqlError,
  );
});

test('executeRaw 执行器未接入显式报错', async () => {
  datasource.setConnections({ db: { kind: 'sqlite' } });
  await assert.rejects(
    () => store.executeRaw('db', 'SELECT 1'),
    (e) => e instanceof store.RawSqlError,
  );
});

// ─── ①′ executeRaw 命名档与写推断（core rawStmtCompile 编译链，对拍 py ①′）───

function captureExec(captured) {
  return async (plan) => { captured.plan = plan; return { rows: [], affectedRows: 0 }; };
}

test('executeRaw 命名档 mysql 编译为问号占位符', async () => {
  const captured = {};
  datasource.setConnections({ db: { kind: 'mysql', exec: captureExec(captured) } });
  await store.executeRaw('db', 'SELECT * FROM t WHERE a = :x', { x: 7 });
  assert.deepEqual(captured.plan.stmts[0], { text: 'SELECT * FROM t WHERE a = ?', params: [7], isWrite: false });
});

test('executeRaw 命名档 postgres 顺序重排', async () => {
  const captured = {};
  datasource.setConnections({ db: { kind: 'postgres', exec: captureExec(captured) } });
  await store.executeRaw('db', 'SELECT :b, :a', { a: 1, b: 2 });
  assert.equal(captured.plan.stmts[0].text, 'SELECT $1, $2');
  assert.deepEqual(captured.plan.stmts[0].params, [2, 1]);
});

test('executeRaw 命名档同名复用且 :: cast 不误判', async () => {
  const captured = {};
  datasource.setConnections({ db: { kind: 'postgres', exec: captureExec(captured) } });
  await store.executeRaw('db', 'SELECT :x::text OR b = :x', { x: 'v' });
  assert.equal(captured.plan.stmts[0].text, 'SELECT $1::text OR b = $2');
  assert.deepEqual(captured.plan.stmts[0].params, ['v', 'v']);
});

test('executeRaw 引号与注释内冒号保持原样', async () => {
  const captured = {};
  datasource.setConnections({ db: { kind: 'mysql', exec: captureExec(captured) } });
  const sql = "SELECT ':' -- :hint\nFROM t WHERE a = :x";
  await store.executeRaw('db', sql, { x: 1 });
  assert.equal(captured.plan.stmts[0].text, "SELECT ':' -- :hint\nFROM t WHERE a = ?");
  assert.deepEqual(captured.plan.stmts[0].params, [1]);
});

test('executeRaw INSERT 缺省 isWrite 推断为写', async () => {
  const captured = {};
  datasource.setConnections({ db: { kind: 'mysql', exec: captureExec(captured) } });
  await store.executeRaw('db', 'INSERT INTO t VALUES (1)');
  assert.equal(captured.plan.stmts[0].isWrite, true);
});

test('executeRaw 未知首词按写（R7 安全方向，非 Err）', async () => {
  const captured = {};
  datasource.setConnections({ db: { kind: 'postgres', exec: captureExec(captured) } });
  await store.executeRaw('db', 'VACUUM ANALYZE t');
  assert.equal(captured.plan.stmts[0].isWrite, true);
});

test('executeRaw 命名档缺名显式报错', async () => {
  datasource.setConnections({ db: { kind: 'mysql', exec: captureExec({}) } });
  await assert.rejects(
    () => store.executeRaw('db', 'SELECT * FROM t WHERE a = :x', {}),
    (e) => e instanceof store.RawSqlError && /未在 params 中提供/.test(e.message),
  );
});

test('executeRaw 命名档多余名显式报错', async () => {
  datasource.setConnections({ db: { kind: 'mysql', exec: captureExec({}) } });
  await assert.rejects(
    () => store.executeRaw('db', 'SELECT * FROM t WHERE a = :x', { x: 1, y: 2 }),
    (e) => e instanceof store.RawSqlError && /未使用的命名参数/.test(e.message),
  );
});

test('executeRaw params 标量显式报错', async () => {
  datasource.setConnections({ db: { kind: 'mysql', exec: captureExec({}) } });
  await assert.rejects(
    () => store.executeRaw('db', 'SELECT 1', 7),
    (e) => e instanceof store.RawSqlError && /仅支持数组（位置档）或对象（命名档）/.test(e.message),
  );
});

test('transaction 落到事务连接并回滚', async () => {
  const state = { committed: 0, rolledBack: 0 };
  const runStmts = async () => ({ rows: [{ id: 1 }], affectedRows: 0 });
  const withTransaction = async (body) => {
    try {
      const out = await body(runStmts);
      state.committed += 1;
      return out;
    } catch (e) {
      state.rolledBack += 1;
      throw e;
    }
  };
  datasource.setConnections({ db: { kind: 'sqlite', exec: runStmts, withTransaction } });

  await assert.rejects(
    () => store.transaction('db', async () => {
      // 事务内 executeRaw 经 connectionFor 落到事务连接（txDescriptor.exec）
      const out = await store.executeRaw('db', 'SELECT * FROM t WHERE id = ? FOR UPDATE', [1]);
      assert.deepEqual(out, { rows: [{ id: 1 }], affectedRows: 0 });
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(state.rolledBack, 1);
  assert.equal(state.committed, 0);
});

test('transaction 无 withTransaction 时按原样执行并声明 transaction_not_atomic', async () => {
  datasource.setConnections({
    db: { kind: 'sqlite', exec: async () => ({ rows: [], affectedRows: 0 }) },
  });
  const events = [];
  feedback.setSink((e) => events.push(e));

  assert.equal(await store.transaction('db', async () => 'ok'), 'ok');
  const warned = events.filter((e) => e.type === 'transaction_not_atomic');
  assert.equal(warned.length, 1, '缺 withTransaction 的事务作用域必须显式声明，不静默');
  assert.equal(warned[0].code, 'transactionNotAtomic');
  assert.equal(warned[0].source, 'db');
  assert.equal(warned[0].kind, 'sqlite');
});
