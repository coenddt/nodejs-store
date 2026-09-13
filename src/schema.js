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

/** Rust core 注册表（全项目共享单例） */
const core = new native.Registry();

// Host 侧元数据镜像
const _schemas = Object.create(null);

// asyncFn 计算列回调映射（fnRef → 原生异步函数）
const _asyncFns = Object.create(null);

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

/** 注册一个 schema（自动派生 `<Name>Deleted` 归档表镜像），返回 Host 侧元数据 */
function register(defn) {
  core.register(_toCoreDefn(defn));

  // 计算列回调：fn → core 回调桥；asyncFn → Host 侧映射
  const computes = {};
  for (const [key, val] of Object.entries(defn.computes || {})) {
    const fnRef = val.fnRef || key;
    if (val.fn) core.setFn(fnRef, val.fn);
    if (val.asyncFn) _asyncFns[fnRef] = val.asyncFn;
    computes[key] = { fnRef };
  }

  _schemas[defn.name] = {
    name: defn.name,
    collection: defn.collection || defn.name,
    namespace: defn.namespace || null,
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

  // 归档表镜像（与 core register 的自动派生保持一致，供 Host 查询元数据）
  if (!defn._isArchive && !defn.name.endsWith('Deleted')) {
    register({
      name: `${defn.name}Deleted`,
      collection: `${defn.collection || defn.name}_deleted`,
      idPrefix: '',
      _isArchive: true,
      fields: { ...(defn.fields || {}), deletedAt: { type: 'number' } },
      indexes: defn.indexes || [],
      // 归档表与原表同 (source, namespace)
      datasource: defn.datasource || null,
      namespace: defn.namespace || null,
    });
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

/** 所有已注册 schema 名称（core 侧，含归档表，按注册顺序） */
function list() {
  return core.list();
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

/** 「上下文强制」开关当前值（对齐 py_store.schema.require_context） */
function requireContext() {
  return core.requireContext();
}

/** 取 asyncFn 计算列实现（fnRef 缺省 = 计算列 key 名） */
function getAsyncFn(fnRef) {
  return _asyncFns[fnRef];
}

module.exports = { core, register, get, has, list, setRequireContext, requireContext, getAsyncFn };
