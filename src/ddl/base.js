'use strict';

/**
 * DDL 基础层（D4-4 零语义拆分自 ddl.js）：后端枚举 / 类型映射常量、标识符引用与
 * 物理名翻译、声明类型读取，以及 vector 列类型与 pgvector 索引语句。
 *
 * 纯函数，不连库、不回写；所有文本与错误文案与拆分前逐字一致。
 */

const { emit: _emitFeedback } = require('../feedback-core');
// core 为动态加载的原生核心（形状由 rust-store-node 导出决定），此处按开放形状接收
const { translateName } = /** @type {any} */ (require('../core'));

const BACKENDS = ['mysql', 'postgres', 'sqlite'];

// schema 声明类型 → [mysql, postgres, sqlite] 列类型
const TYPES = {
  string: ['VARCHAR(255)', 'TEXT', 'TEXT'],
  // 长文本（序列化状态、正文、base64 等数 KB 起步的字符串）：MySQL 用 MEDIUMTEXT（16MB），
  // 避免调用方只能声明 string 再在建表后手改列型（宿主私改列型即绕过 DDL 真源，见 AGENTS §22）。
  // PG / SQLite 的 TEXT 本身无长度上限。与 py_store/ddl.py::_TYPES['text'] 逐字节一致。
  text: ['MEDIUMTEXT', 'TEXT', 'TEXT'],
  int: ['INT', 'INTEGER', 'INTEGER'],
  long: ['BIGINT', 'BIGINT', 'INTEGER'],
  number: ['BIGINT', 'BIGINT', 'INTEGER'],
  float: ['DOUBLE', 'DOUBLE PRECISION', 'REAL'],
  double: ['DOUBLE', 'DOUBLE PRECISION', 'REAL'],
  bool: ['TINYINT(1)', 'BOOLEAN', 'INTEGER'],
  boolean: ['TINYINT(1)', 'BOOLEAN', 'INTEGER'],
  datetime: ['BIGINT', 'BIGINT', 'INTEGER'],
  date: ['BIGINT', 'BIGINT', 'INTEGER'],
};
const NON_COLUMN = ['object', 'array'];

// object/array 字段的列类型（JSON 文本列；同 core Backend::json_type_name）
const JSON_TYPE = ['JSON', 'jsonb', 'TEXT'];
const ID_TYPE = ['VARCHAR(64)', 'TEXT', 'TEXT'];
// 阶段2：`_id` 声明 strategy=autoincrement 时的自增列类型（MySQL AUTO_INCREMENT 列
// 须被索引 —— 表级 PRIMARY KEY 满足；SQLite 语法要求 PRIMARY KEY AUTOINCREMENT 相邻，
// 由 createTable 的 pk+auto 分支拼接；PG 用 SERIAL）。与 py_store/ddl.py 逐字节对齐。
const ID_AUTO_TYPE = ['INT AUTO_INCREMENT', 'SERIAL', 'INTEGER'];
const PRESENT_TYPE = ['VARCHAR(255)', 'TEXT', 'TEXT'];
const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt'];
// creator 权限隐含归属键（A2）：与 py_store/ddl.py 及 core schema/registry.rs 同款。
// 写入路径 creator 权限必注入 createdBy，该列必须建；否则 SQL 层 1054 Unknown column。
const CREATOR_ROLE = 'creator';
const CREATOR_FIELD = 'createdBy';
const MYSQL_PRESENT_MAX = 255;

function idx(backend) {
  return BACKENDS.indexOf(backend);
}

