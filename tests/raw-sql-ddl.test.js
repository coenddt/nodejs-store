'use strict';

/**
 * Host 原生 SQL（executeRaw / transaction）与 DDL 生成（ddl.generate）测试
 *
 * 依据执行文档：py-store/doc/execution/2026/09/处理中-Host原生SQL与DDL生成-执行.md §4.8
 * 运行：node scripts/test.js（或 node --test tests/raw-sql-ddl.test.js）
 * Py 侧对拍：py-store/tests/test_raw_sql_and_ddl.py
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { store, datasource, feedback } = require('../src');

beforeEach(() => {
  datasource.setConnections({});
  feedback.setSink(null);
});

class FakeMongo {}

// ─── ① executeRaw ──────────────────────────────────────────

test('executeRaw 构建 plan 并返回 rows', async () => {
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

// ─── ①″ executeNative（原生 Mongo 聚合逃生口，对拍 py ①″）───

const mongoExecutor = require('../src/executors/mongo');

function patchExecMongo(stub) {
  const original = mongoExecutor.execMongo;
  mongoExecutor.execMongo = stub;
  return () => { mongoExecutor.execMongo = original; };
}

test('executeNative 构建聚合命令并返回 rows', async () => {
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

// Mongo 事务视图（store.transaction 内）经 resolveConnection 返回
// `{ kind:'mongo', conn, session, tx }`：executeNative 透传 view.session 且强制覆盖用户值。
// fake client 经 hello 探测为 replica set（setName）→ 走真实 openTransaction 路径
function fakeTxMongo(captured) {
  const txSession = {
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    async endSession() {},
  };
  const client = {
    db: () => ({ command: async () => ({ setName: 'rs0' }) }),
    startSession: () => txSession,
  };
  return {
    txSession,
    db: {
      client,
      collection: (name) => ({
        aggregate: (pipeline, opts) => {
          captured.calls.push({ name, pipeline, opts });
          return { toArray: async () => [{ n: 1 }] };
        },
      }),
    },
  };
}

test('executeNative 事务视图自动透传 session', async () => {
  const captured = { calls: [] };
  const fake = fakeTxMongo(captured);
  datasource.setConnections({ db: fake.db });

  await store.transaction('db', async () => {
    const out = await store.executeNative('db', 'orders', [{ $count: 'n' }]);
    assert.deepEqual(out, { rows: [{ n: 1 }] });
  });

  assert.equal(captured.calls.length, 1);
  assert.equal(captured.calls[0].opts.session, fake.txSession);
});

test('executeNative options.session 不可被用户覆盖', async () => {
  const captured = { calls: [] };
  const fake = fakeTxMongo(captured);
  datasource.setConnections({ db: fake.db });

  await store.transaction('db', async () => {
    await store.executeNative('db', 'orders', [], { session: 'USER' });
  });

  assert.equal(captured.calls.length, 1);
  assert.equal(captured.calls[0].opts.session, fake.txSession);
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

test('execMongo aggregate 转发原生 options', async () => {
  const calls = [];
  const db = {
    collection: (name) => ({
      aggregate: (pipeline, opts) => {
        calls.push({ name, pipeline, opts });
        return { toArray: async () => [{ n: 1 }] };
      },
    }),
  };

  const rows = await mongoExecutor.execMongo(
    db,
    { kind: 'aggregate', collection: 'orders', pipeline: [{ $count: 'n' }], options: { allowDiskUse: true } },
    null,
  );

  assert.deepEqual(rows, [{ n: 1 }]);
  assert.deepEqual(calls[0], { name: 'orders', pipeline: [{ $count: 'n' }], opts: { allowDiskUse: true } });
});

test('execMongo aggregate 无 options 时零回归', async () => {
  const calls = [];
  const db = {
    collection: (name) => ({
      aggregate: (pipeline, opts) => {
        calls.push({ name, pipeline, opts });
        return { toArray: async () => [] };
      },
    }),
  };

  await mongoExecutor.execMongo(db, { kind: 'aggregate', collection: 'orders', pipeline: [{ $match: { a: 1 } }] }, null);

  assert.deepEqual(calls[0].opts, {});
});

// ─── ② ddl.generate ─────────────────────────────────────────

test('ddl 标量列 + object/array JSON 列 + __present + 归档表', () => {
  store.register({
    name: 'DdlProbe', collection: 'ddl_probes', idPrefix: 'd', timestamps: false,
    fields: {
      _id: { type: 'string' },
      title: { type: 'string' },
      nested: { type: 'object', fields: { x: { type: 'string' } } },
      tags: { type: 'array' },
    },
  });

  const sql = store.generateDdl('mysql', ['DdlProbe', 'DdlProbeDeleted']);

  assert.ok(sql.includes('CREATE TABLE `ddl_probes`'));
  assert.ok(sql.includes('CREATE TABLE `ddl_probes_deleted`'));
  assert.ok(sql.includes('`__present` VARCHAR(255)'));
  assert.ok(sql.includes('`deletedAt` BIGINT'));
  assert.ok(sql.includes('PRIMARY KEY (`_id`)'));
  // object / array 建 JSON 列（同 core field_column_ref::Json）
  assert.ok(sql.includes('`nested` JSON'));
  assert.ok(sql.includes('`tags` JSON'));
});

test('ddl timestamps 且不生成索引', () => {
  store.register({
    name: 'DdlTs', collection: 'ddl_ts', idPrefix: 't', timestamps: true,
    indexes: [{ keys: { name: 1 } }],
    fields: { _id: { type: 'string' }, name: { type: 'string' } },
  });

  const sql = store.generateDdl('postgres', ['DdlTs']);

  assert.ok(sql.includes('"createdAt" BIGINT'));
  assert.ok(sql.includes('"updatedAt" BIGINT'));
  assert.ok(sql.includes('"__present" TEXT'));
  assert.ok(!sql.toUpperCase().includes('INDEX'));
});

test('ddl 三后端类型映射', () => {
  store.register({
    name: 'DdlTypes', collection: 'ddl_types', idPrefix: 'y', timestamps: false,
    fields: {
      _id: { type: 'string' },
      s: { type: 'string' },
      i: { type: 'int' },
      f: { type: 'float' },
      ok: { type: 'bool' },
      at: { type: 'datetime' },
    },
  });

  const my = store.generateDdl('mysql', ['DdlTypes']);
  const pg = store.generateDdl('postgres', ['DdlTypes']);
  const lite = store.generateDdl('sqlite', ['DdlTypes']);

  assert.ok(my.includes('`s` VARCHAR(255)') && my.includes('`f` DOUBLE') && my.includes('`ok` TINYINT(1)'));
  assert.ok(my.includes('`at` BIGINT'));
  assert.ok(pg.includes('"s" TEXT') && pg.includes('"f" DOUBLE PRECISION') && pg.includes('"ok" BOOLEAN'));
  assert.ok(lite.includes('"s" TEXT') && lite.includes('"f" REAL') && lite.includes('"ok" INTEGER'));
  assert.ok(lite.includes('"at" INTEGER'));
});

test('ddl object/array JSON 列三后端类型映射', () => {
  store.register({
    name: 'DdlJson', collection: 'ddl_json', idPrefix: 'j', timestamps: false,
    fields: {
      _id: { type: 'string' },
      obj: { type: 'object' },
      arr: { type: 'array' },
    },
  });

  const my = store.generateDdl('mysql', ['DdlJson']);
  const pg = store.generateDdl('postgres', ['DdlJson']);
  const lite = store.generateDdl('sqlite', ['DdlJson']);

  assert.ok(my.includes('`obj` JSON') && my.includes('`arr` JSON'));
  assert.ok(pg.includes('"obj" jsonb') && pg.includes('"arr" jsonb'));
  assert.ok(lite.includes('"obj" TEXT') && lite.includes('"arr" TEXT'));
});

test('ddl 未知后端抛错', () => {
  assert.throws(() => store.generateDdl('oracle', ['X']), /不支持的后端/);
});

test('ddl 未知字段类型抛错', () => {
  store.register({
    name: 'DdlBad', collection: 'ddl_bad', idPrefix: 'b', timestamps: false,
    fields: { _id: { type: 'string' }, weird: { type: 'weird' } },
  });
  assert.throws(() => store.generateDdl('mysql', ['DdlBad']), /未知/);
});

test('ddl __present 超限告警', () => {
  const events = [];
  feedback.setSink((e) => events.push(e));

  const fields = { _id: { type: 'string' } };
  for (let i = 0; i < 40; i += 1) {
    fields[`verylongfieldname${String(i).padStart(2, '0')}`] = { type: 'string' };
  }
  store.register({
    name: 'DdlWide', collection: 'ddl_wide', idPrefix: 'w', timestamps: false, fields,
  });

  store.generateDdl('mysql', ['DdlWide']);

  assert.ok(events.some((e) => e.code === 'ddlPresentOverflow'), JSON.stringify(events));
});
