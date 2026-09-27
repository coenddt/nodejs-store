'use strict';

/**
 * 覆盖率余量：补真实分支断言（对标 py-store/tests/test_coverage_margin.py）
 *
 * 覆盖此前 c8 未触达的守卫 / 降级 / 事务分支：
 *   - `src/core.js` 原生加载器（生产禁从相邻仓库加载 + 缺依赖时的可执行提示）；
 *   - `src/datasource.js` 未配置源、执行器未接入、同源嵌套事务并入；
 *   - `src/ddl.js` 缺少 _id 字段的显式报错；
 *   - `src/introspect/*` 未知后端 / sqlite 驱动守卫 / attached db 不存在 / 索引收集；
 *   - `src/executors/{mysql,postgres,sqlite}.js` 入参守卫 + 事务 commit/rollback + 池 checkout；
 *   - `src/crud/id.js` one 关系子节点 ID 入池。
 *
 * 运行：node scripts/test.js（脚本会置 LOCAL_CORE=1）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { ddl, schema: _sc, datasource, introspect, feedback } = require('../src');
const { _newIdPool } = require('../src/crud/id');
const mysqlExec = require('../src/executors/mysql');
const pgExec = require('../src/executors/postgres');
const sqliteExec = require('../src/executors/sqlite');

// ─── 原生核心加载器：生产禁从相邻仓库加载 + 失败提示 ──────────

test('core loader: 缺原生依赖时显式报错且带可执行提示', () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  const corePath = require.resolve('../src/core');
  const savedLocalCore = process.env.LOCAL_CORE;

  Module._load = function (request, ...rest) {
    if (String(request).includes('rust-store-node')) throw new Error('模拟原生模块缺失');
    return origLoad.call(this, request, ...rest);
  };
  try {
    // 未置 LOCAL_CORE：不得回落相邻 rust-store 仓库 → 直接报缺少依赖
    process.env.LOCAL_CORE = '0';
    delete require.cache[corePath];
    assert.throws(() => require(corePath), /无法加载 rust-store 原生核心/);

    // LOCAL_CORE=1 但相邻产物加载失败：提示须带上兜底自身的原因（不吞错）
    process.env.LOCAL_CORE = '1';
    delete require.cache[corePath];
    assert.throws(() => require(corePath), /无法加载 rust-store 原生核心/);
  } finally {
    Module._load = origLoad;
    delete require.cache[corePath];
    if (savedLocalCore === undefined) delete process.env.LOCAL_CORE;
    else process.env.LOCAL_CORE = savedLocalCore;
  }
});

// ─── datasource：未配置源 / 执行器未接入 / 嵌套事务 ───────────

test('datasource: 未配置源与执行器未接入均显式报错', async () => {
  datasource.setConnections({ default: 'sentinel' });
  assert.equal(datasource.getConnection('default'), 'sentinel');
  assert.throws(() => datasource.getConnection('nope'), /数据源未配置: nope/);

  _sc.register({
    name: 'CovPgSrc', collection: 'cov_pg_src', datasource: 'cov_pg_a', timestamps: false,
    fields: { v: { type: 'string' } }, relations: {},
  });
  datasource.setConnections({ cov_pg_a: 'sentinel' });
  assert.equal(datasource.route({ source: 'cov_pg_a' }).connection, 'sentinel');
  assert.throws(() => datasource.route({}), /数据源未配置: default/,
    '命令未带 source 时回落 default（未配置即显式报错）');

  await assert.rejects(
    () => datasource.execSql(
      'cov_pg',
      { kind: 'postgres' },
      { source: 'cov_pg_a', collection: 'cov_pg_src', kind: 'find', filter: {}, projection: null },
    ),
    /执行器未接入/,
  );
});

test('datasource: 同源嵌套事务并入外层（不新开事务）', async () => {
  const events = [];
  feedback.setSink((e) => events.push(e));
  const opened = [];
  const innerRan = [];
  datasource.setConnections({
    cov_nested: {
      kind: 'sqlite',
      exec: () => null,
      async withTransaction (body) {
        opened.push(1);
        return body(() => null);
      },
    },
  });

  await datasource.runInTransaction('cov_nested', async () => {
    await datasource.runInTransaction('cov_nested', async () => {
      innerRan.push('inner');
    });
  });

  assert.deepEqual(opened, [1], '嵌套同源事务只应开启一次');
  assert.deepEqual(innerRan, ['inner'], '内层体须并入外层事务执行');
  const warned = events.filter((e) => e.code === 'nestedSavepointUnsupported');
  assert.equal(warned.length, 1, '无保存点原语时降级须告警，且同一源只告警一次');
});

// ─── DDL：缺少 _id 字段 ─────────────────────────────────────

test('ddl: schema 缺少 _id 字段 → 显式报错', () => {
  _sc.register({
    name: 'CovNoId', collection: 'cov_no_id', timestamps: false,
    fields: { v: { type: 'string' } }, relations: {},
  });
  assert.throws(() => ddl.generate('sqlite', ['CovNoId']), /缺少 _id 字段/);
});

// ─── init：索引列举的非服务器错误按 fail-fast 上抛 ───────────

test('init: listIndexes 非服务器错误 fail-fast（不静默吞掉）', async () => {
  const { init } = require('../src');
  const boom = new Error('模拟连接错误');
  const db = {
    collection: () => ({
      listIndexes: () => ({
        toArray: async () => { throw boom; },
      }),
    }),
  };
  try {
    await assert.rejects(() => init({ default: db }), /模拟连接错误/,
      '仅 MongoServerError 可视为「集合尚未存在」，其余须上抛');
  } finally {
    datasource.setConnections({});
  }
});

// ─── introspection：未知后端 / 驱动守卫 / 索引收集 ────────────

test('introspect: 未知后端与 sqlite 驱动守卫', async () => {
  await assert.rejects(() => introspect.run('oracle', null), /未知 introspection 后端: oracle/);
  assert.throws(() => introspect.sqlite.introspect(null), /better-sqlite3/);
});

test('introspect: sqlite attached db 不存在 → 报错含当前 attached 列表', () => {
  const db = new Database(':memory:');
  try {
    assert.throws(
      () => introspect.sqlite.introspect(db, { database: 'nope' }),
      /attached db 不存在: nope/,
    );
  } finally {
    db.close();
  }
});

test('introspect: sqlite 收集表 / 列 / 索引', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE cov_intro (_id TEXT PRIMARY KEY, v TEXT);');
    db.exec('CREATE INDEX idx_cov_intro_v ON cov_intro(v);');
    const out = introspect.sqlite.introspect(db);
    assert.deepEqual(out.tables.map((t) => t.name), ['cov_intro']);
    assert.ok(out.columns.some((c) => c.name === 'v' && c.pk === 0));
    const idx = out.indexes.find((i) => i.name === 'idx_cov_intro_v');
    assert.ok(idx, `应收集到普通索引: ${JSON.stringify(out.indexes)}`);
    assert.deepEqual(idx.columns, ['v']);
    assert.equal(idx.unique, 0);
  } finally {
    db.close();
  }
});

// ─── SQL 执行器：入参守卫 + 事务 commit/rollback + 池 checkout ──

function mysqlConn ({ fail = false, failOn = null } = {}) {
  let calls = 0;
  return {
    committed: 0,
    rolled: 0,
    released: 0,
    began: 0,
    queries: [],
    async execute (_sql, _params) {
      calls += 1;
      if (fail && (failOn === null || calls > failOn)) throw new Error('模拟语句失败');
      return [{ affectedRows: 2 }, []];
    },
    async query (sql, _params) {
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
    async query (sql, _params) {
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
    try { fs.unlinkSync(file); } catch (_) { /* 清理失败不掩盖用例结论 */ }
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

// ─── ID 供给：one 关系子节点 ─────────────────────────────────

test('crud/id: one 关系子节点缺 _id 时入池', () => {
  _sc.register({
    name: 'CovPoolParent', collection: 'cov_pool_parent', timestamps: false,
    fields: { a: { type: 'string' } },
    relations: {
      child: {
        model: 'CovPoolChild', type: 'one', localField: '_id', foreignField: 'parentId',
      },
    },
  });
  _sc.register({
    name: 'CovPoolChild', collection: 'cov_pool_child', idPrefix: 'CPC', timestamps: false,
    fields: { parentId: { type: 'string' } }, relations: {},
  });

  const pool = _newIdPool('CovPoolParent', { _id: 'p1', child: { parentId: 'p1' } });
  assert.equal(pool.length, 1, JSON.stringify(pool));
  assert.ok(pool[0].startsWith('CPC'), 'one 关系子节点缺 _id 时也须入池');
});
