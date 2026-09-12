'use strict';

/**
 * 数据源路由（多后端）
 *
 * core 产出的 Command 携带 `source` / `namespace` / `collection` 三元组
 * （见 rust-store/core 的 Command 契约），Host 只按 `source` 选连接、
 * 按 `namespace` 定位连接内的库/schema：
 *   - Mongo 源：直接交原生驱动（`db.collection(...)`）
 *   - SQL 源（mysql / postgres / sqlite）：先经 core `dialectTranslate` 翻译为
 *     SQL 语句序列，再交该连接的 `exec` 执行器
 *
 * Mongo 连接支持两种形态（绝不猜，按命令的 namespace 严格校验）：
 *   - db 实例：命令 `namespace` 必须为 null（db 实例无法跨库，非 null 显式报错）
 *   - MongoClient：命令 `namespace` 必须非 null（db 名）→ `client.db(ns).collection(...)`
 *
 * 数据源名缺省为 `default`；`init` 传入单个 Mongo db 实例时自动归一为
 * `{ default: db }`，保证既有单库调用零变更。
 */

const { core: _core, get: _getSchema } = require('./schema');
const executors = require('./executors');

const DEFAULT_SOURCE = 'default';

let _connections = Object.create(null);

/** Mongo 形态判别：db 实例（collection 为函数）或 MongoClient（db 为函数且无 collection） */
function _isMongoHandle(x) {
  return (
    !!x &&
    (typeof x.collection === 'function' ||
      (typeof x.db === 'function' && typeof x.collection !== 'function'))
  );
}

/** 归一化连接映射：单个 Mongo db 实例 / MongoClient → `{ default: 连接 }` */
function _normalize(connections) {
  if (_isMongoHandle(connections)) {
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

/**
 * Mongo 源：按命令的 `namespace` 解析目标 db（两种形态，绝不猜）
 *
 *   - db 实例（`db.collection` 为函数）：namespace 必须为 null，非 null 显式报错；
 *   - MongoClient（`db` 为函数且无 `collection`）：namespace 必须非 null，
 *     返回 `client.db(namespace)`；
 *   - 非 Mongo（SQL 描述符）返回 null，由调用方走 SQL 路径。
 */
function mongoDb(connection, source, namespace) {
  if (typeof connection.collection === 'function') {
    if (namespace) {
      throw new Error(
        `数据源 ${source} 是 Mongo db 实例，命令携带了 namespace="${namespace}"（db 实例不支持跨库；跨库请改传 MongoClient 并用 schema.namespace 声明库名）`,
      );
    }
    return connection;
  }
  if (typeof connection.db === 'function') {
    if (!namespace) {
      throw new Error(
        `数据源 ${source} 是 MongoClient，命令缺少 namespace（ MongoClient 形态必须在 schema 声明 namespace 即 db 名）`,
      );
    }
    return connection.db(namespace);
  }
  return null;
}

/** schema 声明的数据源名（缺省 `default`） */
function sourceOfSchema(name) {
  return _getSchema(name).datasource || DEFAULT_SOURCE;
}

/** 某 schema 所属数据源的连接（供 Host 侧直连场景） */
function connectionOfSchema(name) {
  return getConnection(sourceOfSchema(name));
}

/** 某 schema 的 Mongo db 句柄（按镜像的 datasource + namespace 解析；SQL 源返回 null） */
function dbOfSchema(name) {
  const s = _getSchema(name);
  const source = s.datasource || DEFAULT_SOURCE;
  return mongoDb(getConnection(source), source, s.namespace || null);
}

/** Command.source → `{ source, connection }`（三元组中的 source 精确路由） */
function route(cmd) {
  const source = cmd.source || DEFAULT_SOURCE;
  return { source, connection: getConnection(source) };
}

/**
 * SQL 路径：translate（core 纯逻辑）→ exec（连接执行器）→ 结果塑形
 *
 * 执行器只做「绑定参数 + 执行 + restoreRows」，返回中立包络；此处依 command.kind
 * 塑形为 Mongo 驱动等价返回值（见 `./executors/index.js#shapeResult`），
 * 使上层（crud/*）对 Mongo / SQL 两条路径无感。
 */
async function execSql(source, connection, cmd) {
  if (typeof connection.exec !== 'function') {
    throw new Error(
      `SQL 数据源 ${source}(${connection.kind}) 的执行器未接入（见执行文档 Phase 4）`,
    );
  }
  const plan = _core.dialectTranslate(connection.kind, cmd);
  // Host 兜底：core 标记了无法安全下推的组合（如 $lookup 子 $limit 每父 top-N）时，
  // 绝不执行「缺少该段」的 SQL（会静默返回错误结果），改为显式报错，由调用方降级重查。
  if (Array.isArray(plan.unsupported) && plan.unsupported.length > 0) {
    const codes = plan.unsupported.map((u) => (u && u.code) || String(u)).join(', ');
    throw new Error(
      `SQL 下推不支持（${connection.kind}）: ${codes}；${(plan.warnings || []).join(' / ')}`,
    );
  }
  const out = await connection.exec(plan);
  return executors.shapeResult(cmd, out);
}

module.exports = {
  DEFAULT_SOURCE,
  setConnections,
  getConnection,
  mongoDb,
  sourceOfSchema,
  connectionOfSchema,
  dbOfSchema,
  route,
  execSql,
};
