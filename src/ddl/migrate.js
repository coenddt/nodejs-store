'use strict';

/**
 * schema 声明式迁移的生成层（D4-4 零语义拆分自 ddl.js）：字段列型、default 字面量、
 * 归档表 def、逐变更语句与 `generateMigration`，以及归档/内建列补建语句。
 * 只产文本、不执行；与拆分前逐字同语义。
 */

const {
  BACKENDS,
  TYPES,
  NON_COLUMN,
  JSON_TYPE,
  PRESENT_TYPE,
  idx,
  q,
  pname,
  ptable,
  declaredType,
  vectorType,
} = require('./base');
const { createTable, indexStmts, implicitColumns } = require('./table');
const { diffDefs } = require('./diff');

/** 字段 def → 列 SQL 类型（与 columns 同源；object/array → JSON 文本列） */
function fieldSqlType(backend, fdef) {
  const i = idx(backend);
  const ftype = declaredType(fdef);
  if (ftype === 'vector') return vectorType(backend, fdef);
  if (NON_COLUMN.includes(ftype)) return JSON_TYPE[i];
  if (!Object.prototype.hasOwnProperty.call(TYPES, ftype)) {
    throw new Error(
      `迁移生成：字段类型 ${JSON.stringify(ftype)} 未知（支持 ${Object.keys(TYPES).sort()}）`);
  }
  return TYPES[ftype][i];
}

/** default 字面量 → SQL 文本（仅 JSON 标量；SQLite 禁非常量表达式 DEFAULT） */
function sqlLiteral(v) {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`迁移生成：default 仅支持 JSON 标量字面量，收到 ${typeof v}`);
}

/** 主 def → 归档表 def（列 = 主列 + deletedAt；剔除 _id 自增策略；indexes 继承）
 *
 * 主 def 可能已声明 deletedAt（camelCase）或已被 `_physicalDefn` 转成 deleted_at
 * （snake_case）：两种都已存在 → 不再重复追加，否则归档表 CREATE TABLE 会
 * `duplicate column name: deleted_at`。 */
function archiveDefnOf(defn) {
  const fields = { ...(defn.fields || {}) };
  const hasDeleted = Object.keys(fields).some((k) => k === 'deletedAt' || k === 'deleted_at');
  if (!hasDeleted) fields.deletedAt = { type: 'number' };
  if (fields._id && typeof fields._id === 'object') {
    // 剥离 autoincrement 策略（归档表 _id 不自增）——展开+delete 与解构 rest 同值等价
    const rest = { ...fields._id };
    delete rest.strategy;
    fields._id = rest;
  }
  return {
    ...defn,
    name: `${defn.name}Deleted`,
    collection: `${defn.collection || defn.name}_deleted`,
    fields,
    // 归档表列 = 主表列 + deletedAt。**不得**改 timestamps：归档文档由 core 按主表
    // schema 生成（含 created_at / updated_at），若此处置 false 会让归档 INSERT 报
    // `no column named created_at`（默认 timestamps 的表 remove 直接失败）。
    _isArchive: true,
  };
}

/** addTable 分支：主表 + 索引 + 归档表（archive:false（漉金Core 接入扩展 02）→ 同步跳过） */
function _genAddTable(newDefn, backend, stmts) {
  stmts.push(createTable(newDefn, backend));
  stmts.push(...indexStmts(newDefn, backend));
  if (newDefn.archive !== false) {
    const arch = archiveDefnOf(newDefn);
    stmts.push(createTable(arch, backend));
    stmts.push(...indexStmts(arch, backend));
  }
}

/** addColumn 分支：ADD COLUMN（default 校验）+ 归档表跟随 */
function _genAddColumn(ch, newDefn, backend, table, stmts) {
  const ftype = declaredType(ch.field);
  const colType = fieldSqlType(backend, ch.field);
  const deflt = ch.field && typeof ch.field === 'object' ? ch.field.default : undefined;
  const colName = pname(backend, ch.name); // 物理列名（与 createTable 一致）
  let colSql = `${q(backend, colName)} ${colType}`;
  if (deflt !== undefined && deflt !== null) {
    if (NON_COLUMN.includes(ftype) || ftype === 'vector') {
      throw new Error(
        `MIGRATION_UNSUPPORTED: 新列 "${ch.name}"（${ftype} 列）不支持 DEFAULT`
        + '（建新表可设 default；老表新增列必须「加列 + 回填」两步：先 ADD COLUMN 不带 default，'
        + '再回填存量行——漏回填的行按新列过滤会全表不可见；存量行缺失语义由 __present 哨兵表达）');
    }
    colSql += ` DEFAULT ${sqlLiteral(deflt)}`;
  }
  stmts.push(`ALTER TABLE ${q(backend, table)} ADD COLUMN ${colSql}`);
  // 归档表跟随：不同步则归档 insert（显式拷贝全列）因缺列报错；
  // archive:false（漉金Core 接入扩展 02）无归档表，跳过
  if (newDefn.archive !== false) {
    stmts.push(`ALTER TABLE ${q(backend, `${table}_deleted`)} ADD COLUMN ${colSql}`);
  }
}

