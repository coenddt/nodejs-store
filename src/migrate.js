'use strict';

/**
 * 迁移编排器（C3/A4）：diff 两版定义 → 方言 SQL → 事务执行 → `__schemaMigration` 版本行
 *
 * 七步编排（双端一致，执行文档 04 §4.2）：
 *   ① `oldDefs` 显式传入者优先（显式 > 探测）；null → 经 `driver`（原生驱动实例，同
 *      syncSchema 惯例）introspect 拉当前物理结构（`schemaFromRows` 转 defn）；
 *   ② 逐 name `ddl.diffDefs(old, new)`；
 *   ③ errors 非空 → 收集 skipped 并抛 `MigrationUnsupported`（附固定分步建议；不自动执行、不自动回滚）；
 *   ④ 白名单内 `generateMigration` 产方言 SQL 文本（不执行）；
 *   ⑤ 幂等闸：`__schemaMigration` 同 (tenant,env,backend,name) 最新行 hash 相同 → skipped 'unchanged'；
 *   ⑥ 单表 SQL 与版本行在同一事务（runInTransaction）内执行/写入——失败整体回滚、无孤儿版本行；
 *   ⑦ 汇总 `{applied, skipped}`。
 *
 * 边界（执行文档 04 §5 步骤说明）：
 *   - 同批次多表不做跨表事务（每表独立事务 + 版本行）；部分成功按 skipped/applied 对账重跑；
 *   - 破坏性变更被拦后不提供自动回滚——`MigrationUnsupported` 只给分步建议；
 *   - 版本表缺失时按 introspect 探测补建（DDL 由 core `ddl.generate` 产出，宿主不拼 SQL）。
 */

const crypto = require('node:crypto');

const ddl = require('./ddl');
const { pname } = ddl;
const introspect = require('./introspect');
const { core } = require('./schema');
const { MetaDefError, _stableStringify, _runInternal, _MIGRATION } = require('./metadef');
const crud = require('./crud');
const { runInTransaction, executeRaw } = require('./datasource');

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
 * 内建物理列剔除：introspect→schemaFromRows 拉回的 defn 带 `__present` 哨兵列与
 * timestamps 物理列（宿主 DDL 的 snake_case：`created_at`/`updated_at`；兼容 camelCase），
 * 而用户 defn 不声明它们——不剔则 diff 误报「删除字段不支持」。
 * 注意 schemaFromRows 推断 `timestamps: false`，剔除条件看用户侧 defn 的声明。
 */
function _stripBuiltinFields(oldDefn, newDefn) {
  if (!oldDefn || typeof oldDefn !== 'object') return oldDefn;
  const drop = ['__present'];
  if (newDefn && newDefn.timestamps) drop.push('created_at', 'updated_at', 'createdAt', 'updatedAt');
  const fields = { ...oldDefn.fields };
  for (const k of drop) delete fields[k];
  return { ...oldDefn, fields };
}

/** 版本表存在性探测 SQL（表名为常量非用户输入，内联无注入面；宿主只读 SELECT，
 *  同 `introspect/<backend>.js` 既有惯例——introspect 需原生驱动实例，连接视图不暴露） */
const _PROBE_SQL = {
  sqlite: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${_MIGRATION}'`,
  mysql: `SELECT table_name AS name FROM information_schema.tables`
    + ` WHERE table_schema = DATABASE() AND table_name = '${_MIGRATION}'`,
  postgres: `SELECT table_name AS name FROM information_schema.tables`
    + ` WHERE table_name = '${_MIGRATION}' AND table_schema = current_schema()`,
};

