'use strict';

/**
 * 向量检索 conformance · 真实三库分册（D4-4 零语义拆分）。
 *
 * 自 tests/vector-conformance.test.js 原样迁出 mongodb / mysql / postgres 三段：
 * 沿用 `real-backends-e2e.test.js:9` 的「实例不可达即 skip」约定；用例集与
 * defineSuite 见 ../test-support/vector-conformance-support.js；用例名与断言逐字未改。
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const ddl = require('../src/ddl');
const naming = require('../src/naming');
const { executors } = require('../src');
const {
  CONFORMANCE, defineSuite, registerSchemaName,
} = require('../test-support/vector-conformance-support');

// 真实三库（与 real-backends-e2e.test.js 同约定；可用环境变量覆盖）
const MYSQL_URI =
  process.env.MYSQL_URI
  || 'mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e_real?charset=utf8mb4';
const PG_URI = process.env.PG_URI || 'postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e_real';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e_real';

/** 错误 → 简短文案：setup 的 skip 理由须携带真实错误，禁吞成统一「不可达」 */
function _errText(e) {
  return e && e.message ? e.message : String(e);
}

// ─── mongodb（不可达 / 不支持 $vectorSearch 即 skip） ─────────
let _mongoClient = null;
/** $vectorSearch 为 Atlas Search 专属能力：本地 mongod 不支持该聚合阶段
 *  （31082 SearchNotEnabled / Unrecognized pipeline stage）。探测试探聚合，
 *  报错即抛出 → 套件走 skip 通道。 */
async function probeVectorSearch(db) {
  await db.collection('_vc_probe').aggregate([
    { $vectorSearch: { queryVector: [0, 0, 0], path: 'embedding', numCandidates: 1, limit: 1 } },
  ]).toArray();
}
defineSuite(
  'mongodb',
  async () => {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1200 });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
      await probeVectorSearch(client.db());
      _mongoClient = client;
      return { vc_mongodb: client.db() };
    } catch (e) {
      await client.close().catch(() => {});
      return `[环境依赖] mongodb 实例不可达 / 不支持 $vectorSearch: ${_errText(e)}`;
    }
  },
  async () => {
    if (_mongoClient) {
      const coll = _mongoClient.db().collection(naming.physical(CONFORMANCE.schema.collection));
      await coll.deleteMany({}).catch(() => {});
      await _mongoClient.close().catch(() => {});
      _mongoClient = null;
    }
  },
);

// ─── mysql（不可达即 skip） ──────────────────────────────────
let _mysqlConn = null;
function mysqlConfig(uri) {
  const u = new URL(uri);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    charset: u.searchParams.get('charset') || 'utf8mb4',
    connectTimeout: 1200,
  };
}
defineSuite(
  'mysql',
  async () => {
    try {
      _mysqlConn = await mysql.createConnection(mysqlConfig(MYSQL_URI));
      await _mysqlConn.query('SELECT 1');
      await _mysqlConn.query('DROP TABLE IF EXISTS vector_conformance');
      await _mysqlConn.query('DROP TABLE IF EXISTS vector_conformance_deleted');
      await _mysqlConn.query(ddl.generate('mysql', [registerSchemaName('mysql')]));
      return { vc_mysql: executors.createConnection('mysql', _mysqlConn) };
    } catch (e) {
      if (_mysqlConn) await _mysqlConn.end().catch(() => {});
      _mysqlConn = null;
      return `mysql 实例不可达: ${_errText(e)}`;
    }
  },
  async () => {
    if (_mysqlConn) await _mysqlConn.end().catch(() => {});
    _mysqlConn = null;
  },
);

// ─── postgres（不可达 / 无 pgvector 即 skip） ─────────────────
let _pgPool = null;
defineSuite(
  'postgres',
  async () => {
    try {
      _pgPool = new Pool({ connectionString: PG_URI, connectionTimeoutMillis: 1200 });
      _pgPool.on('error', () => {});
      await _pgPool.query('SELECT 1');
      await _pgPool.query('DROP TABLE IF EXISTS vector_conformance');
      await _pgPool.query('DROP TABLE IF EXISTS vector_conformance_deleted');
      await _pgPool.query(ddl.generate('postgres', [registerSchemaName('postgres')]));
      return { vc_postgres: executors.createConnection('postgres', _pgPool) };
    } catch (e) {
      if (_pgPool) await _pgPool.end().catch(() => {});
      _pgPool = null;
      return `postgres 实例不可达 / 无 pgvector: ${_errText(e)}`;
    }
  },
  async () => {
    if (_pgPool) {
      // teardown 同步 DROP（含归档表）：不留残留表污染同库的 py postgres
      // 套件与 real-backends-e2e introspect 整库扫描
      await _pgPool.query('DROP TABLE IF EXISTS vector_conformance').catch(() => {});
      await _pgPool.query('DROP TABLE IF EXISTS vector_conformance_deleted').catch(() => {});
      await _pgPool.end().catch(() => {});
    }
    _pgPool = null;
  },
);
