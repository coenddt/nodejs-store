'use strict';

/**
 * 后端装配与清库（D4-4 零语义拆分自 harness-lib.js）。
 *
 * 四分支建连（sqlite 内存 / mysql / postgres / mongodb；不可达关池返回 `{error}` 绝不静默）
 * + 清库 + ctx 三态 + seed + 收尾。以 `makeBackendKit({config, loaders, store, permission})`
 * 工厂形式保留原闭包取值面（config / loaders / store / permission 逐字同源）。
 */

const { executors } = require('../../src');
const naming = require('../../src/naming');

/**
 * 构造后端装配件（闭包持有 config / loaders / store / permission）。
 * @param {{ config: object, loaders: object, store: object, permission: object }} deps
 * @returns {{ setupBackend: Function, reset: Function, withCtx: Function, seed: Function,
 *            teardown: Function }}
 */
function makeBackendKit({ config, loaders, store, permission }) {
  /** SQL 池探活；不可达 → 关池并返回 `{error}`（绝不静默），可达返回 null */
  async function probePool(pool, label, uri) {
    try {
      await pool.query('SELECT 1');
      return null;
    } catch (e) {
      await pool.end().catch(() => {});
      return { error: `${label} 不可达（${uri}）: ${e.message}` };
    }
  }

  /** sqlite 分支：内存库 + 建表（同步 exec） */
  function _setupSqlite(extra) {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (const stmt of [...loaders.loadDdl('sqlite'), ...extra]) db.exec(stmt);
    return { driver: db, conn: executors.createConnection('sqlite', db) };
  }

  /** mysql / postgres 分支共构：建池 → 探活 → 建表（不可达关池返回 {error}） */
  async function _setupSqlPool(kind, extra) {
    let pool;
    let probe;
    if (kind === 'mysql') {
      const mysql = require('mysql2/promise');
      pool = mysql.createPool(config.uris.mysql);
      probe = await probePool(pool, 'MySQL', config.uris.mysql);
    } else {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: config.uris.pg, connectionTimeoutMillis: 3000 });
      probe = await probePool(pool, 'PostgreSQL', config.uris.pg);
    }
    if (probe) return probe;
    for (const stmt of [...loaders.loadDdl(kind), ...extra]) await pool.query(stmt);
    return { driver: pool, conn: executors.createConnection(kind, pool) };
  }

  /** mongodb 分支：连接 + ping，不可达关连接返回 {error} */
  async function _setupMongo() {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(config.uris.mongo, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
    } catch (e) {
      await client.close().catch(() => {});
      return { error: `MongoDB 不可达（${config.uris.mongo}）: ${e.message}` };
    }
    const db = client.db();
    return { driver: db, conn: db, client };
  }

  /** 连接 + 建表；返回 `{ driver, conn, client?, error? }`；不可达时返回 `{ error: 原因 }` */
  async function setupBackend(kind) {
    // 追加 DDL 仅对 SQL 三分支生效（Mongo 无 DDL——原版 builtinDdl 也只在三分支拼接）
    const extra = kind !== 'mongodb' && config.extraDdl ? config.extraDdl(kind) : [];
    if (kind === 'sqlite') return _setupSqlite(extra);
    if (kind === 'mysql' || kind === 'postgres') return _setupSqlPool(kind, extra);
    if (kind === 'mongodb') return _setupMongo();
    throw new Error(`未知后端 ${kind}`);
  }

  /** 清库：归档表 + 主表（Mongo / SQL 各自路径） */
  async function reset(kind, driver) {
    const tables = [...config.tables.archive, ...config.tables.main];
    if (kind === 'mongodb') {
      // Mongo 落库用物理集合名（core::naming camelCase）：按单点翻译后再清，否则旧物理集合残留
      for (const t of tables) await driver.collection(naming.physical(t)).deleteMany({});
      return;
    }
    if (kind === 'mysql' || kind === 'postgres') {
      for (const t of tables) await driver.query(`DELETE FROM ${t}`);
      return;
    }
    driver.exec(tables.map((t) => `DELETE FROM ${t};`).join('\n'));
  }

  /** ctx 三态：null/undefined → 无上下文；{internal:true} → 内部上下文；其余原样设置 */
  async function withCtx(ctx, fn) {
    if (ctx && typeof ctx === 'object' && ctx.internal) return store.runAsInternal(fn);
    permission.setContext(ctx === null || ctx === undefined ? undefined : ctx);
    return fn();
  }

  /** seed：走 store.insert 真实写路径（owner/时间戳/_id 生成全部真实） */
  async function seed() {
    for (const batch of loaders.loadSeed()) {
      await withCtx(batch.ctx, async () => {
        for (const row of batch.rows) await store.insert(batch.schema, row);
      });
    }
  }

  async function teardown(kind, driver, client) {
    try {
      if (kind === 'mongodb') await (client ? client.close() : Promise.resolve());
      else if (kind === 'sqlite') driver.close();
      else await driver.end();
    } catch {
      /* 收尾失败不掩盖测试结论 */
    }
  }

  return {
    setupBackend, reset, withCtx, seed, teardown,
  };
}

module.exports = { makeBackendKit };
