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
 *
 * D4-4 零语义拆分：core 门面视图（base / 作用域视图）下沉 ./schema/core-view，
 * Host 元数据镜像与跨 FFI 定义整形下沉 ./schema/mirror，策略开关委托下沉
 * ./schema/policy，本文件保留注册/注销/查询编排；导出面（键名 / 键序 / 语义）
 * 与拆分前逐字一致。
 */

const { emit: _emitFeedback } = require('./feedback-core');
const { core, getCore, getBase } = require('./schema/core-view');
const {
  _schemas,
  _asyncFns,
  _fnImpls,
  _normKey,
  _logicalFnRef,
  _coreFnKey,
  _locOf,
  _toCoreDefn,
  _mirror,
} = require('./schema/mirror');
const {
  setRequireContext,
  requireContext,
  setExemptRoles,
  setDenyWriteRoles,
  setUnconfiguredPolicy,
  setMetaPolicy,
  setProfile,
  getProfile,
} = require('./schema/policy');

// 重复名去重签名（同一重复形态只告警一次，避免 list() 高频调用刷屏）
const _dupSignatures = new Set();

/**
 * 注册一个 schema（自动派生 `<Name>Deleted` 归档表镜像），返回 Host 侧元数据。
 *
 * `ctx`：可选定义层门禁上下文（`{userId, roles, ...}` 或 `{internal: true}`）。
 * 门禁策略由 `setMetaPolicy` 配置，默认 Open（全放行，保既有兼容）。
 * 判决唯一在 core（拒绝抛 `ERR_PERMISSION:` 前缀错误，定义不变）。
 */
function register(defn, ctx) {
  getCore().registerBatch([{ defn: _toCoreDefn(defn), location: _locOf(defn) }], ctx ?? null);
  return _mirror(defn);
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
  return getCore().has(name);
}

/**
 * 所有已注册 schema 名称（core 侧，含归档表，按注册顺序；同名只保留首次出现）
 *
 * 去重是纵深防御的第二层（对齐 py `schema.list`）：同名覆盖重注册（如 metadef
 * `restoreDefs` 应用新版本）会让 core.order 出现重复项——不去重则协议皮按名重复
 * 装配路由（fastify 报错）。一旦检出重复即 emit 告警（同签名只告警一次），禁静默。
 */
function list() {
  const names = getCore().list();
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
    getCore().setFn(coreKey, (item, ctx) => {
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
    /** @type {Error & { code?: string }} */
    const err = new Error(`ERR_FN_MISSING:未注入回调实现 ${missing.join(', ')}`);
    err.code = 'ERR_FN_MISSING';
    throw err;
  }
}

/**
 * 带定位批量注册（D13 批次唯一）：`items = [{ defn, location }]`。
 *
 * 判决唯一在 core（`core.registerBatch`：分组 / 主唯一 / 链路 / 版本）；本层只转发 +
 * 对**主定义**做 Host 元数据镜像（从定义 `replica:true` 是链路声明，非独立结构，不入镜像）。
 * 落点**不进 defn**（定义文件零落点）。
 */
function registerBatch(items, ctx) {
  const list = items || [];
  const coreItems = list.map(({ defn, location }) => ({
    defn: _toCoreDefn(defn),
    location: location || _locOf(defn),
  }));
  getCore().registerBatch(coreItems, ctx ?? null);
  for (const { defn } of list) {
    if (defn && !defn.replica) _mirror(defn);
  }
}

/**
 * 注销一个 schema（core 幂等：未知 schema 成功，回滚清单可整份重放）。
 *
 * 判决唯一在 core（`Registry::unregister`）：主项与归档派生物 `<Name>Deleted`
 * 一并清理；Host 侧元数据镜像同步移除，使 `has`/`list` 与 core 一致。
 */
function unregister(name) {
  const fn = getCore().unregister;
  if (typeof fn !== 'function') {
    throw new Error(
      '当前 rust-store-node 绑定未导出 Registry.unregister（core 源码已实现，'
      + '需重建绑定后生效）；无法执行注销，未做任何 Host 镜像改动',
    );
  }
  fn.call(getCore(), name);
  delete _schemas[name];
  delete _schemas[`${name}Deleted`];
}

module.exports = {
  core,
  getCore,
  getBase,
  register,
  registerBatch,
  unregister,
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
