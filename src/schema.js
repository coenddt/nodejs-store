'use strict';

/**
 * Schema 管理 — 薄适配层
 *
 * 职责（其余全部在 Rust core）：
 *   1. 把 JS schema 定义同步注册到 Rust core Registry（fn/asyncFn 以占位声明传递）；
 *   2. 同步 `fn` 计算列回调（core 经 FnRegistry 跨 FFI 回调）；
 *   3. 保留 asyncFn 原生函数映射（闭包无法跨 FFI，由 Host 在读路径尾处理执行）；
 *   4. 保留 Host 必需的元数据镜像（collection / idPrefix / indexes / relations），
 *      供 ID 生成与索引创建使用。
 */

const native = require('./core');
const { emit: _emitFeedback } = require('./feedback');

/** Rust core 注册表（全项目共享单例） */
const core = new native.Registry();

// 重复名去重签名（同一重复形态只告警一次，避免 list() 高频调用刷屏）
const _dupSignatures = new Set();

// Host 侧元数据镜像
const _schemas = Object.create(null);

// asyncFn 计算列回调映射（coreKey → 原生异步函数）
const _asyncFns = Object.create(null);

// L2 实现池：归一 key → { name, impl }（§8.2 匹配靠归一；禁静默覆盖）
const _fnImpls = new Map();

/** 归一 key：两侧都归一到 token 序列后 join（用 core 透出算法，禁宿主自实现） */
function _normKey(name) {
  return native.canonical(String(name)).join('');
}

/** 逻辑 fnRef（默认 `<schema.name>.<计算列key>`，§6.5） */
function _logicalFnRef(schemaName, key, comp) {
  return (comp && comp.fnRef) || `${schemaName}.${key}`;
}

/** core 侧回调查找键（保持 core 既有语义：显式 fnRef 优先，否则 key；cache.rs:47） */
function _coreFnKey(key, comp) {
  return (comp && comp.fnRef) || key;
}

/** 生成可跨 FFI 的 schema 定义：fn/asyncFn → true 占位；函数型值剔除 */
function _toCoreDefn(defn) {
  return JSON.parse(JSON.stringify(defn, (key, value) => {
    if (typeof value === 'function') {
      // fn/asyncFn 声明占位（core 按 `fn: true` 识别）；函数型 default 无法跨 FFI，剔除
      return key === 'fn' || key === 'asyncFn' ? true : undefined;
    }
    return value;
  }));
}

/**
 * 注册一个 schema（自动派生 `<Name>Deleted` 归档表镜像），返回 Host 侧元数据。
 *
 * `ctx`：可选定义层门禁上下文（`{userId, roles, ...}` 或 `{internal: true}`）。
 * 门禁策略由 `setMetaPolicy` 配置，默认 Open（全放行，保既有兼容）。
 * 判决唯一在 core（拒绝抛 `ERR_PERMISSION:` 前缀错误，定义不变）。
 */
