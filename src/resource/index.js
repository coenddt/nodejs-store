'use strict';

/**
 * 资源能力（宿主旁路，B 档）—— provider 注册表 + put/open/remove/url。
 *
 * 铁律：
 *   1. 元数据走普通 CRUD（Resource/ResourceLocation/ResourceBinding 三个 schema）；
 *   2. 字节 IO 只经 provider（唯一 IO 边界）；
 *   3. URL 纯拼接下沉 core（`native.resourceComposeUrl`），签名由宿主 `sign` 注入（时钟+密钥）；
 *   4. 不参与 datasource 命令路由（不碰 SQL_KINDS / mongoDb / _execOn）。
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

let _cfg = { schema: { ...DEFAULT_SCHEMA }, store: null, providers: [], url: {}, sign: null };
let _pool = new Map();

/** 配置资源能力；providers 为规格数组 `[{kind, options, priority?}]` */
function configure(cfg = {}) {
  _cfg = {
    schema: { ...DEFAULT_SCHEMA, ...(cfg.schema || {}) },
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

/** 上传：内容寻址去重 + fan-out 全部 provider + 落元数据 */
async function put({ bytes, fileName, mime, kind, bind } = {}) {
  if (bytes == null) throw new Error('resource.put 需要 bytes');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const crud = _crud();
  const sha1 = _sha1(buf);
  const resourceId = sha1;
  const key = native.resourceContentPath(sha1);

  const locations = [];
  for (const [backend, p] of _pool) {
    try {
      await p.put(key, buf, { mime });
      locations.push({ resourceId, backend, key, status: 'ok', priority: p.priority });
    } catch (e) {
      locations.push({ resourceId, backend, key, status: 'failed', priority: p.priority });
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
    await crud.insert(_cfg.schema.resource, {
      _id: resourceId,
      sha1,
      fileName: fileName || 'unnamed',
      mime: mime || 'application/octet-stream',
      size: buf.length,
      kind: kind || 'file',
    });
  }
  if (locations.length) await crud.insertMany(_cfg.schema.location, locations);
  if (bind) {
    await crud.insert(_cfg.schema.binding, {
      resourceId,
      businessTable: bind.businessTable,
      businessId: String(bind.businessId),
      userId: bind.userId != null ? String(bind.userId) : null,
    });
  }
  return { resourceId, sha1, locations };
}

const _LOC_GQL = (schema) =>
  `${schema}($condition: @c0) { _id, resourceId, backend, key, status, priority }`;

/** 读：按 provider 配置序（同级按 priority）选路，失败降级到下一副本 */
async function open(resourceId, opts = {}) {
  const crud = _crud();
  const rows = await crud.query(_LOC_GQL(_cfg.schema.location), { c0: { resourceId } });
  const order = Array.isArray(opts.order) && opts.order.length ? opts.order : Array.from(_pool.keys());
  const rank = (b) => { const i = order.indexOf(b); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const sorted = rows.slice().sort((a, b) => (rank(a.backend) - rank(b.backend)) || ((a.priority ?? 0) - (b.priority ?? 0)));

  let lastErr = null;
  for (const loc of sorted) {
    const p = _pool.get(loc.backend);
    if (!p) {
      _emitFeedback({
        type: 'resource_location_provider_missing', code: 'resourceLocationProviderMissing',
        layer: 'resource', backend: loc.backend, resourceId,
        message: `副本 backend "${loc.backend}" 未配置 provider，跳过（id=${resourceId}）`,
        hint: '补齐 configure({providers:[...]}) 或清理该副本',
      });
      continue;
    }
    try {
      const bytes = await p.get(loc.key, opts);
      return { bytes, resourceId, backend: loc.backend, key: loc.key };
    } catch (e) {
      lastErr = e;
      _emitFeedback({
        type: 'resource_location_degraded', code: 'resourceLocationDegraded',
        layer: 'resource', backend: loc.backend, resourceId,
        message: `资源副本读取失败，降级到下一副本（backend=${loc.backend}, id=${resourceId}）：${(e && e.message) || e}`,
        hint: '检查该 provider 可用性；该副本可能需要重建',
      });
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`资源不存在或无可读副本: ${resourceId}`);
}

/** 删：逐副本清字节 + 删 location 行 + 删 Resource 行 */
async function remove(resourceId) {
  const crud = _crud();
  const rows = await crud.query(_LOC_GQL(_cfg.schema.location), { c0: { resourceId } });
  const removed = [];
  for (const loc of rows) {
    const p = _pool.get(loc.backend);
    if (!p) continue;
    try {
      await p.remove(loc.key);
      removed.push(loc.backend);
    } catch (e) {
      _emitFeedback({
        type: 'resource_location_remove_failed', code: 'resourceLocationRemoveFailed',
        layer: 'resource', backend: loc.backend, resourceId,
        message: `资源副本删除失败（backend=${loc.backend}, id=${resourceId}）：${(e && e.message) || e}`,
        hint: '检查该 provider 可用性；可能需要手工清理孤儿文件',
      });
    }
  }
  await crud.remove(_cfg.schema.location, { resourceId });
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
  DEFAULT_SCHEMA,
};
