'use strict';

/**
 * Phase 4 · A4：真实三库（MySQL / PostgreSQL / MongoDB）CRUD 端到端
 *
 * SQLite 回路见 `sql-executor.test.js`（内存库，无需外部服务）；本文件补齐
 * 真实三库：需本机 127.0.0.1 已启动 MySQL(3306) / PostgreSQL(5432) / MongoDB(27017)，
 * 库 `mongo_store_e2e`，账号 `e2e/e2e123`（可用 MYSQL_URI / PG_URI / MONGO_URI 覆盖）。
 * 任一并不可达时，其相关用例自动 skip，不影响其余回归。
 *
 * 全程只走 store 统一入口：
 *   store.init(连接) → crud.* → datasource 路由 → core.dialectTranslate
 *     → executors（绑定参数 + 执行 + restoreRows）→ 结果塑形
 * 以及 `syncSchema`（introspect → schemaFromRows → register）。
 *
 * 每个后端的 collection 名互不相同 —— 路由按 `collection → datasource` 反查，
 * 同名 collection 会串源（这也正是「多库并行」下 schema 命名需全局唯一的体现）。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const { init, store, executors, permission, schema: _sc } = require('../src');

const MYSQL_URI =
  process.env.MYSQL_URI || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e?charset=utf8mb4';
const PG_URI = process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e';

// ─── 物理表结构（标量范式，与 core 关系模型一致；archive 表供 remove 归档） ───

const MYSQL_DDL = [
  'DROP TABLE IF EXISTS gadgets',
  'DROP TABLE IF EXISTS widgets',
  'DROP TABLE IF EXISTS my_posts_deleted',
  'DROP TABLE IF EXISTS my_posts',
  `CREATE TABLE my_posts (
     _id VARCHAR(64) NOT NULL,
     title VARCHAR(255),
     status VARCHAR(64),
     views INT,
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE my_posts_deleted (
     _id VARCHAR(64) NOT NULL,
     title VARCHAR(255),
     status VARCHAR(64),
     views INT,
     deletedAt BIGINT,
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE widgets (
     _id VARCHAR(64) NOT NULL,
     sku VARCHAR(255) NOT NULL,
     price DOUBLE,
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB`,
  `CREATE TABLE gadgets (
     _id VARCHAR(64) NOT NULL,
     widget_id VARCHAR(64),
     label VARCHAR(255),
     PRIMARY KEY (_id),
     FOREIGN KEY (widget_id) REFERENCES widgets(_id)
   ) ENGINE=InnoDB`,
];

const PG_DDL = [
  'DROP TABLE IF EXISTS gadgets CASCADE',
  'DROP TABLE IF EXISTS widgets CASCADE',
  'DROP TABLE IF EXISTS pg_posts_deleted CASCADE',
  'DROP TABLE IF EXISTS pg_posts CASCADE',
  'CREATE TABLE pg_posts (_id TEXT PRIMARY KEY, title TEXT, status TEXT, views INTEGER)',
  `CREATE TABLE pg_posts_deleted (
     _id TEXT PRIMARY KEY, title TEXT, status TEXT, views INTEGER, "deletedAt" BIGINT
   )`,
  'CREATE TABLE widgets (_id TEXT PRIMARY KEY, sku TEXT NOT NULL, price DOUBLE PRECISION)',
  `CREATE TABLE gadgets (
     _id TEXT PRIMARY KEY, widget_id TEXT REFERENCES widgets(_id), label TEXT
   )`,
];

// ─── 后端上下文（物理名/注册名/连接句柄） ─────────────────────

function makeCtx(o) {
  return Object.assign(
    { ready: false, reason: '数据库不可达', driver: null, conn: null, introspectOptions: undefined },
    o,
  );
}

const mysqlCtx = makeCtx({
  kind: 'mysql',
  ds: 'mysql_e2e',
  schemaName: 'MyPost',
  collection: 'my_posts',
  archiveSchema: 'MyPostDeleted',
  archive: 'my_posts_deleted',
});
const pgCtx = makeCtx({
  kind: 'postgres',
  ds: 'pg_e2e',
  schemaName: 'PgPost',
  collection: 'pg_posts',
  archiveSchema: 'PgPostDeleted',
  archive: 'pg_posts_deleted',
});
const mongoCtx = makeCtx({
  kind: 'mongodb',
  ds: 'mongo_e2e',
  schemaName: 'MgPost',
  collection: 'mg_posts',
  archiveSchema: 'MgPostDeleted',
  archive: 'mg_posts_deleted',
});

/** 注册逻辑模型（自动派生 `<Name>Deleted` 归档表镜像） */
function registerPost(ctx) {
  _sc.register({
    name: ctx.schemaName,
    collection: ctx.collection,
    idPrefix: 'p_',
    timestamps: false,
    fields: {
      title: { type: 'string' },
      status: { type: 'string' },
      views: { type: 'number' },
    },
    relations: {},
    datasource: ctx.ds,
  });
}

