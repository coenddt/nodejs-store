'use strict';

/**
 * 数据源连接映射与判别（D4-4 零语义拆分自 datasource.js）
 *
 * 承载：连接映射的写入/读取、连接形态判别（SQL / local / memory / Mongo）、
 * 事务感知的连接解析。可变共享状态（_txStore / _sessionStore）在 ./state。
 */

const {
  DEFAULT_SOURCE, LOCAL_KIND, MEMORY_KIND, SQL_KINDS, _txStore, currentSession,
} = require('./state');

/** 连接映射（setConnections 整体替换） */
let _connections = Object.create(null);

/** 嵌入式载体判别：`kind === 'local'`（描述符与事务视图都携带 `handle`） */
function isLocalConnection(connection) {
  return !!connection && connection.kind === LOCAL_KIND;
}

/** 内存数据源判别：`kind === 'memory'`（描述符与事务视图都携带 `handle`） */
function isMemoryConnection(connection) {
  return !!connection && connection.kind === MEMORY_KIND;
}

/** 嵌入式载体判别（local ∪ memory）：无外部驱动、可整量求值的载体族 */
function isEmbeddedConnection(connection) {
  return isLocalConnection(connection) || isMemoryConnection(connection);
}

/** 连接是否为 SQL 执行器描述符（`kind ∈ SQL_KINDS` 且 `exec` 为函数；Mongo 一律非 SQL） */
function isSqlConnection(connection) {
  return (
    !!connection &&
    SQL_KINDS.has(connection.kind) &&
    typeof connection.exec === 'function'
  );
}

/** 连接的物理后端类别：'mysql'|'postgres'|'sqlite'|'local'|'memory'|'mongo' */
function kindOf(connection) {
  if (isSqlConnection(connection)) return connection.kind;
  if (isLocalConnection(connection)) return LOCAL_KIND;
  if (isMemoryConnection(connection)) return MEMORY_KIND;
  // init() 只接受 Mongo 驱动实例 / MongoClient / 上述描述符，余下即 Mongo
  return 'mongo';
}

/** Mongo 形态判别：db 实例（collection 为函数）或 MongoClient（db 为函数且无 collection） */
function _isMongoHandle(x) {
  return (
    !!x &&
    (typeof x.collection === 'function' ||
      (typeof x.db === 'function' && typeof x.collection !== 'function'))
  );
}

/** 归一化连接映射：单个 Mongo db 实例 / MongoClient / 裸嵌入式描述符 → `{ default: 连接 }` */
function _normalize(connections) {
  if (_isMongoHandle(connections) || isEmbeddedConnection(connections)) {
    return { [DEFAULT_SOURCE]: connections };
  }
  return connections || {};
}

/** 设置数据源连接映射（Mongo 传 db 实例或 MongoClient；SQL 传 `{ kind, exec }` 描述符） */
function setConnections(connections) {
  _connections = Object.assign(Object.create(null), _normalize(connections));
}

/** 取指定数据源连接（未配置即报错） */
function getConnection(source) {
  const conn = _connections[source];
  if (conn === undefined) {
    throw new Error(
      `数据源未配置: ${source}（请检查 init(connections) 与 schema 的 datasource 绑定）`,
    );
  }
  return conn;
}

/** 指定数据源是否已在当前连接映射中配置（辅助动作「软跳过」判定用，如 init 建索引） */
function hasConnection(source) {
  return _connections[source] !== undefined;
}

/** 数据源名是否绑定 SQL 源 */
function isSql(source) {
  return isSqlConnection(getConnection(source));
}

/**
 * 当前生效连接：事务作用域内返回覆盖描述符，否则返回全局映射的连接
 * （`exec.js#_execOn` 经此取连接，使事务内所有命令落到专用连接）
 */
function connectionFor(source) {
  const store = _txStore.getStore();
  if (store && store.has(source)) return store.get(source);
  return getConnection(source);
}

/** 会话感知的连接解析：会话内返回事务覆盖，否则返回全局连接
 *
 * `crud.exec._execOn` 与 `executeRaw` 共用此入口，保证会话内命令
 * （含跨多次调用的 CRUD 与原生 SQL）落到同一事务连接。
 */
async function resolveConnection(source, isWrite = false) {
  const session = currentSession();
  if (session !== null) {
    const override = await session.connFor(source, isWrite);
    if (override !== null && override !== undefined) return override;
  }
  return connectionFor(source);
}

module.exports = {
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
};
