'use strict';

/**
 * 向量检索 conformance 共用支撑（D4-4 零语义拆分）。
 *
 * 自 tests/vector-conformance.test.js 原样下沉：执行文档 06 §4.5 的用例集 JSON
 * （`VECTOR-CONFORMANCE` 标记夹取，唯一权威）、CASE 索引、共享断言助手与 defineSuite
 * 组定义器；用例名与断言逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const datasource = require('../src/datasource');
const { init, store, permission, schema } = require('../src');

/* VECTOR-CONFORMANCE-BEGIN */
const CONFORMANCE = JSON.parse(String.raw`{
  "schema": {
    "name": "VectorConformance",
    "collection": "vector_conformance",
    "fields": {
      "label": { "type": "string", "default": "" },
      "content": { "type": "string", "default": "" },
      "sourceHash": { "type": "string", "default": "" },
      "embedding": { "type": "vector", "dim": 3, "metric": "cosine" },
      "embedding_l2": { "type": "vector", "dim": 3, "metric": "l2" },
      "embedding_ip": { "type": "vector", "dim": 3, "metric": "ip" }
    },
    "indexes": [],
    "read": ["admin"],
    "write": ["admin"]
  },
  "docs": [
    { "_id": "c1", "label": "same",       "content": "a",
      "embedding": [1, 0, 0], "embedding_l2": [1, 0, 0], "embedding_ip": [1, 0, 0] },
    { "_id": "c2", "label": "orthogonal", "content": "b",
      "embedding": [0, 1, 0], "embedding_l2": [0, 1, 0], "embedding_ip": [0, 1, 0] },
    { "_id": "c3", "label": "near",       "content": "c",
      "embedding": [0.8, 0.6, 0], "embedding_l2": [0.8, 0.6, 0], "embedding_ip": [0.8, 0.6, 0] },
    { "_id": "c4", "label": "opposite",   "content": "d",
      "embedding": [-1, 0, 0], "embedding_l2": [-1, 0, 0], "embedding_ip": [-1, 0, 0] }
  ],
  "cases": [
    { "id": "C1", "kind": "near", "field": "embedding", "vector": [1, 0, 0], "limit": 3,
      "expectIds": ["c1", "c3", "c2"], "expectScores": [1.0, 0.8, 0.0], "tolerance": 1e-6 },
    { "id": "C2", "kind": "near", "field": "embedding_l2", "vector": [1, 0, 0], "limit": 3,
      "expectIds": ["c1", "c3", "c2"],
      "expectScores": [1.0, 0.612574113, 0.414213562], "tolerance": 1e-6 },
    { "id": "C3", "kind": "near", "field": "embedding_ip", "vector": [1, 0, 0], "limit": 3,
      "expectIds": ["c1", "c3", "c2"], "expectScores": [1.0, 0.8, 0.0], "tolerance": 1e-6 },
    { "id": "C4", "kind": "near", "field": "embedding", "vector": [1, 0], "limit": 1,
      "expectError": "dim" },
    { "id": "C5", "kind": "near", "field": "embedding", "vector": [0, 0, 0], "limit": 1,
      "expectError": "zero" },
    { "id": "C6", "kind": "near", "field": "embedding", "vector": [1, 0, 0],
      "expectError": "limit" },
    { "id": "C7", "kind": "near", "field": "embedding", "vector": [1, 0, 0], "limit": 10,
      "expectIds": ["c1", "c3", "c2", "c4"], "tolerance": 1e-6 },
    { "id": "C8", "kind": "near", "field": "embedding", "vector": [1, 0, 0], "limit": 3,
      "noIndex": true,
      "expectIds": ["c1", "c3", "c2"], "expectScores": [1.0, 0.8, 0.0], "tolerance": 1e-6 },
    { "id": "C9", "kind": "plain",
      "expectIds": ["c1", "c2", "c3", "c4"], "expectNoScore": true },
    { "id": "C10", "kind": "near", "field": "embedding", "vector": [1, 0, 0], "limit": 3,
      "filter": { "label": "near" },
      "expectIds": ["c3"], "expectDegraded": true },
    { "id": "C11", "kind": "reindex", "field": "embedding", "hashField": "sourceHash",
      "sourceFields": ["content"], "pre": "reindexForce",
      "mutateId": "c2", "mutateContent": "b2",
      "expectEmbedded": 1, "expectSkipped": 3 }
  ]
}`);
/* VECTOR-CONFORMANCE-END */

const CASE = Object.fromEntries(CONFORMANCE.cases.map((c) => [c.id, c]));

/** 每后端一份独立 schema 名（同一 collection / 同一批文档 / 同一用例集） */
function registerSchema(tag, source) {
  const suffix = tag === 'sqlite' ? '' : tag[0].toUpperCase() + tag.slice(1);
  const name = `VectorConformance${suffix}`;
  schema.register({
    ...CONFORMANCE.schema,
    name,
    // host 侧 _id 生成需要显式列声明（sqlite DDL 亦依赖）
    fields: { _id: { type: 'string' }, ...CONFORMANCE.schema.fields },
    datasource: source,
  });
  return name;
}

/** 与 registerSchema 同一命名口径（DDL 生成需要 schema 已注册） */
function registerSchemaName(tag) {
  const suffix = tag === 'sqlite' ? '' : tag[0].toUpperCase() + tag.slice(1);
  return `VectorConformance${suffix}`;
}

function nearGql(name) {
  return `${name}($condition:@c){_id, _score}`;
}

