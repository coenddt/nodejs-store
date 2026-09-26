'use strict';

/**
 * DDL 生成（schema def → CREATE TABLE 文本；纯函数，不连库、不回写）
 *
 * 与 core 契约严格对齐（schema→DDL 单向映射）：
 *   - 标量字段按声明类型建列；object/array 字段建 **JSON 列**（MySQL `JSON` / PG `jsonb` /
 *     SQLite `TEXT`，同 core dialect::Backend::json_type_name）——落单列存 JSON 文本，
 *     读侧由 core row::parse_json_col 还原为嵌套对象，跨后端对齐 Mongo 嵌套文档；
 *   - 每表必建 __present 哨兵列（形态 ,f1,f2,；同 core write/insert.rs::present_value）；
 *   - timestamps !== false → 追加 createdAt / updatedAt（同 core schema/registry.rs::add_timestamp_fields）；
 *   - 归档表 <collection>_deleted 由 registry 自动派生，本模块按已注册 def 逐表生成（不特判）；
 *   - 不生成 CREATE INDEX（SQL 后端不建索引，schema.indexes 仅元数据，铁律 6）。
 *
 * 生成器只产出文本、不执行 —— 不违反铁律 6（绝不写 DDL 回库）。
 * 对齐 py_store/ddl.py（两端输出逐字节一致）。
 */

const { emit: _emitFeedback } = require('./feedback');
const schema = require('./schema');

const BACKENDS = ['mysql', 'postgres', 'sqlite'];

// schema 声明类型 → [mysql, postgres, sqlite] 列类型
const TYPES = {
  string: ['VARCHAR(255)', 'TEXT', 'TEXT'],
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
const PRESENT_TYPE = ['VARCHAR(255)', 'TEXT', 'TEXT'];
const TIMESTAMP_FIELDS = ['createdAt', 'updatedAt'];
const MYSQL_PRESENT_MAX = 255;

function idx(backend) {
  return BACKENDS.indexOf(backend);
}

/** 标识符引用（与 core Backend::quote_ident 一致：mysql 反引号，其余双引号） */
function q(backend, ident) {
  if (backend === 'mysql') return '`' + ident.replace(/`/g, '``') + '`';
  return '"' + ident.replace(/"/g, '""') + '"';
}

function declaredType(fieldDef) {
  return fieldDef && typeof fieldDef === 'object' ? fieldDef.type : fieldDef;
}

/** 返回 [[name, sqlType, pk]]，顺序：声明的字段（标量 / object·array JSON 列）→ timestamps → __present */
function columns(defn, backend) {
  const i = idx(backend);
  const cols = [];
  const fields = defn.fields || {};
  for (const [name, fdef] of Object.entries(fields)) {
    const ftype = declaredType(fdef);
    if (name === '_id') {
      cols.push([name, ID_TYPE[i], true]);
      continue;
    }
    if (NON_COLUMN.includes(ftype)) {
      // object/array → 单列 JSON 文本（同 core field_column_ref::Json）
      cols.push([name, JSON_TYPE[i], false]);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(TYPES, ftype)) {
      throw new Error(
        `DDL 生成：字段 "${defn.name}.${name}" 类型 ${JSON.stringify(ftype)} 未知，支持 ${Object.keys(TYPES).sort()}`,
      );
    }
    cols.push([name, TYPES[ftype][i], false]);
  }
  if (!cols.some((c) => c[2])) {
    throw new Error(`DDL 生成：schema "${defn.name}" 缺少 _id 字段`);
  }
  if (defn.timestamps !== false) {
    for (const ts of TIMESTAMP_FIELDS) {
      if (!cols.some((c) => c[0] === ts)) cols.push([ts, TYPES.number[i], false]);
    }
  }
  cols.push(['__present', PRESENT_TYPE[i], false]);
  return cols;
}

/** MySQL __present VARCHAR(255) 容量校验：超限即告警（不静默） */
function warnPresentOverflow(defn, cols) {
  const length = cols.reduce((n, c) => n + c[0].length, 0) + cols.length + 1;
  if (length > MYSQL_PRESENT_MAX) {
    _emitFeedback({
      type: 'ddl_present_overflow',
      code: 'ddlPresentOverflow',
      layer: 'host',
      message: `表 ${defn.collection} 的 __present 预估长度 ${length} 超过 MySQL VARCHAR(255)`,
      hint: '为该表改用 TEXT 列，或减少标量字段；否则写入会被截断/报错，导致 $eq:null / $exists 三态判定错误',
      schema: defn.name,
    });
  }
}

function createTable(defn, backend) {
  const table = defn.collection || defn.name;
  const cols = columns(defn, backend);
  if (backend === 'mysql') warnPresentOverflow(defn, cols);
  const lines = [];
  for (const [name, ctype, pk] of cols) {
    if (pk && backend === 'mysql') lines.push(`  ${q(backend, name)} ${ctype} NOT NULL`);
    else if (pk) lines.push(`  ${q(backend, name)} ${ctype} PRIMARY KEY`);
    else lines.push(`  ${q(backend, name)} ${ctype}`);
  }
  if (backend === 'mysql') lines.push(`  PRIMARY KEY (${q(backend, '_id')})`);
  return `CREATE TABLE ${q(backend, table)} (\n` + lines.join(',\n') + '\n);';
}

/** 生成 DDL 文本（多表以空行分隔）；backend ∈ mysql/postgres/sqlite */
function generate(backend, names) {
  if (!BACKENDS.includes(backend)) {
    throw new Error(`DDL 生成：不支持的后端 ${JSON.stringify(backend)}（支持 ${BACKENDS.join('/')}）`);
  }
  const targets = names && names.length ? Array.from(names) : schema.list();
  return targets.map((n) => createTable(schema.get(n), backend)).join('\n\n');
}

module.exports = { generate };
