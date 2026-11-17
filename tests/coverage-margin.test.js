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
 *
 * D4-4 零语义拆分：SQL 执行器（mysql/postgres/sqlite 入参守卫 + 事务 commit/rollback +
 * 池 checkout + 保存点原语）迁 coverage-margin-executors.test.js，crud/id one 关系子节点
 * 入池迁 coverage-margin-id-pool.test.js；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ddl, schema: _sc, datasource, introspect, feedback } = require('../src');

// ─── 原生核心加载器：生产禁从相邻仓库加载 + 失败提示 ──────────

test('core loader: 缺原生依赖时显式报错且带可执行提示', () => {
  // _load 为 Node 内部钩子（未经 @types/node 声明），测试需直接改写以模拟原生模块缺失
  /** @type {any} */
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
