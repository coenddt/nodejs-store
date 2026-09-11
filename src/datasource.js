'use strict';

/**
 * 数据源路由（多后端）
 *
 * core 产出的 Command 只带 `collection`（见 rust-store/core 的 Command 契约），
 * Host 依据 schema 镜像的 `collection → datasource` 绑定，把每条命令路由到对应连接：
 *   - Mongo 源：直接交原生驱动（`db.collection(...)`）
 *   - SQL 源（mysql / postgres / sqlite）：先经 core `dialectTranslate` 翻译为
 *     SQL 语句序列，再交该连接的 `exec` 执行器（Phase 4 接入）
 *
 * 数据源名缺省为 `default`；`init` 传入单个 Mongo db 实例时自动归一为
 * `{ default: db }`，保证既有单库调用零变更。
 */

const { core: _core, get: _getSchema, list: _list } = require('./schema');
const executors = require('./executors');

const DEFAULT_SOURCE = 'default';

let _connections = Object.create(null);

/** 归一化连接映射：单个 Mongo db 实例 → `{ default: db }` */
function _normalize(connections) {
  if (connections && typeof connections.collection === 'function') {
    return { [DEFAULT_SOURCE]: connections };
  }
  return connections || {};
}

/** 设置数据源连接映射（Mongo 传 db 实例；SQL 传 `{ kind, exec }` 描述符） */
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

/** schema 声明的数据源名（缺省 `default`） */
function sourceOfSchema(name) {
  return _getSchema(name).datasource || DEFAULT_SOURCE;
}

/** collection → 数据源名（schema 镜像反查；未命中回落 `default`） */
function sourceOfCollection(collection) {
  for (const name of _list()) {
    if (_getSchema(name).collection === collection) return sourceOfSchema(name);
  }
  return DEFAULT_SOURCE;
}

/** 某 schema 所属数据源的连接（供索引创建等 Host 侧直连场景） */
function connectionOfSchema(name) {
  return getConnection(sourceOfSchema(name));
}

/** Command.collection → `{ source, connection }` */
function route(collection) {
  const source = sourceOfCollection(collection);
  return { source, connection: getConnection(source) };
}

/**
 * SQL 路径：translate（core 纯逻辑）→ exec（连接执行器，Phase 4 接入）→ 结果塑形
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
  sourceOfSchema,
  sourceOfCollection,
  connectionOfSchema,
  route,
  execSql,
};
