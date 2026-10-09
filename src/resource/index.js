'use strict';

/**
 * 资源能力（宿主旁路，B 档）—— provider 注册表 + put/open/remove/url。
 *
 * 铁律：
 *   1. 元数据走普通 CRUD（Resource/ResourceLocation/ResourceBinding 三个 schema）；
 *   2. 字节 IO 只经 provider（唯一 IO 边界）；
 *   3. URL 纯拼接下沉 core（`native.resourceComposeUrl`），签名由宿主 `sign` 注入（时钟+密钥）；
 *   4. 不参与 datasource 命令路由（不碰 SQL_KINDS / mongoDb / _execOn）。
 *   5. 表名（schema）与字段名（fields）均可由业务自定义：表名经 `configure({schema})`，
 *      字段名经 `configure({fields})` 的「逻辑角色 → 物理字段」映射。缺省 = canonical。
 */

const crypto = require('node:crypto');

const native = require('../core');
const { emit: _emitFeedback } = require('../feedback');
const providers = require('./providers');

const DEFAULT_SCHEMA = {
  resource: 'Resource',
  location: 'ResourceLocation',
  binding: 'ResourceBinding',
};

// 逻辑角色 → 物理字段名（canonical 缺省）。业务可经 configureResource({ fields }) 覆盖，
// 使资源三表的字段结构由业务 schema 自定义；缺省 = canonical（向后逐字节兼容）。
const DEFAULT_FIELDS = {
  resource: { sha1: 'sha1', fileName: 'fileName', mime: 'mime', size: 'size', kind: 'kind' },
  location: { resourceId: 'resourceId', backend: 'backend', key: 'key', status: 'status', priority: 'priority' },
  binding: { resourceId: 'resourceId', businessTable: 'businessTable', businessId: 'businessId', userId: 'userId' },
};

// 必填角色：值为 null / 非空字符串之外的任何值 → configure 抛错（该列缺失则引擎无法定位）
const REQUIRED_ROLES = {
  resource: ['sha1'],
  location: ['resourceId', 'backend', 'key'],
  binding: ['resourceId', 'businessTable', 'businessId'],
};

/**
 * 解析并校验 `cfg.fields`：未知表 / 未知角色 → 抛错；
 * 必填角色须为非空字符串；可选角色为「非空字符串」或 `null`（`null` = 跳过该列）。
 */
function _parseFields(raw = {}) {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('configureResource: fields 须为对象');
  }
  for (const table of Object.keys(raw)) {
    if (!(table in DEFAULT_FIELDS)) throw new Error(`configureResource: fields 未知表: ${table}`);
  }
  const out = {};
  for (const table of Object.keys(DEFAULT_FIELDS)) {
    const given = raw[table] === undefined ? {} : raw[table];
    if (given === null || typeof given !== 'object') {
      throw new Error(`configureResource: fields.${table} 须为对象`);
    }
    for (const role of Object.keys(given)) {
      if (!(role in DEFAULT_FIELDS[table])) {
        throw new Error(`configureResource: fields.${table} 未知角色: ${role}`);
      }
    }
    const mapped = { ...DEFAULT_FIELDS[table], ...given };
    for (const role of Object.keys(mapped)) {
      const v = mapped[role];
      const isStr = typeof v === 'string' && v !== '';
      if (REQUIRED_ROLES[table].includes(role)) {
        if (!isStr) throw new Error(`configureResource: fields.${table}.${role} 为必填角色，须为非空字符串`);
      } else if (v !== null && !isStr) {
        throw new Error(`configureResource: fields.${table}.${role} 须为非空字符串或 null`);
      }
    }
    out[table] = mapped;
  }
  return out;
}

// core 稳定前缀（与 ERR_PERM_PREFIX / ERR_GQL_PARSE 同构）：适配层按前缀判定 → 404，
// 禁按中文文案匹配。仅「按 resourceId 查到零 ResourceLocation 行」时抛出；
// provider get 失败走 lastErr 原样重抛（属 IO/降级故障，仍 500）。
const ERR_RESOURCE_NOT_FOUND = 'ERR_RESOURCE_NOT_FOUND:';

let _cfg = {
  schema: { ...DEFAULT_SCHEMA },
  fields: _parseFields({}),
  store: null,
  providers: [],
  url: {},
  sign: null,
};
let _pool = new Map();

/** 配置资源能力；providers 为规格数组 `[{kind, options, priority?}]`；fields 为字段映射 */
function configure(cfg = {}) {
  _cfg = {
    schema: { ...DEFAULT_SCHEMA, ...(cfg.schema || {}) },
    fields: _parseFields(cfg.fields || {}),
    store: cfg.store || null,
    providers: Array.isArray(cfg.providers) ? cfg.providers.slice() : [],
    url: cfg.url || {},
    sign: typeof cfg.sign === 'function' ? cfg.sign : null,
  };
  _pool = new Map();
  _cfg.providers.forEach((spec, i) => {
    const p = providers.createProvider(spec.kind, spec.options || {});
    p.priority = Number.isInteger(spec.priority) ? spec.priority : i;
    _pool.set(spec.kind, p);
  });
  return _pool;
}