/** widenColumn 分支：SQLite 不支持；MySQL MODIFY / PG ALTER TYPE USING */
function _genWidenColumn(ch, newDefn, backend, table, stmts) {
  const colType = fieldSqlType(backend, newDefn.fields[ch.name]);
  if (backend === 'sqlite') {
    throw new Error(
      'MIGRATION_UNSUPPORTED: SQLite 不支持类型变更 '
      + `（${ch.from} → ${ch.to} 需重建表）；加列/加索引/加表已支持`);
  }
  if (backend === 'mysql') {
    stmts.push(`ALTER TABLE ${q(backend, table)} MODIFY COLUMN ${q(backend, pname(backend, ch.name))} ${colType}`);
  } else {
    stmts.push(
      `ALTER TABLE ${q(backend, table)} ALTER COLUMN ${q(backend, pname(backend, ch.name))} `
      + `TYPE ${colType} USING ${q(backend, pname(backend, ch.name))}::${colType}`);
  }
}

/** 新旧 schema def → 迁移 SQL 文本列表（per-dialect；只产文本、不执行） */
function generateMigration(backend, oldDefn, newDefn) {
  if (!BACKENDS.includes(backend)) {
    throw new Error(`迁移生成：不支持的后端 ${JSON.stringify(backend)}（支持 ${BACKENDS.join('/')}）`);
  }
  const plan = diffDefs(oldDefn, newDefn);
  if (plan.errors.length) {
    throw new Error(
      'MIGRATION_UNSUPPORTED: ' + plan.errors.join('；')
      + '（首批白名单：加表/加列/类型放宽/加索引；破坏性变更请走显式数据迁移脚本）');
  }

  const table = ptable(backend, newDefn); // 物理表名（与 createTable 一致）
  const stmts = [];
  const order = { addColumn: 0, widenColumn: 1, addIndex: 2 };
  for (const ch of [...plan.changes].sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9))) {
    if (ch.op === 'addTable') _genAddTable(newDefn, backend, stmts);
    else if (ch.op === 'addColumn') _genAddColumn(ch, newDefn, backend, table, stmts);
    else if (ch.op === 'widenColumn') _genWidenColumn(ch, newDefn, backend, table, stmts);
    else if (ch.op === 'addIndex') {
      stmts.push(...indexStmts({ collection: table, fields: newDefn.fields, indexes: [ch.index] }, backend));
    } else {
      throw new Error(`MIGRATION_UNSUPPORTED: 未知变更 ${ch.op}`);
    }
  }
  return stmts;
}

/** 归档表建表语句（列/索引与主表同源）：供迁移补建「主表已存在但 `_deleted` 缺失」的老库。
 * `archive:false` 无归档表 → 返回空数组（与 addTable 分支同口径）。 */
function archiveDDL(backend, defn) {
  if (defn.archive === false) return [];
  const arch = archiveDefnOf(defn);
  return [createTable(arch, backend), ...indexStmts(arch, backend)];
}

/** 补齐缺失内建列的 ALTER 语句（供迁移修复旧版归档表）
 *
 * 旧版 `archiveDefnOf` 固定 `timestamps: false`，历史上建出的 `<table>_deleted`
 * 缺 `created_at` / `updated_at`（归档 INSERT 报 `no column named created_at`）。
 * 内建列不在 diffDefs 的比较范围（diff 只比声明字段），故单独补齐。 */
function implicitColumnDDL(backend, defn, existing) {
  const i = idx(backend);
  const table = ptable(backend, defn);
  const out = [];
  if (!existing.has('__present')) {
    out.push(`ALTER TABLE ${q(backend, table)} ADD COLUMN ${q(backend, '__present')} ${PRESENT_TYPE[i]}`);
  }
  for (const [n, t] of implicitColumns(defn, backend)) {
    const phys = pname(backend, n);
    if (!existing.has(phys)) {
      out.push(`ALTER TABLE ${q(backend, table)} ADD COLUMN ${q(backend, phys)} ${t}`);
    }
  }
  return out;
}

module.exports = {
  fieldSqlType,
  sqlLiteral,
  archiveDefnOf,
  generateMigration,
  archiveDDL,
  implicitColumnDDL,
};
