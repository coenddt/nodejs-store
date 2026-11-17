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
 *
 * D4-4 零语义拆分：表名/字段映射常量与校验、provider 池构建与选取、configure
 * 整体重赋值下沉 ./config（配置状态经 getCfg/getPool 现场取值），本文件保留
 * 资源读写编排；导出面（键名 / 键序 / 语义）与拆分前逐字一致。
 */

const crypto = require('node:crypto');

const native = require('../core');
const { emit: _emitFeedback } = require('../feedback-core');
const providers = require('./providers');
const {
  DEFAULT_SCHEMA,
  DEFAULT_FIELDS,
  getCfg,
  getPool,
  configure,
  poolNames,
  _requirePool,
} = require('./config');
const {
  _locRow,
  _LOC_GQL,
  _META_GQL,
  _resourceRow,
  _bindingRow,
} = require('./rows');

// core 稳定前缀（与 ERR_PERM_PREFIX / ERR_GQL_PARSE 同构）：适配层按前缀判定 → 404，
// 禁按中文文案匹配。仅「按 resourceId 查到零 ResourceLocation 行」时抛出；
// provider get 失败走 lastErr 原样重抛（属 IO/降级故障，仍 500）。
const ERR_RESOURCE_NOT_FOUND = 'ERR_RESOURCE_NOT_FOUND:';

/** 当前生效字段映射（深拷贝；只读快照） */
function fields() {
  return JSON.parse(JSON.stringify(getCfg().fields));
}

/** 注册 provider 类型（`mod` 须含 `create(options)`） */
function registerProvider(kind, mod) {
  providers.registerProvider(kind, mod);
}

/** 当前已实例化 provider（kind → provider） */
function providers_() {
  return getPool();
}

/** CRUD 句柄：显式注入优先（单测），否则本仓 crud（同 Store 面签名） */
function _crud() {
  return getCfg().store || require('../crud');
}

function _sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