function nearParams(c) {
  return {
    c: {
      ...(c.filter || {}),
      [c.field]: { $near: { $vector: c.vector, ...(c.limit === undefined ? {} : { $limit: c.limit }) } },
    },
  };
}

async function queryNear(name, c) {
  return store.query(nearGql(name), nearParams(c));
}

/** C1/C2/C3/C8：结果集顺序 + `_score` 容差 */
async function assertRanked(name, c) {
  const rows = await queryNear(name, c);
  assert.deepEqual(rows.map((r) => r._id), c.expectIds, `${c.id} ids`);
  if (c.expectScores) {
    rows.forEach((r, i) => {
      assert.ok(Math.abs(r._score - c.expectScores[i]) <= c.tolerance,
        `${c.id}[${i}] _score=${r._score} 期望 ${c.expectScores[i]}`);
    });
  }
}

/** C4/C5/C6：规划期显式报错（关键词按契约语义匹配，中英文均可） */
async function assertCaseError(name, c, pattern) {
  let err = null;
  try {
    await queryNear(name, c);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${c.id} 期望抛错`);
  assert.match(String(err.message), pattern, `${c.id} 错误文案`);
}

/**
 * 定义某后端的完整用例组。
 * `setup` 返回连接映射；返回字符串 = 自报 skip 理由（携带真实错误）；
 * 返回 null = 实例不可达（整组 skip，统一文案）。
 */
function defineSuite(tag, setup, teardown) {
  describe(`vector conformance · ${tag}`, () => {
    const ctx = { skip: null };
    let name;

    before(async () => {
      permission.setContext({ userId: 'vc_admin', roles: ['admin'] });
      name = registerSchema(tag, `vc_${tag}`);
      const result = await setup();
      if (typeof result === 'string') {
        ctx.skip = result;
        return;
      }
      if (!result) {
        ctx.skip = `${tag} 实例不可达`;
        return;
      }
      await init(result);
      for (const doc of CONFORMANCE.docs) await store.insert(name, doc);
    });

    after(async () => {
      datasource.setConnections({});
      if (teardown) await teardown();
    });

    it('C1 cosine 近邻 TopK 顺序与 _score', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      await assertRanked(name, CASE.C1);
    });

    it('C2 l2 距离换算 _score = 1/(1+d)', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      await assertRanked(name, CASE.C2);
    });

    it('C3 ip 内积换算 _score = dot', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      await assertRanked(name, CASE.C3);
    });

    it('C4 $vector 维度不符即报错', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      await assertCaseError(name, CASE.C4, /dim|维度/i);
    });

    it('C5 零向量即报错（cosine 距离未定义）', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      await assertCaseError(name, CASE.C5, /zero|零向量/i);
    });

    it('C6 缺 $limit 即报错', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      await assertCaseError(name, CASE.C6, /limit/i);
    });

    it('C7 $limit 大于集合规模返回全部', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      const rows = await queryNear(name, CASE.C7);
      assert.deepEqual(rows.map((r) => r._id), CASE.C7.expectIds);
    });

    it('C8 未声明向量索引不报错（与 C1 逐值一致）', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      assert.deepEqual(CONFORMANCE.schema.indexes, [], '用例集应为无索引 schema');
      await assertRanked(name, CASE.C8);
    });

    it('C9 普通查询不产生 _score', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      const rows = await store.query(`${name}{_id, label}`, {});
      assert.deepEqual(rows.map((r) => r._id), CASE.C9.expectIds);
      for (const r of rows) assert.equal(Object.hasOwn(r, '_score'), false, '不得追加 _score');
    });

    it('C10 过滤叠加向量条件 + 降级声明', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      const { result, status } = await store.withDegradedScope(() => queryNear(name, CASE.C10));
      assert.deepEqual(result.map((r) => r._id), CASE.C10.expectIds);
      assert.equal(status.degraded, true, `${tag} 应声明降级`);
      const ev = (status.events || []).filter((e) => e.type === 'vector_degraded');
      assert.ok(ev.length > 0, '缺 vector_degraded 事件');
      const last = ev[ev.length - 1];
      assert.equal(last.backend, tag === 'mongodb' ? 'mongodb' : tag);
      assert.equal(last.field, CASE.C10.field);
      assert.equal(last.metric, 'cosine');
      if (tag === 'postgres') {
        assert.match(last.message, /后过滤/);
        assert.match(last.message, /精确检索/);
      } else {
        assert.match(last.message, /应用层精确检索/);
      }
    });

    it('C11 回填只重算变化项（force 前置）', async (t) => {
      if (ctx.skip) return t.skip(ctx.skip);
      const embed = async (texts) => texts.map(() => [1, 0, 0]);
      const base = {
        field: CASE.C11.field, hashField: CASE.C11.hashField,
        sourceFields: CASE.C11.sourceFields, embed,
      };
      const first = await store.reindexVectors(name, { ...base, force: true });
      assert.equal(first.embedded, CONFORMANCE.docs.length, 'force 全量回填');
      await store.update(name, { _id: CASE.C11.mutateId }, { content: CASE.C11.mutateContent });
      const second = await store.reindexVectors(name, base);
      assert.equal(second.embedded, CASE.C11.expectEmbedded);
      assert.equal(second.skipped, CASE.C11.expectSkipped);
    });
  });
}

module.exports = {
  CONFORMANCE,
  CASE,
  registerSchema,
  registerSchemaName,
  defineSuite,
};
