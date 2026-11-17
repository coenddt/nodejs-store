'use strict';

/**
 * Atlas Search Index（向量索引）幂等创建通道。
 *
 * 只有 schema 索引项显式声明 `options.indexName` 才创建，避免对自建 mongod 盲调
 * `createSearchIndex` / `$vectorSearch`。连接解析复用 datasource 现有缓存
 * （`dbOfSchema`），禁止在此新建 client。
 */

const datasource = require('./datasource');

const SIMILARITY = { cosine: 'cosine', l2: 'euclidean', ip: 'dotProduct' };

/** 内部 metric → Atlas similarity（唯一映射点） */
function similarityOf(metric) {
  return SIMILARITY[metric || 'cosine'];
}

/** vector 字段定位：keys 里找 `vector` 类型字段；形状不全 → null */
function _vectorFieldOf(ix) {
  const keys = ix && ix.keys;
  if (!keys) return null;
  const field = Object.keys(keys).find((k) => keys[k] === 'vector');
  if (!field || !ix.options || !ix.options.indexName) return null;
  return field;
}

/** 单索引项解析：非 vector 声明 / 形状不全 → null；dim/metric 非法显式抛错 */
function _vectorIndexDef(defn, ix) {
  const field = _vectorFieldOf(ix);
  if (field === null) return null;
  const fdef = (defn.fields || {})[field] || {};
  const similarity = similarityOf(ix.options.metric || fdef.metric);
  if (!Number.isInteger(fdef.dim) || !similarity) {
    throw new Error(`向量索引 ${defn.name}.${field} 的 dim/metric 非法`);
  }
  return { field, dim: fdef.dim, indexName: ix.options.indexName, similarity };
}

/** 单索引项的 Atlas 通道：已存在 → 记 skipped；否则创建 → 记 created */
async function _ensureOneIndex(defn, name, vix, created, skipped) {
  const db = datasource.dbOfSchema(name);
  if (!db) {
    throw new Error(
      `向量索引 ${defn.name}.${vix.field} 声明了 options.indexName，但 schema 不是 Mongo 源，无法创建 Atlas 索引`,
    );
  }
  const coll = db.collection(defn.collection || defn.name);
  const existing = await coll.listSearchIndexes().toArray();
  if (existing.some((x) => x.name === vix.indexName)) {
    skipped.push(vix.indexName);
    return;
  }
  await coll.createSearchIndex({
    name: vix.indexName,
    definition: {
      fields: [{ type: 'vector', path: vix.field, numDimensions: vix.dim, similarity: vix.similarity }],
    },
  });
  created.push(vix.indexName);
}

/** 按 schema 中声明 options.indexName 的向量索引，幂等创建 Atlas Search Index */
async function ensureVectorIndexes(store) {
  const created = [];
  const skipped = [];
  for (const name of store.list()) {
    const defn = store.get(name);
    if (!defn) continue;
    for (const ix of defn.indexes || []) {
      const vix = _vectorIndexDef(defn, ix);
      if (!vix) continue;
      await _ensureOneIndex(defn, name, vix, created, skipped);
    }
  }
  return { created, skipped };
}

module.exports = { ensureVectorIndexes };
