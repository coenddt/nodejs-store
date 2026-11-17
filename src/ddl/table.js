'use strict';

/**
 * DDL 建表层（D4-4 零语义拆分自 ddl.js）：内建列推导、列元组构造、索引语句生成、
 * CREATE TABLE 文本。纯函数，与拆分前逐字同语义。
 */

const { emit: _emitFeedback } = require('../feedback-core');
const {
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
  idx,
  q,
  pname,
  ptable,
  declaredType,
  vectorType,
  vectorIndexStmt,
} = require('./base');

/** read/write 是否含 creator 伪角色（决定归属键必建；与 core 同口径） */
function hasCreatorPermission(defn) {
  const has = (roles) => Array.isArray(roles) && roles.includes(CREATOR_ROLE);
  return has(defn.read) || has(defn.write);
}

/**
 * owner 行控使用的归属键名；null = 不使用 owner 行控（不补列）。
 *
 * ownerKey 缺省 = createdBy；`_id` 是系统主键，DDL 已建，不重复补列。
 * 与 core schema/registry.rs::add_owner_field 同口径。
 */
function ownerField(defn) {
  if (!hasCreatorPermission(defn)) return null;
  const declared = defn.ownerKey;
  const name = typeof declared === 'string' && declared ? declared : CREATOR_FIELD;
  return name === '_id' ? null : name;
}

/** 宿主自动补齐的内建列清单（**DDL 生成与迁移剔除共用的唯一来源**）。
 *
 * 返回 [[逻辑名, sqlType]]，顺序：timestamps → 归属键（owner 行控隐含）。
 * `__present` 与声明字段不在此列（分别由 columns / 调用方处理）。
 * timestamps 判定与 DDL 同口径：**未声明即建**（`!== false`），而不是真值判断——
 * 这正是 D1 的根因（迁移剔除曾用真值判断，与 DDL 分叉）。 */
function implicitColumns(defn, backend) {
  const i = idx(backend);
  const out = [];
  if (defn.timestamps !== false) {
    for (const ts of TIMESTAMP_FIELDS) out.push([ts, TYPES.number[i]]);
  }
  const owner = ownerField(defn);
  if (owner) out.push([owner, TYPES.string[i]]);
  return out;
}

/** 内建物理列名清单（迁移剔除用；与 implicitColumns 同源）。
 *
 * 「内建」= 宿主按 schema 声明自动建、但用户未显式声明的列：`__present` 哨兵 +
 * timestamps + 归属键。用户显式声明了同名字段时**不剔除**（该列已参与字段 diff，
 * 误剔会被当成「新增列」重复 ADD COLUMN）。同时返回物理名与逻辑名，兼容显式传入
 * camelCase 形式的 oldDefs。 */
function builtinFieldNames(defn, backend) {
  const declared = defn.fields || {};
  const declaredPhys = new Set(Object.keys(declared).map((k) => pname(backend, k)));
  const names = ['__present'];
  for (const [logical] of implicitColumns(defn, backend)) {
    const phys = pname(backend, logical);
    if (declaredPhys.has(phys) || Object.prototype.hasOwnProperty.call(declared, logical)) continue;
    names.push(phys);
    if (phys !== logical) names.push(logical);
  }
  return names;
}

/** 单声明字段 → 列元组 [col, type, pk, auto]；未知类型抛错（错误文案与原实现逐字一致） */
function _columnOf(defn, backend, i, name, fdef) {
  const col = pname(backend, name); // 列标识符按目标介质翻译（snake_case）
  if (name === '_id') {
    const strategy = fdef && typeof fdef === 'object' ? fdef.strategy : undefined;
    return [col, strategy === 'autoincrement' ? ID_AUTO_TYPE[i] : ID_TYPE[i], true,
      strategy === 'autoincrement'];
  }
  const ftype = declaredType(fdef);
  if (ftype === 'vector') return [col, vectorType(backend, fdef), false, false];
  if (NON_COLUMN.includes(ftype)) {
    // object/array → 单列 JSON 文本（同 core field_column_ref::Json）
    return [col, JSON_TYPE[i], false, false];
  }
  if (!Object.prototype.hasOwnProperty.call(TYPES, ftype)) {
    throw new Error(
      `DDL 生成：字段 "${defn.name}.${name}" 类型 ${JSON.stringify(ftype)} 未知，支持 ${Object.keys(TYPES).sort()}`,
    );
  }
  return [col, TYPES[ftype][i], false, false];
}

