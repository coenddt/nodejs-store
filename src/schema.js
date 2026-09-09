'use strict';

/**
 * Schema 管理 — 注册、解析、查询
 *
 * 示例:
 *   register({
 *     name: 'AuctionItem',
 *     collection: 'auctionItems',
 *     idPrefix: 'AUCT',
 *     timestamps: true,
 *     fields: {
 *       _id: 'string',
 *       title: { type: 'string', required: true },
 *       auctionType: { type: 'string', default: 'normal' },
 *     },
 *     relations: {
 *       bidders: { model: 'BidRecord', type: 'many', localField: '_id', foreignField: 'itemId' },
 *     },
 *     computes: {
 *       statusLabel: { type: 'string', depends: ['status'], fn: (item) => LABELS[item.status] || '' },
 *       bidCount: { type: 'int', lookup: { $size: { $ifNull: ['$bidders', []] } } },
 *     },
 *     indexes: [{ keys: { status: 1, startTime: -1 } }],
 *   });
 */

// 已注册的 schema 映射
const _schemas = Object.create(null);

/** 规范化 fields 定义 */
function _normalizeFields(fieldsDef) {
  const fields = {};
  for (const [key, val] of Object.entries(fieldsDef || {})) {
    if (typeof val === 'string') {
      // 简写: 'string' → { type: 'string' }
      fields[key] = { type: val, required: false };
    } else {
      fields[key] = {
        type: val.type,
        required: val.required === undefined ? false : val.required,
        default: val.default,
        read: val.read,
        write: val.write,
        fields: val.fields,
      };
    }
  }
  return fields;
}

/** 注册一个 schema，返回规范化后的 schema 对象 */
function register(defn) {
  const fields = _normalizeFields(defn.fields);

  // 自动注册时间戳字段（timestamps !== false 时，createdAt/updatedAt 由框架自动管理）
  const timestampsEnabled = defn.timestamps !== false;
  if (timestampsEnabled) {
    if (!('createdAt' in fields)) fields.createdAt = { type: 'number' };
    if (!('updatedAt' in fields)) fields.updatedAt = { type: 'number' };
  }

  // 规范化 relations
  const relations = {};
  for (const [key, val] of Object.entries(defn.relations || {})) {
    relations[key] = {
      model: val.model,
      type: val.type || 'many',
      localField: val.localField || '_id',
      foreignField: val.foreignField || key,
      read: val.read,
    };
  }

  // 规范化 computes
  const computes = {};
  for (const [key, val] of Object.entries(defn.computes || {})) {
    computes[key] = {
      type: val.type || 'any',
      fn: val.fn,
      lookup: val.lookup,
      asyncFn: val.asyncFn,
      depends: val.depends || [],
      read: val.read,
    };
  }

  const schema = {
    name: defn.name,
    collection: defn.collection || defn.name,
    idPrefix: defn.idPrefix || '',
    timestamps: defn.timestamps !== false,
    fields,
    relations,
    computes,
    indexes: defn.indexes || [],
    read: defn.read,
    write: defn.write,
  };

  _schemas[schema.name] = schema;

  // 自动注册删除附表 schema —— 每个业务表对应一个 `<collection>_deleted` 归档表
  // 删除时原表数据先完整写入附表（附 deletedAt），再物理删除原表数据
  if (!defn._isArchive && !schema.name.endsWith('Deleted')) {
    register({
      name: `${schema.name}Deleted`,
      collection: `${schema.collection}_deleted`,
      idPrefix: '',
      _isArchive: true,
      // 归档表保留原表全部字段 + deletedAt（删除时间，毫秒），不做关联/计算列
      fields: { ...(defn.fields || {}), deletedAt: { type: 'number' } },
      indexes: defn.indexes || [],
    });
  }

  return schema;
}

/** 按名称获取 schema */
function get(name) {
  const s = _schemas[name];
  if (!s) {
    throw new Error(`Schema 未注册: ${name}`);
  }
  return s;
}

/** 检查 schema 是否已注册 */
function has(name) {
  return name in _schemas;
}

/** 获取所有已注册 schema 名称 */
function list() {
  return Object.keys(_schemas);
}

module.exports = { register, get, has, list, _schemas };
