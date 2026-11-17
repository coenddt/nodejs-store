'use strict';

/**
 * 迁移纯逻辑（D4-4 零语义拆分自 migrate.js）
 *
 * 承载：白名单外变更的错误型与固定建议、定义 hash 与版本行自然键、物理命名空间拷贝、
 * 反推类型粒度对齐、段归一与版本号推导 —— 全部无 IO。编排与 IO 留在 ../migrate.js。
 */

const crypto = require('node:crypto');

const { pname, builtinFieldNames } = require('../ddl');
const { MetaDefError, _stableStringify } = require('../metadef');

/** 白名单外变更的固定分步建议（契约逐字；MigrationUnsupported 消息必须原文携带） */
const _UNSUPPORTED_HINT = '白名单外变更请分两版走：先加新列并回填，确认切换后再于下一版删除旧列';

/** 白名单外变更（diff errors 非空）：只给分步建议，不自动执行、不自动回滚 */
class MigrationUnsupported extends MetaDefError {
  constructor(message, skipped) {
    super(message);
    this.name = 'MigrationUnsupported';
    this.skipped = skipped;
  }
}

/** 当前版 defn 的稳定 hash：stableStringify（键序无关）→ SHA-1 hex（与 resource sha1 惯例一致） */
function _hashOf(defn) {
  return crypto.createHash('sha1').update(_stableStringify(defn)).digest('hex');
}

/** 版本行自然键：defId 惯例追加 backend 段（tenant␟env␟backend␟name␟version，\u001f 分隔） */
function migrationId(tenant, env, backend, name, version) {
  const seg = (v) => (v == null ? '' : String(v));
  return `${seg(tenant)}\u001f${seg(env)}\u001f${seg(backend)}\u001f${seg(name)}\u001f${seg(version)}`;
}

/**
 * 内建物理列剔除：introspect→schemaFromRows 拉回的 defn 带 `__present` 哨兵列与宿主自动
 * 补齐的 timestamps / 归属键物理列（snake_case；兼容 camelCase）——不剔则 diff 误报
 * 「删除字段不支持」。
 *
 * 剔除清单**不在本文件自设**，一律取 `ddl.builtinFieldNames`（与 DDL 生成共用同一份内建列
 * 定义）：此前用 `newDefn.timestamps` 真值判断 + 固定两列，与 DDL 的 `!== false` 口径分叉
 * （D1），且漏掉归属键（D2）。
 */
function _stripBuiltinFields(backend, oldDefn, newDefn) {
  if (!oldDefn || typeof oldDefn !== 'object') return oldDefn;
  const drop = newDefn ? builtinFieldNames(newDefn, backend) : ['__present'];
  const fields = { ...oldDefn.fields };
  for (const k of drop) delete fields[k];
  return { ...oldDefn, fields };
}

/**
 * 用户 defn → 物理命名空间拷贝（顶层 fields 键与 indexes keys 经 pname 按后端翻译）。
 *
 * introspect→schemaFromRows 产出的旧 defn 键是物理列名（`view_count`），且物理形式不可逆
 * （core::naming 单向翻译）——故 diff 在物理命名空间进行：new 侧翻到物理名与 old 对齐。
 * pname 对 snake_case 输入幂等，`_id`/`__` 保留名原样（generateMigration 内部再次 pname 无害）。
 */
function _physicalDefn(backend, defn) {
  const fields = Object.fromEntries(
    Object.entries(defn.fields || {}).map(([k, v]) => [pname(backend, k), v]));
  const indexes = (defn.indexes || []).map((ix) => ({
    ...ix,
    keys: Object.fromEntries(
      Object.entries(ix && ix.keys || {}).map(([k, v]) => [pname(backend, k), v])),
  }));
  return { ...defn, fields, indexes };
}

const _NUMERIC = new Set(['int', 'long', 'float', 'double', 'number']);
// 内省反推 `number` 的物理族：SQLite INTEGER 承载 int/long/float/double/date/datetime/bool；
// MySQL BIGINT 承载 long/number/datetime/date，TINYINT(1)（bool）也反推为 number。
// old 侧反推为 number 时，new 声明落在同族内不得判「非放宽变更」（D3）。
const _NUMBER_FAMILY = new Set([..._NUMERIC, 'date', 'datetime', 'bool', 'boolean']);

/**
 * 反推粒度对齐：introspect 反推类型粒度可粗于用户声明（SQLite INTEGER/动态类型 →
 * `number`，承载 int/long/float/double/date/datetime/bool 全域）——old 侧字段为 `number` 时
 * 把 new 侧同名同族字段归一为 `number` 比对（物理层确无差异；MySQL/PG 反推保真不受影响）。
 * 仅同名两侧都有时归一；新加列保留用户类型（DDL 仍按声明产列型）。
 */
function _alignTypes(backend, oldDefn, physNew) {
  const oldFields = (oldDefn && oldDefn.fields) || {};
  const fields = { ...physNew.fields };
  for (const [k, v] of Object.entries(fields)) {
    fields[k] = _alignedField(oldFields[k], v);
  }
  return { ...physNew, fields };
}

/** 单字段粒度对齐：old 侧为 number 且 new 侧同名同族 → 归一为 number；否则原样保留 */
function _alignedField(o, v) {
  const ot = o && (typeof o === 'object' ? o.type : o);
  if (ot !== 'number') return v;
  const nt = v && typeof v === 'object' ? v.type : v;
  if (!_NUMBER_FAMILY.has(nt)) return v;
  return typeof v === 'object' ? { ...v, type: 'number' } : 'number';
}

/** 段归一：null/undefined → 空串（与 metadef 既有 null 处理一致） */
function _segOf(v) { return v == null ? '' : v; }

/** version = 该 name 历史最大 version+1（复用 metadef nextVersion 语义）；from = 当前最新版本 */
function _versionOf(rows) {
  const version = (rows.length ? Math.max(...rows.map((r) => r.version)) : 0) + 1;
  return { version, from: rows.length ? rows[0].version : 0 };
}

module.exports = {
  _UNSUPPORTED_HINT,
  MigrationUnsupported,
  _hashOf,
  migrationId,
  _stripBuiltinFields,
  _physicalDefn,
  _alignTypes,
  _alignedField,
  _segOf,
  _versionOf,
};