/** 当前生效字段映射（深拷贝；只读快照） */
function fields() {
  return JSON.parse(JSON.stringify(_cfg.fields));
}

/** 注册 provider 类型（`mod` 须含 `create(options)`） */
function registerProvider(kind, mod) {
  providers.registerProvider(kind, mod);
}

/** 当前已实例化 provider（kind → provider） */
function providers_() {
  return _pool;
}

/** CRUD 句柄：显式注入优先（单测），否则本仓 crud（同 Store 面签名） */
function _crud() {
  return _cfg.store || require('../crud');
}

function _sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

/** location 落库行：仅写映射到的列（`null` 角色跳过），`_id` 由 store 生成 */
function _locRow(resourceId, backend, key, status, priority) {
  const F = _cfg.fields.location;
  const row = {};
  if (F.resourceId) row[F.resourceId] = resourceId;
  if (F.backend) row[F.backend] = backend;
  if (F.key) row[F.key] = key;
  if (F.status) row[F.status] = status;
  if (F.priority) row[F.priority] = priority;
  return row;
}

/** location 读投影 + 条件键：按映射生成（`_id` 恒含） */
const _LOC_GQL = (schema) => {
  const F = _cfg.fields.location;
  const cols = ['_id', ...Object.values(F).filter((v) => typeof v === 'string' && v !== '')];
  return `${schema}($condition: @c0) { ${[...new Set(cols)].join(', ')} }`;
};

/** Resource 元数据读投影：`_id` + 映射到的 fileName/mime */
const _META_GQL = (schema) => {
  const F = _cfg.fields.resource;
  const cols = ['_id'];
  if (F.fileName) cols.push(F.fileName);
  if (F.mime) cols.push(F.mime);
  return `${schema}($condition: @c0) { ${[...new Set(cols)].join(', ')} }`;
};

/** 上传：内容寻址去重 + fan-out 全部 provider + 落元数据 */
async function put({ bytes, fileName, mime, kind, bind } = {}) {
  if (bytes == null) throw new Error('resource.put 需要 bytes');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const crud = _crud();
  const F = _cfg.fields;
  const sha1 = _sha1(buf);
  const resourceId = sha1;
  const key = native.resourceContentPath(sha1);

  const locations = [];     // 返回用（canonical 键，API 契约不变）
  const locationRows = [];  // 落库用（按映射列名）
  for (const [backend, p] of _pool) {
    try {
      await p.put(key, buf, { mime });
      locations.push({ resourceId, backend, key, status: 'ok', priority: p.priority });
      locationRows.push(_locRow(resourceId, backend, key, 'ok', p.priority));
    } catch (e) {
      locations.push({ resourceId, backend, key, status: 'failed', priority: p.priority });
      locationRows.push(_locRow(resourceId, backend, key, 'failed', p.priority));
      // 允许部分失败，但必须显式反馈（禁静默）
      _emitFeedback({
        type: 'resource_location_write_failed',
        code: 'resourceLocationWriteFailed',
        layer: 'resource',
        backend,
        resourceId,
        message: `资源副本写入失败（backend=${backend}, id=${resourceId}）：${(e && e.message) || e}`,
        hint: '检查该 provider 配置与连通性；其余副本不受影响',
      });
    }
  }

  if (!(await crud.exists(_cfg.schema.resource, { _id: resourceId }))) {
    const row = { _id: resourceId };
    if (F.resource.sha1) row[F.resource.sha1] = sha1;
    if (F.resource.fileName) row[F.resource.fileName] = fileName || 'unnamed';
    if (F.resource.mime) row[F.resource.mime] = mime || 'application/octet-stream';
    if (F.resource.size) row[F.resource.size] = buf.length;
    if (F.resource.kind) row[F.resource.kind] = kind || 'file';
    await crud.insert(_cfg.schema.resource, row);
  }
  if (locationRows.length) {
    const existing = await crud.query(_LOC_GQL(_cfg.schema.location), { c0: { [F.location.resourceId]: resourceId } });
    const have = new Set(existing.map((r) => r[F.location.backend]));
    const fresh = locationRows.filter((l) => !have.has(l[F.location.backend]));
    if (fresh.length) await crud.insertMany(_cfg.schema.location, fresh);
  }
  if (bind) {
    const b = {};
    if (F.binding.resourceId) b[F.binding.resourceId] = resourceId;
    if (F.binding.businessTable) b[F.binding.businessTable] = bind.businessTable;
    if (F.binding.businessId) b[F.binding.businessId] = String(bind.businessId);
    if (F.binding.userId) b[F.binding.userId] = bind.userId != null ? String(bind.userId) : null;
    await crud.insert(_cfg.schema.binding, b);
  }
  return { resourceId, sha1, locations };
}

