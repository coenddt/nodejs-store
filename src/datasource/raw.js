'use strict';

/**
 * 原生入口（D4-4 零语义拆分自 datasource.js）
 *
 * 承载：Host 层逃生口 —— 原生 SQL（`executeRaw`）与原生 Mongo 聚合管道
 * （`executeNative`），含源类型判定、core 编译、事务/会话连接解析。
 */

const { getCore } = require('../schema');
const { RawSqlError, NativeCommandError } = require('../errors');
const executors = require('../executors');
const { SQL_KINDS } = require('./state');
const {
  connectionFor, resolveConnection, isEmbeddedConnection, isSqlConnection,
} = require('./conn');
const { mongoDb } = require('./mongo');

/**
 * 在指定 SQL 源上执行原生 SQL（Host 层逃生口，编译由 core 的 rawStmtCompile 完成）
 *
 * 两档参数风格（core 编译器按 params 类型自动分档）：
 *   - 位置档：params 为数组（或 null）→ SQL 原样透传，占位符为各后端原生风格
 *     （mysql/sqlite 用 `?`，postgres 用 `$1..$n`）；
 *   - 命名档：params 为对象 → SQL 文本中的 `:name` 编译为方言占位符（同名复用、
 *     跳过 `::` cast / 引号 / 注释边界；缺名 / 多余名显式报错）。
 *
 *   - 事务 / 会话作用域内经 `resolveConnection` 落到事务专用连接 → 支持 SELECT ... FOR UPDATE；
 *   - `isWrite` 缺省时由 SQL 首词推断（SELECT/WITH/EXPLAIN/SHOW/PRAGMA/TABLE 视为读，
 *     其余按写——默认写是安全方向）；显式传入则覆盖推断；
 *   - 仅支持 SQL 源；Mongo 源显式报错（绝不静默）；
 *   - 返回 `{ rows, affectedRows }`。
 *   对齐 py_store/datasource.py#execute_raw。
 */
/** SQL 源判定：非 SQL 源显式报错（原生 SQL 入口仅支持 mysql/postgres/sqlite） */
function _rawConnOf(source) {
  const conn0 = connectionFor(source);
  if (!conn0 || !SQL_KINDS.has(conn0.kind)) {
    throw new RawSqlError(
      `数据源 ${source} 不是 SQL 源（原生 SQL 入口仅支持 mysql/postgres/sqlite）`,
    );
  }
  return conn0;
}

/** raw 入口前置校验与编译：params 形态、SQL 源判定、core 编译（core 抛错转 RawSqlError） */
function _compileRaw(source, sql, params, isWrite) {
  if (params != null && !Array.isArray(params) && typeof params !== 'object') {
    throw new RawSqlError(`原生 SQL params 仅支持数组（位置档）或对象（命名档），收到 ${typeof params}`);
  }
  const conn0 = _rawConnOf(source);
  let compiled;
  try {
    compiled = getCore().rawStmtCompile(conn0.kind, sql, params ?? null, isWrite ?? null);
  } catch (e) {
    throw new RawSqlError((e && e.message) || String(e));
  }
  return compiled;
}

async function executeRaw(source, sql, params = null, isWrite = null) {
  const compiled = _compileRaw(source, sql, params, isWrite);
  const conn = await resolveConnection(source, compiled.isWrite);
  if (!conn || typeof conn.exec !== 'function') {
    throw new RawSqlError(`SQL 数据源 ${source}(${conn && conn.kind}) 的执行器未接入`);
  }
  const stmt = { text: compiled.sql, params: compiled.params, isWrite: compiled.isWrite };
  const out = await conn.exec({ stmts: [stmt] });
  return { rows: out.rows ?? null, affectedRows: Number(out.affectedRows || 0) };
}

/** 聚合管道是否为写管道：任一阶段含 `$merge` / `$out`（Mongo 的写出口）。
 *
 * 写管道必须按写路径解析连接（主库 / 事务连接）——按读路径解析会在主从分离或
 * 只读连接上报错或落到错误节点（A3）。
 */
function pipelineWrites(pipeline) {
  for (const stage of pipeline || []) {
    if (stage && typeof stage === 'object' && ('$merge' in stage || '$out' in stage)) return true;
  }
  return false;
}

/**
 * 在指定 Mongo 源上执行原生聚合管道（Host 层逃生口，对标 SQL 侧 executeRaw）
 *
 *   - 复用 GQL 路径唯一的 Mongo IO 边界（executors/mongo.js#execMongo 的 aggregate
 *     分支），options 为驱动原生透传项（allowDiskUse/batchSize/hint/maxTimeMS…，
 *     宿主不做白名单）；
 *   - 事务 / 会话作用域内自动透传 session（session 由事务强制接管，
 *     options.session 不可覆盖）；连接按管道语义解析：含 $merge/$out 的写管道走
 *     写路径（主库 / 事务连接），其余按读路径；
 *   - 仅支持 Mongo 源：SQL 源显式报错并指引 executeRaw（绝不静默）；
 *     MongoClient 形态须经 schema 声明 database（mongoDb 既有校验，缺名即报错）；
 *   - 返回 `{ rows }`。
 *   对齐 py_store/datasource.py#execute_native。
 */
/** Mongo 连接解析原生句柄：嵌入式取 handle；client 形态经 mongoDb 包 db（事务视图用 conn.conn） */
function _nativeCtx(conn, source) {
  const isTxView = !!conn && conn.kind === 'mongo';
  const isEmbedded = isEmbeddedConnection(conn);
  const db = isEmbedded ? conn.handle : mongoDb(isTxView ? conn.conn : conn, source, null);
  return { db, isTxView };
}

async function executeNative(source, collection, pipeline = [], options = null) {
  const conn = await resolveConnection(source, pipelineWrites(pipeline));
  if (isSqlConnection(conn)) {
    throw new NativeCommandError(
      `数据源 ${source} 是 SQL 源（executeNative 仅接受 Mongo 原生命令，SQL 源请用 executeRaw；`
      + '按 schema 的 aggregate/query（pipeline 由 core 翻译成方言 SQL）在 SQL 源可用——两者适用源不同）',
    );
  }
  const { db, isTxView } = _nativeCtx(conn, source);
  if (!db) {
    throw new NativeCommandError(
      `数据源 ${source} 不是 Mongo 源（原生 Mongo 命令入口仅支持 mongo）`,
    );
  }
  const cmd = {
    kind: 'aggregate',
    collection,
    pipeline: Array.from(pipeline || []),
    options: { ...(options || {}) },
  };
  // 属性路径调用（monkeypatch 可拦截）；session 由事务强制注入（_opts 内覆盖用户值）
  const rows = await executors.mongo.execMongo(db, cmd, isTxView ? conn.session : null);
  return { rows };
}

module.exports = {
  executeRaw,
  executeNative,
  pipelineWrites,
};
