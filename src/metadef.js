'use strict';

/**
 * meta-store 定义持久化与版本化（宿主层；core 无 IO 铁律）
 *
 * 设计见 doc/execution/2026/10/meta-store定义控制面-01（A1/A2/A3）。三条契约：
 *   - 定义落库为内建 schema `__schemaDef`（tenant/env/name/version/defn 五要素）；
 *   - 同名同形幂等不新增行，异形 version+1；
 *   - 版本历史可列（append-only），`rollbackTo` 以历史 defn **追加新版本**（跨进程经 `restoreDefs` 对协议面可见）。
 *
 * 对齐 `py-store/src/py_store/metadef.py`（双宿主流库行内容逐字节一致由对拍脚本守护）。
 * 存储是 IO，故落宿主层，core 零改动。
 *
 * D4-4 零语义拆分：内建表模型与纯逻辑（序列化 / 行构造 / 自然键）下沉 ./metadef/model，
 * 本文件保留注册编排与 IO；导出面（键名 / 键序 / 语义）与拆分前逐字一致。
 */

const { has: _hasSchema, register: _registerSchema, _toCoreDefn } = require('./schema');
const { register: _registerWorkflow } = require('./workflow');
const { _als } = require('./permission');
const {
  _SCHEMA_DEF,
  _WORKFLOW_DEF,
  _FEEDBACK,
  _MIGRATION,
  MetaDefError,
  _SCHEMA_DEF_MODEL,
  _WORKFLOW_DEF_MODEL,
  _MIGRATION_MODEL,
  _FEEDBACK_MODEL,
  _assertSerializable,
  _stableStringify,
  sameDefn,
  nextVersion,
  buildDefRow,
  defId,
} = require('./metadef/model');

// 读取投影（双端一致；对拍比较用）
const _DEF_FIELDS = '_id, tenant, env, name, version, defn, status, createdBy';

// 定义类型（kind）→ 内建表名 / 注册函数（缺省 schema，保既有调用零变更）
const _TABLES = { schema: _SCHEMA_DEF, workflow: _WORKFLOW_DEF };
// 注册函数：(defn, internal) → 注册到对应注册表；internal 仅供系统重建（restore）使用
const _REGISTRARS = {
  schema: (defn, internal) => _registerSchema(defn, internal ? { internal: true } : undefined),
  workflow: (defn, internal) => _registerWorkflow(defn, internal ? { internal: true } : undefined),
};

/** 解析 kind → {kind, table}；未知 kind 显式 Err（不兜底） */
function _kindOf(opts) {
  const kind = (opts && opts.kind) || 'schema';
  const table = _TABLES[kind];
  if (!table) throw new MetaDefError(`metadef: 未知定义类型 ${JSON.stringify(kind)}`);
  return { kind, table };
}

/** 注册内建 `__schemaDef`/`__workflowDef`/`__feedback`/`__schemaMigration`（幂等；core 对重复三元组显式报错，故先 has 守卫） */
function ensureBuiltins() {
  if (!_hasSchema(_SCHEMA_DEF)) _registerSchema(_SCHEMA_DEF_MODEL);
  if (!_hasSchema(_WORKFLOW_DEF)) _registerSchema(_WORKFLOW_DEF_MODEL);
  if (!_hasSchema(_FEEDBACK)) _registerSchema(_FEEDBACK_MODEL);
  if (!_hasSchema(_MIGRATION)) _registerSchema(_MIGRATION_MODEL);
}

/** 干净 internal 上下文（{internal: true}，丢弃触发者 roles）——内建表写约束对齐 __workflowRun */
function _runInternal(fn) {
  return _als.run({ internal: true }, fn);
}

// ─── IO（经传入的 store 面，避免包内循环依赖） ─────────────────

/** 列定义行（按 version desc；name 缺省列全部） */
async function listDefs(store, opts) {
  const o = opts || {};
  const { table } = _kindOf(o);
  const condition = { tenant: o.tenant, env: o.env };
  if (o.name !== undefined) condition.name = o.name;
  const gql = `${table}($condition:@c0, $sort:@s0){${_DEF_FIELDS}}`;
  return store.query(gql, { c0: condition, s0: { version: -1 } });
}

/** 各 name 的**最新 active** 行（每 name 取 version 最大者；version desc 后首见即最新） */
async function loadDefs(store, opts) {
  const o = opts || {};
  const { table } = _kindOf(o);
  const gql = `${table}($condition:@c0, $sort:@s0){${_DEF_FIELDS}}`;
  const rows = await store.query(gql, {
    c0: { tenant: o.tenant, env: o.env, status: 'active' },
    s0: { version: -1 },
  });
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out;
}