/** 标识符引用（与 core Backend::quote_ident 一致：mysql 反引号，其余双引号） */
function q(backend, ident) {
  if (backend === 'mysql') return '`' + ident.replace(/`/g, '``') + '`';
  return '"' + ident.replace(/"/g, '""') + '"';
}

/**
 * 逻辑名 → 本后端物理标识符（设计 §6）：SQL 后端恒 snake_case。
 * 保留名（I3）：`_id` 物理主键、`__` 前缀哨兵列不翻译。唯一算法在 core::naming（禁自研）。
 */
function pname(backend, logical) {
  if (typeof logical !== 'string' || logical === '') return logical;
  if (logical === '_id' || logical.startsWith('__') || logical.startsWith('^__')) return logical;
  return translateName(logical, backend);
}

/** 集合名 → 物理表名（按目标介质翻译） */
function ptable(backend, defn) {
  return pname(backend, defn.collection || defn.name);
}

function declaredType(fieldDef) {
  return fieldDef && typeof fieldDef === 'object' ? fieldDef.type : fieldDef;
}

/** vector 字段列类型：PG 原生 vector(dim)，MySQL / SQLite 存 JSON 文本（降级） */
function vectorType(backend, fdef) {
  const dim = fdef && typeof fdef === 'object' ? fdef.dim : undefined;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(
      `DDL 生成：vector 字段必须声明正整数 dim，实际 ${JSON.stringify(dim)}`);
  }
  if (backend === 'postgres') return `vector(${dim})`;
  if (backend === 'mysql') return 'JSON';
  return 'TEXT';
}

// pgvector 近似索引（hnsw / ivfflat）维度上限；数值源：rust-store/core `capability::PGVECTOR_INDEX_MAX_DIM`。
// 宿主无法在运行时读取 Rust 常量，故 node / py 各留一份，parity 测试断言两端一致且等于 2000。
const PGVECTOR_INDEX_MAX_DIM = 2000;
const VECTOR_METHODS = ['hnsw', 'ivfflat', 'flat'];
const METRIC_OPS = {
  cosine: 'vector_cosine_ops',
  l2: 'vector_l2_ops',
  ip: 'vector_ip_ops',
};

/** MySQL/SQLite 无原生向量索引：显式反馈并跳过（检索走应用层精确扫描，degraded） */
function _vectorSkipFeedback(defn, backend, field) {
  _emitFeedback({
    type: 'ddl_vector_index_unsupported',
    code: 'vectorIndexUnsupported',
    layer: 'host',
    message: `表 ${defn.collection} 的向量索引（字段 ${field}）在 ${backend} 无原生实现，已跳过`,
    hint: '该后端按应用层精确检索执行；检索结果将标记 degraded=true',
    backend,
    schema: defn.name,
  });
  return [];
}

/** method=flat：不建近似索引的显式反馈 */
function _vectorFlatFeedback(defn, backend, field) {
  _emitFeedback({
    type: 'ddl_vector_index_flat',
    code: 'vectorIndexFlatNoIndex',
    layer: 'host',
    message: `表 ${defn.collection} 的向量索引（字段 ${field}）声明 method=flat，未创建近似索引`,
    hint: 'flat 表示精确扫描；查询仍可用，native=false',
    backend, schema: defn.name,
  });
  return [];
}

/** 向量字段 dim 取值 + 正整数校验（错误优先级与原顺序一致） */
function _vecDimOf(defn, field) {
  const fdef = (defn.fields || {})[field];
  const dim = fdef && typeof fdef === 'object' ? fdef.dim : undefined;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`DDL 生成：向量索引字段 ${field} 缺少正整数 dim`);
  }
  return { dim, fdef };
}

/** pgvector WITH 子句：hnsw 与 ivfflat 各自的参数（默认值与原实现同值） */
function _vecWithClause(method, opts) {
  return method === 'hnsw'
    ? ` WITH (m = ${opts.m || 16}, ef_construction = ${opts.efConstruction || 64})`
    : ` WITH (lists = ${opts.lists || 100})`;
}

/** 向量索引 → CREATE INDEX（PG 原生；MySQL/SQLite 显式反馈不支持；flat 不建索引） */
function vectorIndexStmt(defn, backend, field, opts) {
  if (backend !== 'postgres') return _vectorSkipFeedback(defn, backend, field);
  const { dim, fdef } = _vecDimOf(defn, field);
  const method = opts.method || 'hnsw';
  if (!VECTOR_METHODS.includes(method)) {
    throw new Error(`DDL 生成：向量索引 method 仅支持 ${VECTOR_METHODS.join('/')}，实际 ${JSON.stringify(method)}`);
  }
  if (method === 'flat') return _vectorFlatFeedback(defn, backend, field);
  if (dim > PGVECTOR_INDEX_MAX_DIM) {
    throw new Error(
      `DDL 生成：向量索引字段 ${field} 的 dim=${dim} 超过 pgvector 索引上限 ${PGVECTOR_INDEX_MAX_DIM}（改用 method='flat' 走精确扫描）`
    );
  }
  const metric = opts.metric || (fdef && fdef.metric) || 'cosine';
  const opclass = METRIC_OPS[metric];
  if (!opclass) {
    throw new Error(`DDL 生成：向量索引 metric 仅支持 cosine/l2/ip，实际 ${JSON.stringify(metric)}`);
  }
  const table = ptable(backend, defn);
  const col = pname(backend, field);
  const name = 'idx_' + table + '_' + col + '_vec';
  return [
    `CREATE INDEX ${q(backend, name)} ON ${q(backend, table)} `
    + `USING ${method} (${q(backend, col)} ${opclass})${_vecWithClause(method, opts)}`,
  ];
}

module.exports = {
  BACKENDS,
  TYPES,
  NON_COLUMN,
  JSON_TYPE,
  ID_TYPE,
  ID_AUTO_TYPE,
  PRESENT_TYPE,
  TIMESTAMP_FIELDS,
  CREATOR_ROLE,
  CREATOR_FIELD,
  MYSQL_PRESENT_MAX,
  PGVECTOR_INDEX_MAX_DIM,
  VECTOR_METHODS,
  METRIC_OPS,
  idx,
  q,
  pname,
  ptable,
  declaredType,
  vectorType,
  vectorIndexStmt,
};
