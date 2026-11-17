'use strict';

/**
 * 真实三库 e2e 共用后端上下文与连接/建表骨架（D4-4 零语义拆分）。
 *
 * 自 tests/real-backends-e2e.test.js 原样下沉：连接 URI 缺省值、MySQL/PostgreSQL
 * 物理表 DDL、后端上下文骨架与三个后端的 setup（连接试探 → 建表 → reset 闭包 →
 * 注册逻辑模型）；语句与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');

const { executors, schema: _sc } = require('../src');
const naming = require('../src/naming');
// Mongo 连接试探桩与 federation-e2e 共用（行为见 helpers 头注释）
const { probeMongo } = require('../tests/helpers/mongo-probe');

// 独立库名（可整串用 MYSQL_URI / PG_URI / MONGO_URI 环境变量覆盖，便于 CI 复用外部实例）
const MYSQL_URI =
  process.env.MYSQL_URI
  || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e_real?charset=utf8mb4';
const PG_URI = process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e_real';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e_real';

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
     __present VARCHAR(255),
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE my_posts_deleted (
     _id VARCHAR(64) NOT NULL,
     title VARCHAR(255),
     status VARCHAR(64),
     views INT,
     deleted_at BIGINT,
     __present VARCHAR(255),
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE widgets (
     _id VARCHAR(64) NOT NULL,
     sku VARCHAR(255) NOT NULL,
     price DOUBLE,
     __present VARCHAR(255),
     PRIMARY KEY (_id)
   ) ENGINE=InnoDB`,
  `CREATE TABLE gadgets (
     _id VARCHAR(64) NOT NULL,
     widget_id VARCHAR(64),
     label VARCHAR(255),
     __present VARCHAR(255),
     PRIMARY KEY (_id),
     FOREIGN KEY (widget_id) REFERENCES widgets(_id)
   ) ENGINE=InnoDB`,
];

const PG_DDL = [
  'DROP TABLE IF EXISTS gadgets CASCADE',
  'DROP TABLE IF EXISTS widgets CASCADE',
  'DROP TABLE IF EXISTS pg_posts_deleted CASCADE',
  'DROP TABLE IF EXISTS pg_posts CASCADE',
  'CREATE TABLE pg_posts (_id TEXT PRIMARY KEY, title TEXT, status TEXT, views INTEGER, __present TEXT)',
  `CREATE TABLE pg_posts_deleted (
     _id TEXT PRIMARY KEY, title TEXT, status TEXT, views INTEGER, deleted_at BIGINT, __present TEXT
   )`,
  'CREATE TABLE widgets (_id TEXT PRIMARY KEY, sku TEXT NOT NULL, price DOUBLE PRECISION, __present TEXT)',
  `CREATE TABLE gadgets (
     _id TEXT PRIMARY KEY, widget_id TEXT REFERENCES widgets(_id), label TEXT, __present TEXT
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
  const client = await probeMongo(MONGO_URI, (e) => {
    mongoCtx.reason = `MongoDB 不可达（${MONGO_URI}）: ${e.message}`;
  });
  if (!client) return;
  const db = client.db();
  mongoCtx.client = client;
  mongoCtx.driver = db;
  mongoCtx.conn = db;
  mongoCtx.reset = async () => {
    // Mongo 落库用物理集合名（camelCase）：按单点翻译后再清
    await db.collection(naming.physical('mg_posts')).deleteMany({});
    await db.collection(naming.physical('mg_posts_deleted')).deleteMany({});
  };
  registerPost(mongoCtx);
  mongoCtx.ready = true;
}

module.exports = {
  mysqlCtx,
  pgCtx,
  mongoCtx,
  setupMysql,
  setupPostgres,
  setupMongo,
};