function register(defn, ctx) {
  core.registerWithCtx(_toCoreDefn(defn), ctx ?? null);

  // 计算列回调：fn → core 回调桥；asyncFn → Host 侧映射
  const computes = {};
  for (const [key, val] of Object.entries(defn.computes || {})) {
    const coreKey = _coreFnKey(key, val);          // core 查找键（本步不改 core 语义）
    // 注2：仅「函数」才走内嵌绑定；纯 JSON `"fn": true`（boolean）不在此绑定，
    //      由 assertFnsCovered 从 L2 实现池解析绑定（否则会绑定出坏回调）。
    if (typeof val.fn === 'function') {
      const userFn = val.fn;
      // FFI 边界契约：JS `undefined` 无法表示为 JSON 值（core 回调桥 SyncFnBridge
      // 对 fn 返回值做 serde 序列化，undefined 即 InvalidArg）；归一为 null——
      // 与 py 侧 lambda 返回 None → null 同语义，非错误兜底
      core.setFn(coreKey, (item, ctx) => {
        const r = userFn(item, ctx);
        return r === undefined ? null : r;
      });
    }
    if (typeof val.asyncFn === 'function') _asyncFns[coreKey] = val.asyncFn;
    // 镜像保留声明元数据（对齐 py_store.schema.register）：agg 形态与 read 白名单
    // 供 AI 摘要（ask.describeForAi）等消费者读取；可执行物（fn/asyncFn）不入镜像
    // （执行判决唯一在 core 规划 + Host 尾处理）
    const meta = {};
    for (const k of ['type', 'depends', 'agg', 'read']) {
      if (k in val) meta[k] = val[k];
    }
    meta.fnRef = _logicalFnRef(defn.name, key, val);   // 逻辑 ref（默认 <name>.<key>）
    computes[key] = meta;
  }

  _schemas[defn.name] = {
    name: defn.name,
    collection: defn.collection || defn.name,
    // 落点定位（定义文件零落点；由装载器注入 defn）：database = 连接内库（Mongo/MySQL/SQLite/PG），
    // schema = 仅 PG 的 schema 层
    database: defn.database || null,
    schema: defn.schema || null,
    idPrefix: defn.idPrefix || '',
    timestamps: defn.timestamps !== false,
    // 时间戳单位（'ms'/'s'/null=不维护）；值合法性由 core.register 校验
    timestampUnit: defn.timestamps === 's' ? 's' : (defn.timestamps === false ? null : 'ms'),
    fields: defn.fields || {},
    relations: defn.relations || {},
    computes,
    indexes: defn.indexes || [],
    datasource: defn.datasource || null,
    read: defn.read,
    write: defn.write,
  };

  // 归档表镜像（形状对齐 core archive_defn，供 Host 查询元数据）
  // —— 只补 Host 镜像，**不再调用 core.register**：`<Name>Deleted` 已由 core 在
  // register 内自动派生并注册（registry.rs），二次注册会让同名条目再进 core.order，
  // 使 list()/generate_ddl() 出现重复表（对齐 py `schema.register` 的既有处置）。
  if (!defn._isArchive && !defn.name.endsWith('Deleted')) {
    _schemas[`${defn.name}Deleted`] = {
      name: `${defn.name}Deleted`,
      collection: `${defn.collection || defn.name}_deleted`,
      database: defn.database || null,
      schema: defn.schema || null,
      idPrefix: '',
      timestamps: true,
      timestampUnit: 'ms',
      fields: { ...(defn.fields || {}), deletedAt: { type: 'number' } },
      relations: {},
      computes: {},
      indexes: defn.indexes || [],
      // 归档表与原表同 (source, database, schema)
      datasource: defn.datasource || null,
      read: undefined,
      write: undefined,
    };
  }

  return _schemas[defn.name];
}

/** 按名称获取 Host 侧元数据 */
function get(name) {
  const s = _schemas[name];
  if (!s) {
    throw new Error(`Schema 未注册: ${name}`);
  }
  return s;
}

/** 检查 schema 是否已注册（core 侧判定，含归档表） */
function has(name) {
  return core.has(name);
}

/**
 * 所有已注册 schema 名称（core 侧，含归档表，按注册顺序；同名只保留首次出现）
 *
 * 去重是纵深防御的第二层（对齐 py `schema.list`）：同名覆盖重注册（如 metadef
 * `restoreDefs` 应用新版本）会让 core.order 出现重复项——不去重则协议皮按名重复
 * 装配路由（fastify 报错）。一旦检出重复即 emit 告警（同签名只告警一次），禁静默。
 */
function list() {
  const names = core.list();
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length !== names.length) {
    const sig = JSON.stringify(names);
    if (!_dupSignatures.has(sig)) {
      _dupSignatures.add(sig);
      _emitFeedback({
        type: 'schema_duplicate_name',
        code: 'schemaDuplicateName',
        layer: 'host',
        message: `schema 注册表存在重复名（多 ${names.length - out.length} 条），已顺序去重`,
        hint: '上游注册逻辑失守（core.order 同名两次）；核查 register 是否重复调用 core.register，或 core.register 未对同名去重',
        names,
      });
    }
  }
  return out;
}

/**
 * 开关「上下文强制」（默认关闭 = fail-open，与 JS 原版语义一致）。
 *
 * 开启后：所有 plan 入口遇 ctx 缺失抛 `ERR_NO_CONTEXT` 错误（fail-secure）；
 * 内部调用（索引创建、归档回填、后台任务等）须显式传 `{ internal: true }` 上下文。
 */
function setRequireContext(needCtx = true) {
  core.setRequireContext(Boolean(needCtx));
}

/** 豁免角色清单（命中者在一切判决环节直接放行）。默认空——无豁免（清单化语义） */
function setExemptRoles(roles) {
  core.setExemptRoles(roles);
}