/** fan-out 全部 provider 副本：允许部分失败但逐条显式反馈（禁静默）；返回 locations/locationRows */
async function _putFanout(poolSel, resourceId, key, buf, mime) {
  const locations = [];     // 返回用（canonical 键，API 契约不变）
  const locationRows = [];  // 落库用（按映射列名）
  for (const [backend, p] of poolSel) {
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
  return { locations, locationRows };
}

/** location 行去重落库：按 backend 已有集合过滤后批量插入 */
async function _putLocations(crud, F, resourceId, locationRows) {
  if (!locationRows.length) return;
  const existing = await crud.query(_LOC_GQL(getCfg().schema.location), { c0: { [F.location.resourceId]: resourceId } });
  const have = new Set(existing.map((r) => r[F.location.backend]));
  const fresh = locationRows.filter((l) => !have.has(l[F.location.backend]));
  if (fresh.length) await crud.insertMany(getCfg().schema.location, fresh);
}

/**
 * 上传：内容寻址去重 + fan-out 全部 provider + 落元数据
 *
 * @param {any} [opts] 上传入参（bytes/fileName/mime/kind/bind/pool，均为宿主透传的开放形状）
 */
async function put({ bytes, fileName, mime, kind, bind, pool } = /** @type {any} */ ({})) {
  if (bytes == null) throw new Error('resource.put 需要 bytes');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const crud = _crud();
  const F = getCfg().fields;
  const poolSel = _requirePool(pool);
  const sha1 = _sha1(buf);
  const resourceId = sha1;
  const key = native.resourceContentPath(sha1);

  const { locations, locationRows } = await _putFanout(poolSel, resourceId, key, buf, mime);
  if (!(await crud.exists(getCfg().schema.resource, { _id: resourceId }))) {
    await crud.insert(getCfg().schema.resource, _resourceRow(F, { resourceId, sha1, fileName, mime, kind }, buf));
  }
  await _putLocations(crud, F, resourceId, locationRows);
  if (bind) {
    await crud.insert(getCfg().schema.binding, _bindingRow(F, resourceId, bind));
  }
  return { resourceId, sha1, locations };
}

/** open/remove 共用前置：crud 门面、字段映射、provider 池与该资源的 location 行集 */
async function _loadLocations(resourceId, opts) {
  const crud = _crud();
  const F = getCfg().fields;
  const poolSel = _requirePool(opts.pool);
  const rows = await crud.query(_LOC_GQL(getCfg().schema.location), { c0: { [F.location.resourceId]: resourceId } });
  return { crud, F, poolSel, rows };
}

/** 副本读取序：显式 order 优先（越界排末尾），同级按 priority 升序 */
function _openOrder(opts, poolSel, F) {
  const order = Array.isArray(opts.order) && opts.order.length ? opts.order : Array.from(poolSel.keys());
  const rank = (b) => { const i = order.indexOf(b); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const prioOf = (r) => (F.location.priority ? (r[F.location.priority] ?? 0) : 0);
  const backendOf = (r) => r[F.location.backend];
  return (rows) => rows.slice().sort((a, b) => (rank(backendOf(a)) - rank(backendOf(b))) || (prioOf(a) - prioOf(b)));
}

/** 单副本尝试：成功 `{bytes,backend,key}`；跳过 `{skip:true, err?}`（provider 缺失/降级 feedback 已发） */
async function _openLoc(F, poolSel, opts, loc, resourceId) {
  const backend = loc[F.location.backend];
  if (F.location.status && loc[F.location.status] === 'failed') return { skip: true };
  const p = poolSel.get(backend);
  if (!p) {
    _emitFeedback({
      type: 'resource_location_provider_missing', code: 'resourceLocationProviderMissing',
      layer: 'resource', backend, resourceId,
      message: `副本 backend "${backend}" 未配置 provider，跳过（id=${resourceId}）`,
      hint: '补齐 configure({providers:[...]}) 或清理该副本',
    });
    return { skip: true };
  }
  const key = loc[F.location.key];
  try {
    const bytes = await p.get(key, opts);
    return { bytes, backend, key };
  } catch (e) {
    _emitFeedback({
      type: 'resource_location_degraded', code: 'resourceLocationDegraded',
      layer: 'resource', backend, resourceId,
      message: `资源副本读取失败，降级到下一副本（backend=${backend}, id=${resourceId}）：${(e && e.message) || e}`,
      hint: '检查该 provider 可用性；该副本可能需要重建',
    });
    return { skip: true, err: e };
  }
}

/** 字节成功后读元数据（读失败不降级：缺失发 feedback，fileName/mime 回落 null） */
async function _readMeta(crud, F, resourceId) {
  const meta = await crud.queryOne(_META_GQL(getCfg().schema.resource), { c0: { _id: resourceId } });
  if (!meta) {
    _emitFeedback({
      type: 'resource_meta_missing', code: 'resourceMetaMissing',
      layer: 'resource', resourceId,
      message: `资源元数据缺失（${getCfg().schema.resource} 无 _id=${resourceId} 行）：open 仍返回字节`,
      hint: '检查资源表是否被外部清理；fileName/mime 将回落调用方兜底值',
    });
    return { fileName: null, mime: null };
  }
  let fileName = null;
  let mime = null;
  if (F.resource.fileName) fileName = meta[F.resource.fileName] ?? null;
  if (F.resource.mime) mime = meta[F.resource.mime] ?? null;
  return { fileName, mime };
}

/** 读：按 provider 配置序（同级按 priority）选路，失败降级到下一副本；成功后附元数据 */
async function open(resourceId, opts = {}) {
  const { crud, F, poolSel, rows } = await _loadLocations(resourceId, opts);
  const sortLocs = _openOrder(opts, poolSel, F);

  let lastErr = null;
  for (const loc of sortLocs(rows)) {
    const got = await _openLoc(F, poolSel, opts, loc, resourceId);
    if (got.err) lastErr = got.err;
    if (got.skip) continue;
    // 字节成功 → 读元数据（读失败不降级：Resource 未注册/无权限时响亮抛出，语义清晰）
    const { fileName, mime } = await _readMeta(crud, F, resourceId);
    return { bytes: got.bytes, resourceId, backend: got.backend, key: got.key, fileName, mime };
  }
  if (lastErr) throw lastErr; // 有副本行但读取失败：原样重抛（500 透传），禁改语义
  /** @type {Error & { resourceId?: string }} */
  const err = new Error(`${ERR_RESOURCE_NOT_FOUND}资源不存在或无可读副本: ${resourceId}`);
  err.resourceId = resourceId;
  throw err;
}

/** 删：逐副本清字节 + 删 location 行 + 删 Resource 行 */
async function remove(resourceId, opts = {}) {
  const { crud, F, poolSel, rows } = await _loadLocations(resourceId, opts);
  const removed = [];
  for (const loc of rows) {
    const backend = loc[F.location.backend];
    const p = poolSel.get(backend);
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
  await crud.remove(getCfg().schema.location, { [F.location.resourceId]: resourceId });
  await crud.remove(getCfg().schema.resource, { _id: resourceId });
  return { removed };
}

/** URL：核心纯拼接 + 可选签名（宿主注入时钟/密钥） */
async function url(reference, opts = {}) {
  _requirePool(opts.pool); // 池存在性 fail-fast；URL 模板/签名为全局配置（跨池共享），行为不变
  const cfg = { ...getCfg().url };
  if (opts.vars) cfg.vars = { ...(cfg.vars || {}), ...opts.vars };
  if (getCfg().sign) {
    const signed = await getCfg().sign(reference, opts);
    if (signed && typeof signed === 'object') cfg.query = { ...(cfg.query || {}), ...signed };
  }
  return native.resourceComposeUrl(reference, cfg);
}

module.exports = {
  configure, registerProvider, providers: providers_, put, open, remove, url,
  DEFAULT_SCHEMA, DEFAULT_FIELDS, fields, poolNames,
  // 公开工厂（providers/index.js 纯工厂的转发导出，签名与返回形状为稳定公开 API，README 承诺）
  createProvider: providers.createProvider,
};