async function _hasMigrationTable(backend, source) {
  const out = await executeRaw(source, _PROBE_SQL[backend], null, false);
  return (out.rows || []).length > 0;
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

/**
 * 反推粒度对齐：introspect 反推类型粒度可粗于用户声明（SQLite INTEGER/动态类型 →
 * `number`，承载 int/long/float/double 全域）——old 侧字段为 `number` 时把 new 侧同名
 * 数值字段归一为 `number` 比对（物理层确无差异；MySQL/PG 反推保真不受影响）。
 * 仅同名两侧都有时归一；新加列保留用户类型（DDL 仍按声明产列型）。
 */
function _alignTypes(backend, oldDefn, physNew) {
  const oldFields = (oldDefn && oldDefn.fields) || {};
  const fields = { ...physNew.fields };
  for (const [k, v] of Object.entries(fields)) {
    const o = oldFields[k];
    const ot = o && (typeof o === 'object' ? o.type : o);
    const nt = v && typeof v === 'object' ? v.type : v;
    if (ot === 'number' && _NUMERIC.has(nt)) {
      fields[k] = typeof v === 'object' ? { ...v, type: 'number' } : 'number';
    }
  }
  return { ...physNew, fields };
}

/**
 * 迁移编排（A4）。
 *
 * @param {object} o
 * @param {'sqlite'|'mysql'|'postgres'} o.backend 方言后端
 * @param {string} o.source 数据源名（DDL 与版本表同源同事务）
 * @param {object} o.defs 目标定义 `{name: defn}`（与 persistDef 的 defn 同构）
 * @param {object|null} [o.oldDefs] 旧版定义 `{name: defn}`；null → introspect 探测（需 `driver`）
 * @param {object|null} [o.driver] 原生驱动实例（introspect 用；连接视图不暴露原生 handle，
 *   同 `syncSchema` 的 driver 惯例。oldDefs=null 时必填）
 * @param {string|null} [o.tenant] 租户段（null → 空串段，与 metadef 既有 null 处理一致）
 * @param {string|null} [o.env] 环境段（null → 空串段）
 * @returns {Promise<{applied: Array<{name, from, to, version}>, skipped: Array<{name, reason}>}>}
 */
async function migrate({ backend, source, defs, oldDefs = null, driver = null,
                         tenant = null, env = null } = {}) {
  if (!backend || !source || !defs || typeof defs !== 'object' || Array.isArray(defs)) {
    throw new MetaDefError('migrate: backend/source/defs 必填（defs 为 {name: defn} 对象）');
  }
  // 版本表保障：有 driver 时一次完整 introspect（两用：版本表探测 + oldDefs=null 转 defn）；
  // 无 driver 时退化为 executeRaw 只读探测。缺失才建（core 产 DDL；CREATE TABLE 非 IF NOT
  // EXISTS，幂等由探测保证）。ddl.generate 返回 `\n\n` 拼接语句串，executeRaw 单次单语句。
  let probe = null;
  let hasVersionTable = false;
  if (driver) {
    probe = await introspect.run(backend, driver, undefined);
    hasVersionTable = probe.tables.some((t) => t.name === _MIGRATION);
  } else {
    hasVersionTable = await _hasMigrationTable(backend, source);
  }
  if (!hasVersionTable) {
    const ensure = ddl.generate(backend, [_MIGRATION]);
    await runInTransaction(source, async () => {
      for (const sql of ensure.split('\n\n')) {
        if (sql.trim()) await executeRaw(source, sql, null, true);
      }
    });
  }
  // ① 旧版定义：oldDefs 显式传入者优先；null → 复用本次探测行转 defn（需 driver）。
  // schemaFromRows 的 name 是物理表名（如 `notes`），与 defs 的 schema 名（如 `Note`）
  // 不同键——按 name 与 collection 双索引，查找时以 defs 侧 collection 兜底对齐
  let old = oldDefs;
  if (old === null || old === undefined) {
    if (!probe) {
      throw new MetaDefError(
        'migrate: oldDefs 为 null 时需传 driver（introspect 需原生驱动实例，同 syncSchema 惯例）；'
        + '或显式传入 oldDefs 跳过探测');
    }
    old = {};
    for (const d of core.schemaFromRows(probe, backend)) {
      old[d.name] = d;
      if (d.collection && d.collection !== d.name) old[d.collection] = d;
    }
  }
  const applied = [];
  const skipped = [];
  for (const [name, defn] of Object.entries(defs)) {
    const oldDefn = _stripBuiltinFields(old[name] || (defn.collection && old[defn.collection]) || null, defn);
    // ⑤ 幂等闸（先于 diff）：同 (tenant,env,backend,name) 最新版本行 hash 相同 → skipped
    // 'unchanged'，不 diff——introspect 反推类型粒度（如 SQLite INTEGER→number）与用户声明
    // 粒度（int）不齐，重跑不应进 diff 被误报
    const hash = _hashOf(defn);
    const seg = { tenant: tenant == null ? '' : tenant, env: env == null ? '' : env, backend, name };
    const rows = await crud.query(
      `${_MIGRATION}($condition:@c0, $sort:@s0){_id, version, hash}`,
      { c0: seg, s0: { version: -1 } }, { source });
    if (rows.length && rows[0].hash === hash) {
      skipped.push({ name, reason: 'unchanged' });
      continue;
    }
    // ②③ diff（物理命名空间）：白名单外 → 收集 skipped 并抛 MigrationUnsupported（固定分步建议）
    const physNew = _alignTypes(backend, oldDefn, _physicalDefn(backend, defn));
    const plan = ddl.diffDefs(oldDefn, physNew);
    if (plan.errors.length) {
      skipped.push({ name, reason: plan.errors });
      throw new MigrationUnsupported(
        `MIGRATION_UNSUPPORTED: ${plan.errors.join('；')}（${_UNSUPPORTED_HINT}）`,
        skipped);
    }
    // ④ 方言 SQL（纯文本）
    const stmts = ddl.generateMigration(backend, oldDefn, physNew);
    // version = 该 name 历史最大 version+1（复用 metadef nextVersion 语义）
    const version = (rows.length ? Math.max(...rows.map((r) => r.version)) : 0) + 1;
    // ⑥ SQL 与版本行同事务：失败整体回滚、无孤儿版本行
    await runInTransaction(source, async () => {
      for (const sql of stmts) await executeRaw(source, sql, null, true);
      await _runInternal(() => crud.insert(_MIGRATION, {
        _id: migrationId(tenant, env, backend, name, version),
        ...seg,
        hash,
        version,
        appliedAt: Date.now(),
        sqls: stmts,
      }, { source }));
    });
    applied.push({ name, from: rows.length ? rows[0].version : 0, to: version, version });
  }
  // ⑦ 汇总
  return { applied, skipped };
}

// 单函数入口导出（辅助件挂函数属性；错误类另在 src/index.js 顶层直达）
migrate.MigrationUnsupported = MigrationUnsupported;
migrate.migrationId = migrationId;
migrate.UNSUPPORTED_HINT = _UNSUPPORTED_HINT;

module.exports = { migrate, MigrationUnsupported, migrationId, _UNSUPPORTED_HINT };