/** 读：按 provider 配置序（同级按 priority）选路，失败降级到下一副本；成功后附元数据 */
async function open(resourceId, opts = {}) {
  const crud = _crud();
  const F = _cfg.fields;
  const rows = await crud.query(_LOC_GQL(_cfg.schema.location), { c0: { [F.location.resourceId]: resourceId } });
  const order = Array.isArray(opts.order) && opts.order.length ? opts.order : Array.from(_pool.keys());
  const rank = (b) => { const i = order.indexOf(b); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const backendOf = (r) => r[F.location.backend];
  const prioOf = (r) => (F.location.priority ? (r[F.location.priority] ?? 0) : 0);
  const sorted = rows.slice().sort((a, b) => (rank(backendOf(a)) - rank(backendOf(b))) || (prioOf(a) - prioOf(b)));

  let lastErr = null;
  for (const loc of sorted) {
    const backend = backendOf(loc);
    if (F.location.status && loc[F.location.status] === 'failed') continue;
    const p = _pool.get(backend);
    if (!p) {
      _emitFeedback({
        type: 'resource_location_provider_missing', code: 'resourceLocationProviderMissing',
        layer: 'resource', backend, resourceId,
        message: `副本 backend "${backend}" 未配置 provider，跳过（id=${resourceId}）`,
        hint: '补齐 configure({providers:[...]}) 或清理该副本',
      });
      continue;
    }
    const key = loc[F.location.key];
    let bytes;
    try {
      bytes = await p.get(key, opts);
    } catch (e) {
      lastErr = e;
      _emitFeedback({
        type: 'resource_location_degraded', code: 'resourceLocationDegraded',
        layer: 'resource', backend, resourceId,
        message: `资源副本读取失败，降级到下一副本（backend=${backend}, id=${resourceId}）：${(e && e.message) || e}`,
        hint: '检查该 provider 可用性；该副本可能需要重建',
      });
      continue;
    }
    // 字节成功 → 读元数据（读失败不降级：Resource 未注册/无权限时响亮抛出，语义清晰）
    const meta = await crud.queryOne(_META_GQL(_cfg.schema.resource), { c0: { _id: resourceId } });
    let fileName = null;
    let mime = null;
    if (meta) {
      if (F.resource.fileName) fileName = meta[F.resource.fileName] ?? null;
      if (F.resource.mime) mime = meta[F.resource.mime] ?? null;
    } else {
      _emitFeedback({
        type: 'resource_meta_missing', code: 'resourceMetaMissing',
        layer: 'resource', resourceId,
        message: `资源元数据缺失（${_cfg.schema.resource} 无 _id=${resourceId} 行）：open 仍返回字节`,
        hint: '检查资源表是否被外部清理；fileName/mime 将回落调用方兜底值',
      });
    }
    return { bytes, resourceId, backend, key, fileName, mime };
  }
  if (lastErr) throw lastErr; // 有副本行但读取失败：原样重抛（500 透传），禁改语义
  const err = new Error(`${ERR_RESOURCE_NOT_FOUND}资源不存在或无可读副本: ${resourceId}`);
  err.resourceId = resourceId;
  throw err;
}

/** 删：逐副本清字节 + 删 location 行 + 删 Resource 行 */
async function remove(resourceId) {
  const crud = _crud();
  const F = _cfg.fields;
  const rows = await crud.query(_LOC_GQL(_cfg.schema.location), { c0: { [F.location.resourceId]: resourceId } });
  const removed = [];
  for (const loc of rows) {
    const backend = loc[F.location.backend];
    const p = _pool.get(backend);
    if (!p) continue;
    try {
      await p.remove(loc[F.location.key]);
      removed.push(backend);
    } catch (e) {
      _emitFeedback({
        type: 'resource_location_remove_failed', code: 'resourceLocationRemoveFailed',
        layer: 'resource', backend, resourceId,
        message: `资源副本删除失败（backend=${backend}, id=${resourceId}）：${(e && e.message) || e}`,
        hint: '检查该 provider 可用性；可能需要手工清理孤儿文件',
      });
    }
  }
  await crud.remove(_cfg.schema.location, { [F.location.resourceId]: resourceId });
  await crud.remove(_cfg.schema.resource, { _id: resourceId });
  return { removed };
}

/** URL：核心纯拼接 + 可选签名（宿主注入时钟/密钥） */
async function url(reference, opts = {}) {
  const cfg = { ..._cfg.url };
  if (opts.vars) cfg.vars = { ...(cfg.vars || {}), ...opts.vars };
  if (_cfg.sign) {
    const signed = await _cfg.sign(reference, opts);
    if (signed && typeof signed === 'object') cfg.query = { ...(cfg.query || {}), ...signed };
  }
  return native.resourceComposeUrl(reference, cfg);
}

module.exports = {
  configure, registerProvider, providers: providers_, put, open, remove, url,
  DEFAULT_SCHEMA, DEFAULT_FIELDS, fields,
};