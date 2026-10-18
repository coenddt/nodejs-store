'use strict';

/**
 * Atlas 向量索引幂等创建（mock 驱动）— 执行文档 02 §5 步骤 7。
 *
 * 用单 schema 视图驱动 `vectorIndex.ensureVectorIndexes`，避免共享 schema 注册表
 * 让其他用例的 schema 混入同一次调用。
 */

const test = require('node:test');
const assert = require('node:assert');

const { store } = require('../src');
const vectorIndex = require('../src/vector-index');
const datasource = require('../src/datasource');

function oneStore(name) {
  const defn = store.get(name);
  return { list: () => [name], get: (n) => (n === name ? defn : null) };
}

function fakeDb(existing = []) {
  const created = [];
  const calls = { collection: null };
  const db = {
    collection(name) {
      calls.collection = name;
      return {
        listSearchIndexes() {
          return { toArray: async () => existing };
        },
        async createSearchIndex(spec) {
          created.push(spec);
        },
      };
    },
  };
  return { db, created, calls };
}

test('按 indexName 创建，metric 缺省 cosine，dim 取字段声明', async () => {
  store.register({
    name: 'VecIdxOne',
    collection: 'vec_idx_one',
    fields: { _id: { type: 'string' }, embedding: { type: 'vector', dim: 8 } },
    indexes: [{ keys: { embedding: 'vector' }, options: { indexName: 'vidx_one' } }],
  });
  const { db, created, calls } = fakeDb();
  datasource.setConnections({ default: db });

  const out = await vectorIndex.ensureVectorIndexes(oneStore('VecIdxOne'));

  assert.deepStrictEqual(out, { created: ['vidx_one'], skipped: [] });
  assert.strictEqual(calls.collection, 'vec_idx_one');
  assert.deepStrictEqual(created, [{
    name: 'vidx_one',
    definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 8, similarity: 'cosine' }] },
  }]);
});

test('options.metric 优先于字段 metric，并映射为 Atlas similarity', async () => {
  store.register({
    name: 'VecIdxTwo',
    collection: 'vec_idx_two',
    fields: { _id: { type: 'string' }, embedding: { type: 'vector', dim: 4, metric: 'l2' } },
    indexes: [{ keys: { embedding: 'vector' }, options: { indexName: 'vidx_two', metric: 'ip' } }],
  });
  const { db, created } = fakeDb();
  datasource.setConnections({ default: db });

  await vectorIndex.ensureVectorIndexes(oneStore('VecIdxTwo'));

  assert.strictEqual(created[0].definition.fields[0].similarity, 'dotProduct');
});

test('索引已存在 → skipped，不重复创建', async () => {
  store.register({
    name: 'VecIdxThree',
    collection: 'vec_idx_three',
    fields: { _id: { type: 'string' }, embedding: { type: 'vector', dim: 8, metric: 'cosine' } },
    indexes: [{ keys: { embedding: 'vector' }, options: { indexName: 'vidx_three' } }],
  });
  const { db, created } = fakeDb([{ name: 'vidx_three' }]);
  datasource.setConnections({ default: db });

  const out = await vectorIndex.ensureVectorIndexes(oneStore('VecIdxThree'));

  assert.deepStrictEqual(out, { created: [], skipped: ['vidx_three'] });
  assert.strictEqual(created.length, 0);
});

test('无 indexName → 两个空数组，且不连库', async () => {
  store.register({
    name: 'VecIdxFour',
    collection: 'vec_idx_four',
    fields: { _id: { type: 'string' }, embedding: { type: 'vector', dim: 8 } },
    indexes: [{ keys: { embedding: 'vector' }, options: { method: 'hnsw' } }],
  });
  datasource.setConnections({});

  const out = await vectorIndex.ensureVectorIndexes(oneStore('VecIdxFour'));

  assert.deepStrictEqual(out, { created: [], skipped: [] });
});

test('dim 缺失 → 注册期拒绝（A1 schema 校验）', () => {
  assert.throws(
    () => store.register({
      name: 'VecIdxFive',
      collection: 'vec_idx_five',
      fields: { _id: { type: 'string' }, embedding: { type: 'vector' } },
      indexes: [{ keys: { embedding: 'vector' }, options: { indexName: 'vidx_five' } }],
    }),
    /缺少必填 dim/,
  );
});

test('绕过注册期后 dim 非法 → ensureVectorIndexes 显式抛错', async () => {
  datasource.setConnections({ default: fakeDb().db });
  const defn = {
    name: 'VecIdxFiveFake',
    collection: 'vec_idx_five_fake',
    fields: { embedding: { type: 'vector' } },
    indexes: [{ keys: { embedding: 'vector' }, options: { indexName: 'vidx_five_fake' } }],
  };
  const view = { list: () => [defn.name], get: () => defn };

  await assert.rejects(() => vectorIndex.ensureVectorIndexes(view), /dim\/metric 非法/);
});

test('非 Mongo 源声明 indexName → 显式抛错，不静默跳过', async () => {
  store.register({
    name: 'VecIdxSix',
    collection: 'vec_idx_six',
    fields: { _id: { type: 'string' }, embedding: { type: 'vector', dim: 8 } },
    indexes: [{ keys: { embedding: 'vector' }, options: { indexName: 'vidx_six' } }],
  });
  datasource.setConnections({ default: { kind: 'sqlite' } });

  await assert.rejects(
    () => vectorIndex.ensureVectorIndexes(oneStore('VecIdxSix')),
    /不是 Mongo 源/,
  );
});
