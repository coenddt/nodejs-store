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

const { AsyncLocalStorage } = require('node:async_hooks');
const { core: _core, get: _getSchema } = require('./schema');
const { emit: _emitFeedback } = require('./feedback');
const executors = require('./executors');

const DEFAULT_SOURCE = 'default';

let _connections = Object.create(null);

/** 事务作用域的连接覆盖：source → 事务描述符（见 runInTransaction） */
const _txStore = new AsyncLocalStorage();

/**
 * SQL 下推遇到无法安全翻译的组合（core 标记 unsupported）
 *
 * 显式报错而非静默执行「缺少该段」的 SQL（会返回错误结果）；
 * 自动反馈：触发原因见 message，修复指引见 feedback()。
 */
class PushdownUnsupportedError extends Error {
  constructor(source, kind, codes, warnings) {
    super(`SQL 下推不支持（${kind}）: ${codes.join(', ')}；${warnings.join(' / ')}`);
    this.name = 'PushdownUnsupportedError';
    this.source = source;
    this.kind = kind;
    this.codes = codes;
    this.warnings = warnings;
  }

  /** 转统一反馈事件（与 feedback.emit 的事件形状一致） */
  feedback() {
    return {
      type: 'sql_pushdown_unsupported',
      code: 'pushdownUnsupported',
      layer: 'dialect',
      message: this.message,
      hint: '改写查询避开该组合，或改用 Mongo 源执行该段取数',
      source: this.source,
      kind: this.kind,
    };
  }
}

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

/** 指定数据源是否已在当前连接映射中配置（辅助动作「软跳过」判定用，如 init 建索引） */
function hasConnection(source) {
  return _connections[source] !== undefined;
}

/** 连接是否为 SQL 执行器描述符（`{ kind, exec }`；Mongo 为驱动实例） */
function isSqlConnection(connection) {
  return (
    !!connection &&
    typeof connection.kind === 'string' &&
    typeof connection.exec === 'function'
  );
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

/**
 * 事务作用域：在单个 SQL 源上以「同连接 + 同事务」执行 fn 内的全部命令
 *
 *   - fn 内经 `_exec` 路由到该 source 的命令全部落到事务连接（commit/rollback 一体）；
 *   - Mongo 源 / 执行器未实现 withTransaction / 多源混合时按原样执行
 *     （跨源无法原子 —— 信任边界见 README「事务边界」），绝不静默假装已事务化；
 *   - 事务体抛错统一 rollback 后原样上抛。
 */
async function runInTransaction(source, fn) {
  const conn = getConnection(source);
  if (!isSqlConnection(conn) || typeof conn.withTransaction !== 'function') {
    return fn();
  }
  const parent = _txStore.getStore();
  const store = new Map(parent || []);
  if (store.has(source)) {
    // 同源嵌套事务：外层已持有该源的事务连接，内层并入外层（不做保存点）
    return fn();
  }
  const txDescriptor = { kind: conn.kind, exec: null };
  store.set(source, txDescriptor);
  return _txStore.run(store, () =>
    conn.withTransaction(async (execOnTx) => {
      txDescriptor.exec = execOnTx;
      return fn();
    }),
  );
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
    const err = new PushdownUnsupportedError(
      source,
      connection.kind,
      plan.unsupported.map((u) => (u && u.code) || String(u)),
      (plan.warnings || []).map((w) => String(w)),
    );
    // 自动反馈：拦截即告警（无 sink 时打 stderr），禁止静默失守
    _emitFeedback(err.feedback());
    throw err;
  }
  const out = await connection.exec(plan);
  return executors.shapeResult(cmd, out);
}

module.exports = {
  DEFAULT_SOURCE,
  setConnections,
  getConnection,
  hasConnection,
  isSqlConnection,
  isSql,
  connectionFor,
  runInTransaction,
  mongoDb,
  sourceOfSchema,
  connectionOfSchema,
  dbOfSchema,
  route,
  execSql,
  PushdownUnsupportedError,
};
