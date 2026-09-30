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
 *   - schema.indexes（Mongo 形态 {keys: {f: 1|-1}, options/inline}）→ CREATE [UNIQUE] INDEX
 *     （阶段 3 索引落地；原「仅元数据不建索引」铁律 6 子项按用户裁决放开，见
 *     common-store/事务型能力增补执行文档.md 附录 D）。与 py_store/ddl.py 逐字节对齐。
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
// 阶段2：`_id` 声明 strategy=autoincrement 时的自增列类型（MySQL AUTO_INCREMENT 列
// 须被索引 —— 表级 PRIMARY KEY 满足；SQLite 语法要求 PRIMARY KEY AUTOINCREMENT 相邻，
// 由 createTable 的 pk+auto 分支拼接；PG 用 SERIAL）。与 py_store/ddl.py 逐字节对齐。
const ID_AUTO_TYPE = ['INT AUTO_INCREMENT', 'SERIAL', 'INTEGER'];
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

/** 返回 [[name, sqlType, pk, auto]]，顺序：声明的字段（标量 / object·array JSON 列）→ timestamps → __present */
function columns(defn, backend) {
  const i = idx(backend);
  const cols = [];
  const fields = defn.fields || {};
  for (const [name, fdef] of Object.entries(fields)) {
    const ftype = declaredType(fdef);
    if (name === '_id') {
      const strategy = fdef && typeof fdef === 'object' ? fdef.strategy : undefined;
      cols.push([name, strategy === 'autoincrement' ? ID_AUTO_TYPE[i] : ID_TYPE[i], true,
        strategy === 'autoincrement']);
      continue;
    }
    if (NON_COLUMN.includes(ftype)) {
      // object/array → 单列 JSON 文本（同 core field_column_ref::Json）
      cols.push([name, JSON_TYPE[i], false, false]);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(TYPES, ftype)) {
      throw new Error(
        `DDL 生成：字段 "${defn.name}.${name}" 类型 ${JSON.stringify(ftype)} 未知，支持 ${Object.keys(TYPES).sort()}`,
      );
    }
    cols.push([name, TYPES[ftype][i], false, false]);
  }
  if (!cols.some((c) => c[2])) {
    throw new Error(`DDL 生成：schema "${defn.name}" 缺少 _id 字段`);
  }
  if (defn.timestamps !== false) {
    for (const ts of TIMESTAMP_FIELDS) {
      if (!cols.some((c) => c[0] === ts)) cols.push([ts, TYPES.number[i], false, false]);
    }
  }
  cols.push(['__present', PRESENT_TYPE[i], false, false]);
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

/** schema.indexes → CREATE [UNIQUE] INDEX 语句列表（阶段 3 索引落地）。
 * 索引名 `idx_<collection>_<f1>_<f2>`（对齐 SQL 常规命名）；keys 值 1/-1 → ASC/DESC。 */
function indexStmts(defn, backend) {
  const out = [];
  const table = defn.collection || defn.name;
  for (const idx of defn.indexes || []) {
    if (!idx || typeof idx !== 'object') continue;
    const keys = idx.keys;
    if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) continue;
    const unique = Boolean(idx.unique || (idx.options && idx.options.unique));
    const cols = Object.entries(keys)
      .map(([k, v]) => `${q(backend, k)} ${v === -1 ? 'DESC' : 'ASC'}`)
      .join(', ');
    const name = 'idx_' + table + '_' + Object.keys(keys).join('_');
    out.push(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(backend, name)} ON ${q(backend, table)} (${cols})`);
  }
  return out;
}

function createTable(defn, backend) {
  const table = defn.collection || defn.name;
  const cols = columns(defn, backend);
  if (backend === 'mysql') warnPresentOverflow(defn, cols);
  const lines = [];
  for (const [name, ctype, pk, auto] of cols) {
    if (pk && auto && backend === 'sqlite') {
      // SQLite 语法要求 AUTOINCREMENT 紧跟 PRIMARY KEY
      lines.push(`  ${q(backend, name)} ${ctype} PRIMARY KEY AUTOINCREMENT`);
    } else if (pk && backend === 'mysql') lines.push(`  ${q(backend, name)} ${ctype} NOT NULL`);
    else if (pk) lines.push(`  ${q(backend, name)} ${ctype} PRIMARY KEY`);
    else lines.push(`  ${q(backend, name)} ${ctype}`);
  }
  if (backend === 'mysql') lines.push(`  PRIMARY KEY (${q(backend, '_id')})`);
  return `CREATE TABLE ${q(backend, table)} (\n` + lines.join(',\n') + '\n);';
}

/** 生成 DDL 文本（多表以空行分隔，每表 CREATE TABLE 后跟其 CREATE INDEX）；backend ∈ mysql/postgres/sqlite
 *
 * 按表名去重：同名表只出一次 CREATE TABLE + 索引（防御 core 注册表出现重复名 ——
 * 上游失守即告警，禁静默；对齐 py_store/ddl.py 的 seen_tables 防御）。 */
function generate(backend, names) {
  if (!BACKENDS.includes(backend)) {
    throw new Error(`DDL 生成：不支持的后端 ${JSON.stringify(backend)}（支持 ${BACKENDS.join('/')}）`);
  }
  const targets = names && names.length ? Array.from(names) : schema.list();
  const blocks = [];
  const seenTables = new Set();
  const dup = [];
  for (const n of targets) {
    const defn = schema.get(n);
    const table = defn.collection || n;
    if (seenTables.has(table)) {
      dup.push(table);
      continue;
    }
    seenTables.add(table);
    blocks.push(createTable(defn, backend));
    blocks.push(...indexStmts(defn, backend));
  }
  if (dup.length) {
    _emitFeedback({
      type: 'ddl_duplicate_table',
      code: 'ddlDuplicateTable',
      layer: 'host',
      message: `DDL 生成：表 ${[...new Set(dup)].sort()} 重复注册，已去重`,
      hint: 'schema 注册表出现重复名（见 schemaDuplicateName 告警）；修复注册侧根因',
      backend,
    });
  }
  return blocks.join('\n\n');
}

module.exports = { generate };