// ─── 各后端连接与建表 ────────────────────────────────────────

async function setupMysql() {
  const pool = mysql.createPool(MYSQL_URI);
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    mysqlCtx.reason = `MySQL 不可达（${MYSQL_URI}）: ${e.message}`;
    await pool.end().catch(() => {});
    return;
  }
  for (const stmt of MYSQL_DDL) await pool.query(stmt);
  mysqlCtx.driver = pool;
  mysqlCtx.conn = executors.createConnection('mysql', pool);
  mysqlCtx.reset = async () => {
    await pool.query('DELETE FROM my_posts');
    await pool.query('DELETE FROM my_posts_deleted');
  };
  registerPost(mysqlCtx);
  mysqlCtx.ready = true;
}

async function setupPostgres() {
  const pool = new Pool({ connectionString: PG_URI, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    pgCtx.reason = `PostgreSQL 不可达（${PG_URI}）: ${e.message}`;
    await pool.end().catch(() => {});
    return;
  }
  for (const stmt of PG_DDL) await pool.query(stmt);
  pgCtx.driver = pool;
  pgCtx.conn = executors.createConnection('postgres', pool);
  pgCtx.reset = async () => {
    await pool.query('DELETE FROM pg_posts');
    await pool.query('DELETE FROM pg_posts_deleted');
  };
  registerPost(pgCtx);
  pgCtx.ready = true;
}

async function setupMongo() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (e) {
    mongoCtx.reason = `MongoDB 不可达（${MONGO_URI}）: ${e.message}`;
    await client.close().catch(() => {});
    return;
  }
  const db = client.db();
  mongoCtx.client = client;
  mongoCtx.driver = db;
  mongoCtx.conn = db;
  mongoCtx.reset = async () => {
    await db.collection('mg_posts').deleteMany({});
    await db.collection('mg_posts_deleted').deleteMany({});
  };
  registerPost(mongoCtx);
  mongoCtx.ready = true;
}

before(async () => {
  permission.setContext(undefined);
  await setupMysql();
  await setupPostgres();
  await setupMongo();

  const connections = {};
  for (const c of [mysqlCtx, pgCtx, mongoCtx]) if (c.ready) connections[c.ds] = c.conn;
  await init(connections);
});

after(async () => {
  if (mysqlCtx.driver) await mysqlCtx.driver.end().catch(() => {});
  if (pgCtx.driver) await pgCtx.driver.end().catch(() => {});
  if (mongoCtx.client) await mongoCtx.client.close().catch(() => {});
});

// ─── A4：CRUD 闭环（同一套断言跑三个后端） ────────────────────