/** 持久化定义：同名同形返回原行不插入；异形插入 version+1 */
async function persistDef(store, defn, opts) {
  if (!defn || typeof defn.name !== 'string' || !defn.name) {
    throw new MetaDefError('metadef: defn.name 必填');
  }
  const o = opts || {};
  const { table } = _kindOf(o);
  _assertSerializable(defn, '');              // ← 新增：回调类定义不可持久化（先于 IO 与归一化）
  const rows = await listDefs(store, { tenant: o.tenant, env: o.env, name: defn.name, kind: o.kind });
  const latest = rows.length ? rows[0] : null;
  const coreDefn = _toCoreDefn(defn); // 函数值剔除（纯 JSON 入库，A3 前提）
  if (latest && sameDefn(latest.defn, coreDefn)) return latest;
  const version = nextVersion(rows);
  const row = buildDefRow(coreDefn, o, version);
  // 自然键 `_id`（D2）：同版本并发写必冲突 → 存储层保证 version 唯一
  row._id = defId(o.tenant, o.env, coreDefn.name, version);
  return _runInternal(() => store.insert(table, row));
}

/** 已重建进注册表的定义自然键（进程级；同名同版本只注册一次，避免每次 reload 全量覆盖） */
const _applied = new Set();

/**
 * 从持久化定义重建注册表（D1 闭环桥）：`loadDefs` → 逐条 `register(defn, internalCtx)`。
 *
 * 网关 reload 在重装配前调用本函数，使「控制面 publish（写库）」与「协议面可见（注册）」
 * 经 reload 衔接。已注册过的同版本跳过（幂等）；版本变化时以新 defn 覆盖注册。
 * 注册走 internal 上下文：属系统重建动作，不受业务定义层门禁（MetaPolicy）影响。
 * @returns {Promise<{total: number, applied: number}>} total=库内最新 active 行数；applied=本次新注册数
 */
async function restoreDefs(store, opts) {
  const o = opts || {};
  const { kind } = _kindOf(o);
  const rows = await loadDefs(store, o);
  let applied = 0;
  for (const r of rows) {
    const key = `${kind}\u001f${defId(o.tenant, o.env, r.name, r.version)}`;
    if (_applied.has(key)) continue;
    _REGISTRARS[kind](r.defn, true);
    _applied.add(key);
    applied += 1;
  }
  return { total: rows.length, applied };
}

/**
 * 回滚到历史版本（追加式）：取历史行 defn → 作为新版本再发布 → 本进程 register → 返回落库行。
 *
 * D21 跨进程闭环：回滚不再「原地重注册」，而是复用 `persistDef` 把历史 defn 落成一条
 * **新版本行**（同名同形幂等 → 返回当前最新行）。`loadDefs` 取「最新 active」故必然返回
 * 该行，网关 `restoreDefs` hydrate 即按回滚后的 defn 装配 —— 回滚对协议面可见。
 * 历史保持 append-only：目标历史行不被改写。
 */
async function rollbackTo(store, opts) {
  const o = opts || {};
  const { kind } = _kindOf(o);
  const rows = await listDefs(store, { tenant: o.tenant, env: o.env, name: o.name, kind: o.kind });
  const row = rows.find((r) => r.version === o.version) || null;
  if (!row) throw new MetaDefError(`metadef: 版本不存在 ${o.name}@${o.version}`);
  // 追加式回滚：以历史 defn 走 persist 语义（异形 → version+1；同形 → 返回当前最新）
  const persisted = await persistDef(store, row.defn, o);
  // 系统重建动作：workflow 走 internal；schema 维持既有调用形态（false = 无 ctx，门禁行为零变更）
  _REGISTRARS[kind](row.defn, kind === 'workflow');
  return persisted;
}

// 模块导入即自举内建定义表（幂等；零配置）
ensureBuiltins();

module.exports = {
  MetaDefError,
  ensureBuiltins,
  sameDefn,
  nextVersion,
  buildDefRow,
  defId,
  listDefs,
  loadDefs,
  persistDef,
  restoreDefs,
  rollbackTo,
  // parity 锚与内部件（下划线内部语义）
  _stableStringify,
  _assertSerializable,
  _runInternal,
  _SCHEMA_DEF_MODEL,
  _WORKFLOW_DEF_MODEL,
  _FEEDBACK_MODEL,
  _MIGRATION,
  _MIGRATION_MODEL,
};
