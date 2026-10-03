'use strict';

/**
 * meta-store 定义持久化与版本化（宿主层；core 无 IO 铁律）
 *
 * 设计见 doc/execution/2026/10/meta-store定义控制面-01（A1/A2/A3）。三条契约：
 *   - 定义落库为内建 schema `__schemaDef`（tenant/env/name/version/defn 五要素）；
 *   - 同名同形幂等不新增行，异形 version+1；
 *   - 版本历史可列，`rollbackTo` 按历史 defn 重新 register。
 *
 * 对齐 `py-store/src/py_store/metadef.py`（双宿主流库行内容逐字节一致由对拍脚本守护）。
 * 存储是 IO，故落宿主层，core 零改动。
 */

const { has: _hasSchema, register: _registerSchema, _toCoreDefn } = require('./schema');
const { _als } = require('./permission');

// 内建定义表名（`__` 前缀为内建保留名，对齐 workflow 的 name.startsWith('__') 校验）
const _SCHEMA_DEF = '__schemaDef';
const _WORKFLOW_DEF = '__workflowDef';
const _FEEDBACK = '__feedback';
// 读取投影（双端一致；对拍比较用）
const _DEF_FIELDS = '_id, tenant, env, name, version, defn, status, createdBy';

/**
 * 内建定义表 schema（write 显式空名单：普通角色禁写，防篡改定义审计）
 *
 * 不声明 indexes：内建表随宿主注册表进入 `ddl.generate()`，而场景 harness 会对全部
 * 注册表执行其中的 CREATE INDEX（建表仅限业务表）——为内建表加索引会令其对未建的
 * 内建表建索引而报错。版本唯一性改由行自然键 `_id`（见 `defId`，D2）在**存储层**保证：
 * 并发写同版本必触发唯一键冲突，按 §4.4 显式上抛（不重试、不吞）。
 */
function _defModel(name, idPrefix) {
  return {
    name,
    system: true,
    collection: name,
    idPrefix,
    write: [],
    fields: {
      _id: { type: 'string' },
      tenant: { type: 'string' },
      env: { type: 'string' },
      name: { type: 'string' },
      version: { type: 'int' },
      defn: { type: 'object' },
      status: { type: 'string' },
      createdBy: { type: 'string' },
    },
  };
}

const _SCHEMA_DEF_MODEL = _defModel(_SCHEMA_DEF, 'sdef');
const _WORKFLOW_DEF_MODEL = _defModel(_WORKFLOW_DEF, 'wdef');

// 内建反馈事件表（05）：承载结构化降级/拦截事件（write 空名单——普通角色禁写，事件审计）
const _FEEDBACK_MODEL = {
  name: _FEEDBACK,
  system: true,
  collection: _FEEDBACK,
  idPrefix: 'fdbk',
  write: [],
  fields: {
    _id: { type: 'string' },
    type: { type: 'string' },
    code: { type: 'string' },
    layer: { type: 'string' },
    message: { type: 'string' },
    hint: { type: 'string' },
    tenant: { type: 'string' },
    env: { type: 'string' },
    now: { type: 'number' },
  },
};

/** 注册内建 `__schemaDef`/`__workflowDef`/`__feedback`（幂等；core 对重复三元组显式报错，故先 has 守卫） */
function ensureBuiltins() {
  if (!_hasSchema(_SCHEMA_DEF)) _registerSchema(_SCHEMA_DEF_MODEL);
  if (!_hasSchema(_WORKFLOW_DEF)) _registerSchema(_WORKFLOW_DEF_MODEL);
  if (!_hasSchema(_FEEDBACK)) _registerSchema(_FEEDBACK_MODEL);
}

/** metadef 契约失败（defn.name 缺失 / 版本不存在 / 唯一冲突） */
class MetaDefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetaDefError';
  }
}

// ─── 纯逻辑（双端逐字节等价；parity 锚） ───────────────────────

/** 稳定序列化（键序无关）：与 py `stable_stringify` 逐字节等价 */
function _stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(_stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_stableStringify(v[k])}`).join(',')}}`;
}