function crudSuite(ctx) {
  const S = ctx.schemaName;
  const SD = ctx.archiveSchema;

  it('insert + query（含 _id 还原）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const doc = await store.insert(S, { title: '你好', status: 'draft', views: 3 });
    assert.ok(doc && typeof doc._id === 'string' && doc._id.startsWith('p_'), '应生成 idPrefix 前缀 _id');

    const items = await store.query(`${S}{_id, title, status, views}`);
    assert.equal(items.length, 1);
    assert.equal(items[0]._id, doc._id);
    assert.equal(items[0].title, '你好');
    assert.equal(items[0].views, 3);
  });

  it('count / exists', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    await store.insertMany(S, [
      { title: 'A', status: 'draft', views: 1 },
      { title: 'B', status: 'draft', views: 2 },
    ]);
    assert.equal(await store.count(S, {}), 2);
    assert.equal(await store.count(S, { status: 'draft' }), 2);
    assert.equal(await store.count(S, { views: { $gte: 2 } }), 1);
    assert.equal(await store.exists(S, { title: 'A' }), true);
    assert.equal(await store.exists(S, { title: 'nope' }), false);
  });

  it('update（写后回读：PG/SQLite RETURNING，MySQL 两段编排）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const doc = await store.insert(S, { title: 'x', status: 'draft', views: 1 });
    const out = await store.update(S, { _id: doc._id }, { views: 42 });
    assert.ok(out && out._id === doc._id, '应回读到被更新文档');
    assert.equal(out.views, 42);

    const items = await store.query(`${S}{_id, views}`);
    assert.equal(items[0].views, 42);
  });

  it('updateMany（$inc）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    await store.insertMany(S, [
      { title: 'A', status: 'draft', views: 1 },
      { title: 'B', status: 'draft', views: 2 },
    ]);
    const r = await store.updateMany(S, {}, { $inc: { views: 10 } });
    assert.equal(r.modifiedCount, 2);
    const items = await store.query(`${S}{_id, views}`);
    assert.deepEqual(items.map((d) => d.views).sort((a, b) => a - b), [11, 12]);
  });

  it('remove（归档 + 物理删除）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const doc = await store.insert(S, { title: 'gone', status: 'done', views: 7 });
    const r = await store.remove(S, { _id: doc._id });
    assert.equal(r.deletedCount, 1);
    assert.equal(r.archivedCount, 1);

    assert.equal(await store.count(S, {}), 0);
    const archived = await store.query(`${SD}{_id, title, deletedAt}`);
    assert.equal(archived.length, 1);
    assert.equal(archived[0]._id, doc._id);
    assert.ok(Number(archived[0].deletedAt) > 0, '归档应写 deletedAt');
  });

  it('mutation（upsert 语义）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const created = await store.mutation(S, { title: 'm1', status: 'new', views: 5 });
    assert.ok(created && typeof created._id === 'string', 'mutation 应写入并回读 _id');
    assert.equal(await store.count(S, {}), 1);
  });

  it('upsert（_id 冲突目标：未命中新建 / 命中更新）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const created = await store.upsert(S, { _id: 'p_u1' }, { status: 'on', views: 1 });
    assert.ok(created && created._id === 'p_u1', 'upsert 未命中应新建并回读');
    assert.equal(created.status, 'on');

    const hit = await store.upsert(S, { _id: 'p_u1' }, { views: 9 });
    assert.equal(hit._id, 'p_u1');
    assert.equal(hit.views, 9);
    assert.equal(await store.count(S, {}), 1, '命中时不应产生新行');
  });
}

// ─── introspection → syncSchema（仅 SQL 后端） ────────────────

function syncSuite(ctx) {
  it('introspect → schemaFromRows → register', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    const defs = await store.syncSchema({
      backend: ctx.kind,
      driver: ctx.driver,
      datasource: ctx.ds,
      introspectOptions: ctx.introspectOptions,
    });

    const widgets = defs.find((d) => d.name === 'widgets');
    assert.ok(widgets, '应产出 widgets 定义');
    assert.equal(widgets.collection, 'widgets');
    assert.equal(widgets.datasource, ctx.ds);
    assert.ok(widgets.fields._id, '主键应映射为 _id');
    assert.equal(widgets.fields.sku.required, true, 'NOT NULL 应映射 required');
    assert.equal(widgets.fields.price.type, 'number');
    assert.ok(widgets.relations.gadgets, '外键应生成反向 many 关系');
    assert.equal(widgets.relations.gadgets.type, 'many');

    const gadgets = defs.find((d) => d.name === 'gadgets');
    assert.ok(gadgets.relations.widgets, '外键侧应有 many-to-one 关系');
    assert.equal(gadgets.relations.widgets.type, 'one');
    assert.equal(gadgets.relations.widgets.localField, 'widget_id');

    assert.ok(store.has('widgets'), 'syncSchema 应完成注册');
  });
}

describe('MySQL 真实库 E2E', () => crudSuite(mysqlCtx));
describe('PostgreSQL 真实库 E2E', () => crudSuite(pgCtx));
describe('MongoDB 真实库 E2E', () => crudSuite(mongoCtx));
describe('MySQL syncSchema', () => syncSuite(mysqlCtx));
describe('PostgreSQL syncSchema', () => syncSuite(pgCtx));
