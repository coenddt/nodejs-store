'use strict';

/**
 * Host 元数据镜像（D4-4 零语义拆分自 schema.js）
 *
 * 承载 Host 侧必需的所有元数据镜像与跨 FFI 定义整形：落点注入、函数值剔除、
 * 计算列回调桥绑定、主模型镜像、`<Name>Deleted` 归档镜像。共享状态
 * （`_schemas` / `_asyncFns` / `_fnImpls`）随本模块迁出，主文件与调用方
 * 取得的是**同一对象引用**，读写语义不变。
 */

const native = require('../core');
const { getCore } = require('./core-view');

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

/**
 * 落点键：由 _locOf 显式注入 Location，不进 core 定义（01 起定义零落点）
 */
const _LOCATION_KEYS = ['database', 'schema'];

/**
 * 单条 defn 的落点注入（Location）。
 *
 * 发布契约是「定义零落点」；但**既有** defn 仍可能带 `datasource`/`database`/`schema`
 * （多源路由的历史写法）。01 起 core 不再解析定义内落点字段 ⇒ 本层把它们**显式**注入
 * `Location`（与 06 装载器 / 07 federation 夹具的落点注入同构），否则 `source` 恒为
 * `default`、多源路由失效。缺省（无 `datasource`）⇒ `default`。
 */
function _locOf(defn) {
  return {
    source: (defn && defn.datasource) || null,
    database: (defn && defn.database) || null,
    schema: (defn && defn.schema) || null,
  };
}

/**
 * 生成可跨 FFI 的 schema 定义：fn/asyncFn → true 占位；函数型值剔除
 *
 * 落点键（database/schema）不属 core 白名单（01 起「定义零落点」）：
 * 由 _locOf 显式注入 Location 后从定义中剔除，否则 core 注册期会以
 * 「含未知顶层键」拒绝（既有 defn 兼容由本层承担，core 不再放行）。
 */
function _toCoreDefn(defn) {
  const out = JSON.parse(JSON.stringify(defn, (key, value) => {
    if (typeof value === 'function') {
      // fn/asyncFn 声明占位（core 按 `fn: true` 识别）；函数型 default 无法跨 FFI，剔除
      return key === 'fn' || key === 'asyncFn' ? true : undefined;
    }
    return value;
  }));
  for (const k of _LOCATION_KEYS) delete out[k];
  return out;
}

/** 单个计算列的镜像与回调绑定：fn → core 回调桥；asyncFn → Host 侧映射 */
function _mirrorCompute(defn, key, val, computes) {
  const coreKey = _coreFnKey(key, val);          // core 查找键（本步不改 core 语义）
  // 注2：仅「函数」才走内嵌绑定；纯 JSON `"fn": true`（boolean）不在此绑定，
  //      由 assertFnsCovered 从 L2 实现池解析绑定（否则会绑定出坏回调）。
  if (typeof val.fn === 'function') {
    const userFn = val.fn;
    // FFI 边界契约：JS `undefined` 无法表示为 JSON 值（core 回调桥 SyncFnBridge
    // 对 fn 返回值做 serde 序列化，undefined 即 InvalidArg）；归一为 null——
    // 与 py 侧 lambda 返回 None → null 同语义，非错误兜底
    getCore().setFn(coreKey, (item, ctx) => {
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

/** 计算列回调镜像：fn → core 回调桥；asyncFn → Host 侧映射 */
function _mirrorComputes(defn) {
  const computes = {};
  for (const [key, val] of Object.entries(defn.computes || {})) {
    _mirrorCompute(defn, key, val, computes);
  }
  return computes;
}

/** 落点定位与时间戳标志（定义文件零落点；由装载器注入 defn） */
function _hostMetaFlags(defn) {
  return {
    collection: defn.collection || defn.name,
    // database = 连接内库（Mongo/MySQL/SQLite/PG），schema = 仅 PG 的 schema 层
    database: defn.database || null,
    schema: defn.schema || null,
    idPrefix: defn.idPrefix || '',
    timestamps: defn.timestamps !== false,
    // 时间戳单位（'ms'/'s'/null=不维护）；值合法性由 core.register 校验
    timestampUnit: defn.timestamps === 's' ? 's' : (defn.timestamps === false ? null : 'ms'),
  };
}

/** 主模型 Host 镜像（含落点定位与归属键/行级权限元数据） */
function _hostMetaOf(defn, computes) {
  return {
    name: defn.name,
    ..._hostMetaFlags(defn),
    fields: defn.fields || {},
    relations: defn.relations || {},
    computes,
    indexes: defn.indexes || [],
    datasource: defn.datasource || null,
    read: defn.read,
    write: defn.write,
    // 归属键元数据镜像（漉金Core 接入扩展 01）：creator 伪角色判定/注入的键，
    // 判决唯一在 core（缺省 createdBy 由 core 兜底）；值合法性由 core.register 校验
    ownerKey: defn.ownerKey,
    // 行级权限声明镜像（accessKeys）：判决唯一在 core，Host 仅镜像元数据；
    // 归档镜像不继承（与 ownerKey 现状一致）
    accessKeys: defn.accessKeys,
  };
}

/** 归档表镜像（形状对齐 core archive_defn，供 Host 查询元数据）
 * —— 只补 Host 镜像，**不再调用 core.register**：`<Name>Deleted` 已由 core 在
 * register 内自动派生并注册（registry.rs），二次注册会让同名条目再进 core.order，
 * 使 list()/generate_ddl() 出现重复表（对齐 py `schema.register` 的既有处置）。
 * archive:false（漉金Core 接入扩展 02）→ 归档模型在 core 注册期即不派生，
 * Host 镜像同步跳过（与 core 模型表保持一致，禁出现「core 无归档模型而 Host 有镜像」的中间态） */
function _mirrorArchive(defn) {
  if (defn._isArchive || defn.name.endsWith('Deleted') || defn.archive === false) return;
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

/** Host 侧元数据镜像 + 内嵌回调绑定（`register` 与 `registerBatch` 共用） */
function _mirror(defn) {
  const computes = _mirrorComputes(defn);
  _schemas[defn.name] = _hostMetaOf(defn, computes);
  _mirrorArchive(defn);
  return _schemas[defn.name];
}

module.exports = {
  _schemas,
  _asyncFns,
  _fnImpls,
  _normKey,
  _logicalFnRef,
  _coreFnKey,
  _locOf,
  _toCoreDefn,
  _mirrorComputes,
  _mirror,
};
