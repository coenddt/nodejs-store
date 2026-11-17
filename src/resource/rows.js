'use strict';

/**
 * 资源三表的行构造与读投影生成（D4-4 零语义拆分自 resource/index.js）
 *
 * 全部为纯函数：只按当前字段映射（`getCfg().fields`）拼行/拼 GQL 投影，
 * 不做 IO、不发反馈。映射取自 ./config 的当前配置，与拆分前
 * 「模块级 `_cfg.fields` 现场读」同语义。
 */

const { getCfg } = require('./config');

/** location 落库行：仅写映射到的列（`null` 角色跳过），`_id` 由 store 生成 */
function _locRow(resourceId, backend, key, status, priority) {
  const F = getCfg().fields.location;
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
  const F = getCfg().fields.location;
  const cols = ['_id', ...Object.values(F).filter((v) => typeof v === 'string' && v !== '')];
  return `${schema}($condition: @c0) { ${[...new Set(cols)].join(', ')} }`;
};

/** Resource 元数据读投影：`_id` + 映射到的 fileName/mime */
const _META_GQL = (schema) => {
  const F = getCfg().fields.resource;
  const cols = ['_id'];
  if (F.fileName) cols.push(F.fileName);
  if (F.mime) cols.push(F.mime);
  return `${schema}($condition: @c0) { ${[...new Set(cols)].join(', ')} }`;
};

/** Resource 元数据行构造（列按映射；缺列跳过；缺省值文案不变） */
function _resourceRow(F, spec, buf) {
  const row = { _id: spec.resourceId };
  if (F.resource.sha1) row[F.resource.sha1] = spec.sha1;
  if (F.resource.fileName) row[F.resource.fileName] = spec.fileName || 'unnamed';
  if (F.resource.mime) row[F.resource.mime] = spec.mime || 'application/octet-stream';
  if (F.resource.size) row[F.resource.size] = buf.length;
  if (F.resource.kind) row[F.resource.kind] = spec.kind || 'file';
  return row;
}

/** 绑定行构造（列按映射；userId null 保留） */
function _bindingRow(F, resourceId, bind) {
  const b = {};
  if (F.binding.resourceId) b[F.binding.resourceId] = resourceId;
  if (F.binding.businessTable) b[F.binding.businessTable] = bind.businessTable;
  if (F.binding.businessId) b[F.binding.businessId] = String(bind.businessId);
  if (F.binding.userId) b[F.binding.userId] = bind.userId != null ? String(bind.userId) : null;
  return b;
}

module.exports = {
  _locRow,
  _LOC_GQL,
  _META_GQL,
  _resourceRow,
  _bindingRow,
};
