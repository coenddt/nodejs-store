'use strict';

/**
 * meta-store 定义模型与纯逻辑（D4-4 零语义拆分自 metadef.js）
 *
 * 承载：内建定义表名/模型、`MetaDefError`、稳定序列化与定义行构造等纯函数
 * （双端逐字节等价的 parity 锚）。IO 与注册编排留在 ../metadef.js。
 */

// 内建定义表名（`__` 前缀为内建保留名，对齐 workflow 的 name.startsWith('__') 校验）
const _SCHEMA_DEF = '__schemaDef';
const _WORKFLOW_DEF = '__workflowDef';
const _FEEDBACK = '__feedback';
// 迁移版本表（C3/A4，消费方 src/migrate.js）：物理迁移版本行
const _MIGRATION = '__schemaMigration';

/** metadef 契约失败（defn.name 缺失 / 版本不存在 / 唯一冲突） */
class MetaDefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MetaDefError';
  }
}

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

/**
 * 迁移版本表（C3/A4）：migrate 编排器的幂等闸与审计行。
 *
 * 行自然键 `_id` = `(tenant,env,backend,name,version)`（defId 惯例追加 backend 段，
 * 分隔符同为 \u001f）——同版本并发写必触发唯一键冲突，与 `defId` 同语义在存储层收口。
 * `hash` = 该版 defn stableStringify 的 SHA-1 hex（幂等闸判定键）。
 * 不声明 indexes（理由同 `_defModel` 注释）；`write: []` 普通角色禁写（版本审计不可篡改）。
 */
const _MIGRATION_MODEL = {
  name: _MIGRATION,
  system: true,
  collection: _MIGRATION,
  idPrefix: 'mig',
  write: [],
  fields: {
    _id: { type: 'string' },
    tenant: { type: 'string' },
    env: { type: 'string' },
    backend: { type: 'string' },
    name: { type: 'string' },
    hash: { type: 'string' },
    version: { type: 'int' },
    appliedAt: { type: 'number' },
    sqls: { type: 'array' },
  },
};

// 内建反馈事件表（05）：承载结构化降级/拦截事件（write 空名单——普通角色禁写，事件审计）
const _FEEDBACK_MODEL = {
  name: _FEEDBACK,
  system: true,
  collection: _FEEDBACK,
  idPrefix: 'fdbk',
  write: [],
  fields: {
    _id: { type: 'string' },
    // 事件类别（fields 键空间完全开放、无字段名保留字，`type` 作字段名合法）
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

// ─── 纯逻辑（双端逐字节等价；parity 锚） ───────────────────────

/**
 * 深度检查 defn 是否含函数值 —— 持久化定义 = 纯 JSON 契约（N3）。
 *
 * 必须先于 `_toCoreDefn` 调用：后者会把 `fn/asyncFn` 归一为 `true` 占位、把其余函数剔除，
 * 使「含回调定义」静默降级为「无回调纯 JSON」入库，回滚/restore 即丢失回调（缺陷台账 D17）。
 * 本函数在归一化**之前**显式拒绝（fail-fast），文案对齐 py `_assert_serializable`（逐字节一致）。
 * @param {*} v 待检值
 * @param {string} path 当前路径（空串为根；子路径以 `.` 连接）
 */
function _assertSerializable(v, path) {
  if (typeof v === 'function') {
    throw new MetaDefError(
      `metadef: 定义含函数回调（${path}），不可持久化；`
      + '回调类定义禁止经控制面发布（定义内改用 fnRef 字符串，实现由宿主 register 时注入）',
    );
  }
  if (v === null || typeof v !== 'object') return;
  const keys = Array.isArray(v) ? v.map((_, i) => String(i)) : Object.keys(v);
  for (const k of keys) {
    _assertSerializable(v[k], path ? `${path}.${k}` : k);
  }
}

/**
 * 数字 → 规范字面量（**本项目的规范格式，不是 JS 语义**）。
 *
 * 两宿主逐字节一致是硬约束（同一定义跨端必须同 hash，否则 migrate 幂等闸失效）：
 * JS `String` 已给「最短往返位 + ECMAScript 排版」，唯一需要归一的是正指数里的 `+`
 * （`1e+21` → `1e21`）。`-0` → `0`，NaN / ±Infinity → `null`（同 JSON.stringify）。
 * 完整规则与 py `_canonical_number` 一一对应，跨端语料见
 * tests/fixtures/stable-stringify-parity.json。
 */
function _canonicalNumber(v) {
  if (!Number.isFinite(v)) return 'null';
  if (v === 0) return '0';
  return String(v).replace(/e\+/g, 'e');
}

/** 稳定序列化（键序无关）：与 py `stable_stringify` 逐字节等价 */
function _stableStringify(v) {
  if (typeof v === 'number') return _canonicalNumber(v);
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

module.exports = {
  _SCHEMA_DEF,
  _WORKFLOW_DEF,
  _FEEDBACK,
  _MIGRATION,
  MetaDefError,
  _defModel,
  _SCHEMA_DEF_MODEL,
  _WORKFLOW_DEF_MODEL,
  _MIGRATION_MODEL,
  _FEEDBACK_MODEL,
  _assertSerializable,
  _canonicalNumber,
  _stableStringify,
  sameDefn,
  nextVersion,
  buildDefRow,
  defId,
};