/** 两 defn 是否同形（深比较；键序无关） */
function sameDefn(a, b) {
  return _stableStringify(a) === _stableStringify(b);
}

/** 由既有行推下一个版本号（无行 → 1） */
function nextVersion(rows) {
  return rows.length ? Math.max(...rows.map((r) => r.version)) + 1 : 1;
}

/** 构造待插入行（纯函数，便于双端对拍）。键序与 py `build_def_row` 一致 */
function buildDefRow(defn, opts, version) {
  const o = opts || {};
  return {
    tenant: o.tenant,
    env: o.env,
    name: defn.name,
    version,
    defn,
    status: 'active',
    createdBy: o.actor || '',
  };
}

/**
 * 定义行自然键 `_id` = `(tenant, env, name, version)`（D2；对齐 py `def_id`）。
 *
 * 作为存储层主键，同 `(tenant,env,name,version)` 二次写入必触发唯一键冲突
 * （Mongo E11000 / SQLite UNIQUE），使「读最新行 +1」的并发窗口在存储层收口 ——
 * 并发写同版本时后到者显式报错（控制面映射 409 CONFLICT），不产重复 version。
 * 分隔符用 US（\u001f）：schema name 不含该控制字符，拼接无歧义。
 */
function defId(tenant, env, name, version) {
  const t = tenant == null ? '' : tenant;
  const e = env == null ? '' : env;
  return `${t}\u001f${e}\u001f${name}\u001f${version}`;
}

/** 干净 internal 上下文（{internal: true}，丢弃触发者 roles）——内建表写约束对齐 __workflowRun */
function _runInternal(fn) {
  return _als.run({ internal: true }, fn);
}

// ─── IO（经传入的 store 面，避免包内循环依赖） ─────────────────

/** 列定义行（按 version desc；name 缺省列全部） */
async function listDefs(store, opts) {
  const o = opts || {};
  const condition = { tenant: o.tenant, env: o.env };
  if (o.name !== undefined) condition.name = o.name;
  const gql = `__schemaDef($condition:@c0, $sort:@s0){${_DEF_FIELDS}}`;
  return store.query(gql, { c0: condition, s0: { version: -1 } });
}

/** 各 name 的**最新 active** 行（每 name 取 version 最大者；version desc 后首见即最新） */
async function loadDefs(store, opts) {
  const o = opts || {};
  const gql = `__schemaDef($condition:@c0, $sort:@s0){${_DEF_FIELDS}}`;
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
  const rows = await listDefs(store, { tenant: o.tenant, env: o.env, name: defn.name });
  const latest = rows.length ? rows[0] : null;
  const coreDefn = _toCoreDefn(defn); // 函数值剔除（纯 JSON 入库，A3 前提）
  if (latest && sameDefn(latest.defn, coreDefn)) return latest;
  const version = nextVersion(rows);
  const row = buildDefRow(coreDefn, o, version);
  // 自然键 `_id`（D2）：同版本并发写必冲突 → 存储层保证 version 唯一
  row._id = defId(o.tenant, o.env, coreDefn.name, version);
  return _runInternal(() => store.insert(_SCHEMA_DEF, row));
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
  const rows = await loadDefs(store, o);
  let applied = 0;
  for (const r of rows) {
    const key = defId(o.tenant, o.env, r.name, r.version);
    if (_applied.has(key)) continue;
    _registerSchema(r.defn, { internal: true });
    _applied.add(key);
    applied += 1;
  }
  return { total: rows.length, applied };
}

/** 回滚到历史版本：取历史行 → 重新 register(row.defn) → 返回该行 */
async function rollbackTo(store, opts) {
  const o = opts || {};
  const rows = await listDefs(store, { tenant: o.tenant, env: o.env, name: o.name });
  const row = rows.find((r) => r.version === o.version) || null;
  if (!row) throw new MetaDefError(`metadef: 版本不存在 ${o.name}@${o.version}`);
  _registerSchema(row.defn);
  return row;
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
  _runInternal,
  _SCHEMA_DEF_MODEL,
  _WORKFLOW_DEF_MODEL,
  _FEEDBACK_MODEL,
};
