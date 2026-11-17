'use strict';

/**
 * 数据源路由（多后端）
 *
 * core 产出的 Command 携带 `source` / `database` / `schema` / `collection` 定位四元组
 * （见 rust-store/core 的 Command 契约），Host 只按 `source` 选连接、
 * 按 `database`（PG 另加 `schema`）定位连接内的库/schema：
 *   - Mongo 源：直接交原生驱动（`db.collection(...)`）
 *   - SQL 源（mysql / postgres / sqlite）：先经 core `dialectTranslate` 翻译为
 *     SQL 语句序列，再交该连接的 `exec` 执行器
 *
 * Mongo 连接支持两种形态（绝不猜，按命令的 database 严格校验）：
 *   - db 实例：命令 `database` 必须为 null（db 实例无法跨库，非 null 显式报错）
 *   - MongoClient：命令 `database` 必须非 null（db 名）→ `client.db(db).collection(...)`
 *
 * 数据源名缺省为 `default`；`init` 传入单个 Mongo db 实例时自动归一为
 * `{ default: db }`，保证既有单库调用零变更。
 *
 * D4-4 零语义拆分：实现按职责分置 ./datasource/{state,conn,mongo,tx,sql,raw,session}，
 * 本文件只作门面 —— 导出面（键名 / 键序 / 语义）与拆分前逐字一致，
 * 外部 `require('./datasource')` 无需任何变更。
 */

const {
  NonAtomicWriteError, PushdownUnsupportedError, RawSqlError, NativeCommandError,
} = require('./errors');

const {
  DEFAULT_SOURCE,
  LOCAL_KIND,
  MEMORY_KIND,
  isWriteCommand,
  currentSession,
  runWithSession,
  _bindCrudModule,
} = require('./datasource/state');
const {
  setConnections,
  getConnection,
  hasConnection,
  isSqlConnection,
  isSql,
  isLocalConnection,
  isMemoryConnection,
  isEmbeddedConnection,
  kindOf,
  connectionFor,
  resolveConnection,
} = require('./datasource/conn');
const {
  mongoDb,
  isMongoClientHandle,
  mongoClientOf,
  mongoTransactable,
  isMongoSource,
  warnMongoUnsupported,
  sourceOfSchema,
  connectionOfSchema,
  dbOfSchema,
  route,
} = require('./datasource/mongo');
const {
  runInTransaction,
  nestedSavepointScope,
  warnSavepointUnavailable,
  warnSavepointFailed,
  warnTransactionNotAtomic,
} = require('./datasource/tx');
const {
  execSql,
  _execSqlDirect,
  _claimTwoStep,
  _execClaim,
  _renderClaimedIds,
} = require('./datasource/sql');
const { executeRaw, executeNative, pipelineWrites } = require('./datasource/raw');
const { Session } = require('./datasource/session');

module.exports = {
  DEFAULT_SOURCE,
  LOCAL_KIND,
  MEMORY_KIND,
  setConnections,
  getConnection,
  hasConnection,
  isSqlConnection,
  isSql,
  isLocalConnection,
  isMemoryConnection,
  isEmbeddedConnection,
  kindOf,
  connectionFor,
  resolveConnection,
  runInTransaction,
  nestedSavepointScope,
  warnSavepointUnavailable,
  warnSavepointFailed,
  warnTransactionNotAtomic,
  mongoDb,
  isMongoClientHandle,
  mongoClientOf,
  mongoTransactable,
  isMongoSource,
  warnMongoUnsupported,
  sourceOfSchema,
  connectionOfSchema,
  dbOfSchema,
  route,
  execSql,
  executeRaw,
  executeNative,
  pipelineWrites,
  isWriteCommand,
  currentSession,
  runWithSession,
  Session,
  NonAtomicWriteError,
  PushdownUnsupportedError,
  RawSqlError,
  NativeCommandError,
  // D4-1 解环注入口（包内协作，非公共 API）
  _bindCrudModule,
  // parity 锚与内部件（下划线内部语义）
  _claimTwoStep,
  _execClaim,
  _renderClaimedIds,
  _execSqlDirect,
};
