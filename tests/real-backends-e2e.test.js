'use strict';

/**
 * Phase 4 · A4：真实三库（MySQL / PostgreSQL / MongoDB）CRUD 端到端
 *
 * SQLite 回路见 `sql-executor.test.js`（内存库，无需外部服务）；本文件补齐
 * 真实三库：需本机 127.0.0.1 已启动 MySQL(3306) / PostgreSQL(5432) / MongoDB(27017)，
 * 库 `mongo_store_e2e_real`，账号 `e2e/e2e123`（可用 MYSQL_URI / PG_URI / MONGO_URI 覆盖）。
 * 任一并不可达时，其相关用例自动 skip，不影响其余回归。
 *
 * 数据隔离（ISTQB Independent/Repeatable）：本文件使用**独立库** `mongo_store_e2e_real`
 * （MySQL database / PG database / Mongo db 同名），`before`/`reset()` 中的
 * DROP/CREATE/DELETE 仅作用于本库，与 `federation-e2e.test.js`
 * （`mongo_store_e2e_fed`）互不干扰，全量套件并发/重复运行不再互相清空对方 fixture。
 *
 * 全程只走 store 统一入口：
 *   store.init(连接) → crud.* → datasource 路由 → core.dialectTranslate
 *     → executors（绑定参数 + 执行 + restoreRows）→ 结果塑形
 * 以及 `syncSchema`（introspect → schemaFromRows → register）。
 *
 * 每个后端的 collection 名互不相同 —— 路由按命令自带的 `source` 三元组精确路由，
 * `(source, namespace, collection)` 在 Registry 内全局唯一，冲突注册即抛错（fail fast）。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 *
 * D4-4 零语义拆分：连接 URI / 三库物理 DDL / 后端上下文 / setup 三段与 registerPost
 * 下沉 ../test-support/backend-e2e-setup.js；种子与 crudSuite / syncSuite 用例定义器
 * 下沉 ../test-support/backend-e2e-suites.js；本文件只余 before/after 与五个 describe。
 */

const { describe, before, after } = require('node:test');

const { init, permission } = require('../src');
const {
  mysqlCtx, pgCtx, mongoCtx, setupMysql, setupPostgres, setupMongo,
} = require('../test-support/backend-e2e-setup');
const { crudSuite, syncSuite } = require('../test-support/backend-e2e-suites');

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

describe('MySQL 真实库 E2E', () => crudSuite(mysqlCtx));
describe('PostgreSQL 真实库 E2E', () => crudSuite(pgCtx));
describe('MongoDB 真实库 E2E', () => crudSuite(mongoCtx));
describe('MySQL syncSchema', () => syncSuite(mysqlCtx));
describe('PostgreSQL syncSchema', () => syncSuite(pgCtx));
