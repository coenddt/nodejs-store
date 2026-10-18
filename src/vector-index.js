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

/** 按 schema 中声明 options.indexName 的向量索引，幂等创建 Atlas Search Index */
async function ensureVectorIndexes(store, _opts = {}) {
  const created = [];
  const skipped = [];
  for (const name of store.list()) {
    const defn = store.get(name);
    if (!defn) continue;
    for (const ix of defn.indexes || []) {
      const keys = ix && ix.keys;
      if (!keys) continue;
      const field = Object.keys(keys).find((k) => keys[k] === 'vector');
      if (!field || !ix.options || !ix.options.indexName) continue;
      const fdef = (defn.fields || {})[field] || {};
      const dim = fdef.dim;
      const similarity = similarityOf(ix.options.metric || fdef.metric);
      if (!Number.isInteger(dim) || !similarity) {
        throw new Error(`向量索引 ${defn.name}.${field} 的 dim/metric 非法`);
      }
      const db = datasource.dbOfSchema(name);
      if (!db) {
        throw new Error(
          `向量索引 ${defn.name}.${field} 声明了 options.indexName，但 schema 不是 Mongo 源，无法创建 Atlas 索引`,
        );
      }
      const coll = db.collection(defn.collection || defn.name);
      const existing = await coll.listSearchIndexes().toArray();
      if (existing.some((x) => x.name === ix.options.indexName)) {
        skipped.push(ix.options.indexName);
        continue;
      }
      await coll.createSearchIndex({
        name: ix.options.indexName,
        definition: {
          fields: [{ type: 'vector', path: field, numDimensions: dim, similarity }],
        },
      });
      created.push(ix.options.indexName);
    }
  }
  return { created, skipped };
}

module.exports = { ensureVectorIndexes };
