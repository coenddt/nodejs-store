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

test('transaction 无 withTransaction 时按原样执行', async () => {
  datasource.setConnections({
    db: { kind: 'sqlite', exec: async () => ({ rows: [], affectedRows: 0 }) },
  });
  assert.equal(await store.transaction('db', async () => 'ok'), 'ok');
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