/** 返回 [[name, sqlType, pk, auto]]，顺序：声明的字段（标量 / object·array JSON 列）→
 * timestamps → 归属键（owner 行控隐含）→ __present */
function columns(defn, backend) {
  const i = idx(backend);
  const cols = [];
  const fields = defn.fields || {};
  for (const [name, fdef] of Object.entries(fields)) {
    cols.push(_columnOf(defn, backend, i, name, fdef));
  }
  if (!cols.some((c) => c[2])) {
    throw new Error(`DDL 生成：schema "${defn.name}" 缺少 _id 字段`);
  }
  // 内建列（timestamps → 归属键）统一来自 implicitColumns：已声明则沿用声明列型，不重复补列。
  for (const [logical, sqlType] of implicitColumns(defn, backend)) {
    const col = pname(backend, logical);
    if (!cols.some((c) => c[0] === col)) cols.push([col, sqlType, false, false]);
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

/** 向量索引条目分流：keys 中有 "vector" 值时返回其语句（非单字段抛错）；否则 null 走普通索引 */
function _vectorIndexEntry(defn, backend, idx) {
  const keys = idx.keys;
  const vecKey = Object.entries(keys).find(([, v]) => v === 'vector');
  if (!vecKey) return null;
  if (Object.keys(keys).length !== 1) {
    throw new Error('DDL 生成：向量索引必须是单字段（keys 仅一个 "字段": "vector"）');
  }
  return vectorIndexStmt(defn, backend, vecKey[0], idx.options || {});
}

/** 普通复合索引 → CREATE [UNIQUE] INDEX 语句（keys 值 1/-1 → ASC/DESC） */
function _plainIndexStmt(backend, idx, table) {
  const keys = idx.keys;
  const unique = Boolean(idx.unique || (idx.options && idx.options.unique));
  const physKeys = Object.keys(keys).map((k) => pname(backend, k));
  const cols = Object.entries(keys)
    .map(([, v], i) => `${q(backend, physKeys[i])} ${v === -1 ? 'DESC' : 'ASC'}`)
    .join(', ');
  const name = 'idx_' + table + '_' + physKeys.join('_');
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(backend, name)} ON ${q(backend, table)} (${cols})`;
}

/** schema.indexes → CREATE [UNIQUE] INDEX 语句列表（阶段 3 索引落地）。
 * 索引名 `idx_<collection>_<f1>_<f2>`（对齐 SQL 常规命名）；keys 值 1/-1 → ASC/DESC。 */
function indexStmts(defn, backend) {
  const out = [];
  const table = ptable(backend, defn); // 物理表名（按目标介质翻译）
  for (const idx of defn.indexes || []) {
    if (!idx || typeof idx !== 'object') continue;
    const keys = idx.keys;
    if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) continue;
    const vec = _vectorIndexEntry(defn, backend, idx);
    if (vec) {
      out.push(...vec);
      continue;
    }
    out.push(_plainIndexStmt(backend, idx, table));
  }
  return out;
}

function createTable(defn, backend) {
  const table = ptable(backend, defn); // 物理表名（按目标介质翻译）
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

module.exports = {
  hasCreatorPermission,
  ownerField,
  implicitColumns,
  builtinFieldNames,
  columns,
  warnPresentOverflow,
  indexStmts,
  createTable,
};