/** 拒写角色清单（命中者一切写路径拒绝，读不受影响）。默认空——无拒写 */
function setDenyWriteRoles(roles) {
  core.setDenyWriteRoles(roles);
}

/** schema 白名单缺失/为空时的默认姿态：'open'（默认，放行）| 'closed'（全拒） */
function setUnconfiguredPolicy(policy) {
  core.setUnconfiguredPolicy(policy);
}

/**
 * 定义层门禁策略：`closed=true` 时仅 internal 或 `roles` 白名单可注册/覆盖。
 * 判决唯一在 core；默认 Open（`register` 无 ctx 亦放行，保既有兼容）。
 */
function setMetaPolicy(closed, roles) {
  core.setMetaPolicy(Boolean(closed), roles);
}

/** 「上下文强制」开关当前值（对齐 py_store.schema.require_context） */
function requireContext() {
  return core.requireContext();
}

/**
 * 设置查询档位：`'standard'`（默认，功能最大化 + 跨 DB 对齐）/
 * `'text2query'`（功能收缩 + 硬限制）
 *
 * 判决唯一在 core；未知档位由 core 抛错（禁静默回落到默认档）。
 */
function setProfile(profile) {
  core.setProfile(profile);
}

/** 当前档位字符串（`'standard'` / `'text2query'`；对齐 py_store.schema.get_profile） */
function getProfile() {
  return core.profile();
}

/** 取 asyncFn 计算列实现（入参为 core 侧 fnRefs 查找键，即 coreKey） */
function getAsyncFn(fnRef) {
  return _asyncFns[fnRef];
}

/**
 * 公开回调注入：`implName → impl(item, ctx)`（来自 L2 包扁平字典）。
 * 实现名与 schema 逻辑 fnRef 由 `_normKey` 归一后匹配（§6.5）；
 * 归一后重复 ⇒ 显式报错（禁静默覆盖）。绑定 core 由 `assertFnsCovered` 统一完成。
 */
function setFn(implName, impl) {
  if (typeof implName !== 'string' || !implName) throw new Error('ERR_FN_REF:implName 须为非空字符串');
  if (typeof impl !== 'function') throw new Error('ERR_FN_IMPL:impl 须为函数');
  const k = _normKey(implName);
  const prev = _fnImpls.get(k);
  if (prev && prev.name !== implName) {
    throw new Error(`ERR_FN_CONFLICT:实现名 "${implName}" 与 "${prev.name}" 归一后相同（${k}）`);
  }
  _fnImpls.set(k, { name: implName, impl });
}

/**
 * 启动期：解析每个回调计算列的实现并绑定 core；缺实现 ⇒ 显式抛 `ERR_FN_MISSING`（不静默）。
 * 关系聚合（`val.agg`）由框架处理，无需回调，跳过。
 */
function _bindOne(schemaName, key, comp) {
  const embedded = comp && (comp.fn || comp.asyncFn);
  const impl = (typeof embedded === 'function')
    ? embedded
    : (_fnImpls.get(_normKey(_logicalFnRef(schemaName, key, comp))) || {}).impl;
  if (typeof impl !== 'function') return false;
  const coreKey = _coreFnKey(key, comp);
  if (comp.fn) {
    core.setFn(coreKey, (item, ctx) => {
      const r = impl(item, ctx);
      return r === undefined ? null : r;
    });
  }
  if (comp.asyncFn) _asyncFns[coreKey] = impl;
  return true;
}

function assertFnsCovered(defns) {
  const missing = [];
  for (const defn of defns || []) {
    for (const [key, val] of Object.entries((defn && defn.computes) || {})) {
      if (val && val.agg) continue;                 // 关系聚合由框架处理，无需回调
      if (!_bindOne(defn.name, key, val)) missing.push(_logicalFnRef(defn.name, key, val));
    }
  }
  if (missing.length) {
    const err = new Error(`ERR_FN_MISSING:未注入回调实现 ${missing.join(', ')}`);
    err.code = 'ERR_FN_MISSING';
    throw err;
  }
}

module.exports = {
  core,
  register,
  get,
  has,
  list,
  setRequireContext,
  requireContext,
  setExemptRoles,
  setDenyWriteRoles,
  setUnconfiguredPolicy,
  setMetaPolicy,
  setProfile,
  getProfile,
  getAsyncFn,
  setFn,
  assertFnsCovered,
  // 内建定义持久化（metadef.js）复用：与 py_store.schema._to_core_defn 同构（函数值剔除）
  _toCoreDefn,
};
