'use strict';

/**
 * 索引键点号路径物理化回归（嵌套数组字段索引被整串拼接）
 *
 * schema 声明索引 `signers.userId`（嵌套数组元素内字段）时，原实现对整串做
 * `naming.physical` → `signersUserId`；索引虽能建成，但物理键与文档真实嵌套路径
 * 不符，按该字段查询永远走不到索引。
 *
 * 修复后索引键按段翻译并保留点号结构（`signers.userId`）。本文件用真实 MongoDB
 * 断言：① 索引键与文档嵌套路径一致；② 按该字段查询的执行计划命中该索引（IXSCAN）。
 *
 * 需本机 127.0.0.1:27017 MongoDB（库 mongo_store_e2e_idx，可用 MONGO_URI 覆盖）；
 * 不可达时自动 skip。库名与其它 e2e 文件隔离，互不清空。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');

const { init, store, permission, schema: _sc } = require('../src');
const naming = require('../src/naming');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mongo_store_e2e_idx';

const SCHEMA = 'IdxSigner';
const COLLECTION = 'idx_signers_nested';
const NESTED_PATH = 'signers.userId';

let client = null;
let db = null;
let reason = 'MongoDB 不可达';

before(async () => {
  permission.setContext(undefined);
  client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (e) {
    reason = `MongoDB 不可达（${MONGO_URI}）: ${e.message}`;
    await client.close().catch(() => {});
    client = null;
    return;
  }
  db = client.db();
  _sc.register({
    name: SCHEMA,
    collection: COLLECTION,
    idPrefix: 'is_',
    timestamps: false,
    fields: { signers: { type: 'array' } },
    relations: {},
    datasource: 'mongo_idx',
    indexes: [{ keys: { [NESTED_PATH]: 1 } }],
  });
  // 物理集合名与生产同源（core::naming）；先清掉上次运行残留，保证索引断言干净
  await db.collection(naming.physical(COLLECTION)).drop().catch(() => {});
  await init({ mongo_idx: db });
});

after(async () => {
  if (db) await db.collection(naming.physical(COLLECTION)).drop().catch(() => {});
  if (client) await client.close().catch(() => {});
});

async function seed() {
  const coll = db.collection(naming.physical(COLLECTION));
  await coll.deleteMany({});
  await store.insert(SCHEMA, { signers: [{ userId: 'u1' }, { userId: 'u2' }] });
  return coll;
}

/** 递归收集执行计划各阶段（Mongo 用 inputStage / inputStages 串联） */
function stages(plan) {
  const out = [];
  if (!plan || typeof plan !== 'object') return out;
  if (plan.stage) out.push(plan);
  if (plan.inputStage) out.push(...stages(plan.inputStage));
  for (const s of plan.inputStages || []) out.push(...stages(s));
  return out;
}

test('嵌套数组字段索引键等于文档真实嵌套路径', async (t) => {
  if (!db) return t.skip(reason);
  const coll = await seed();

  const indexes = await coll.listIndexes().toArray();
  const keyPairs = indexes.flatMap((ix) => Object.entries(ix.key || {}));
  const rendered = keyPairs.map(([k, v]) => `${k}:${v}`);

  assert.ok(rendered.includes(`${NESTED_PATH}:1`),
    `索引键应为嵌套路径 ${NESTED_PATH}，实际索引：${rendered.join(', ')}`);
  // 整串 physical 会产出 signersUserId；该键不存在才是真修复
  assert.ok(!rendered.includes('signersUserId:1'),
    `不应出现整串拼接的索引键 signersUserId，实际索引：${rendered.join(', ')}`);
});

test('按嵌套字段查询命中该索引（explain IXSCAN）', async (t) => {
  if (!db) return t.skip(reason);
  await seed();
  const physColl = naming.physical(COLLECTION);

  // 取数走原生逃生口（executeNative）：GQL $condition 对「数组根字段的点号路径」
  // 有 core 侧形态守卫（跨后端数组语义不一致，两档一律 Err），该守卫与本缺陷无关，
  // 故此处用原生 $match 验证索引本身的可用性。
  const got = await store.executeNative(
    'mongo_idx', physColl, [{ $match: { [NESTED_PATH]: 'u2' } }],
  );
  assert.equal(got.rows.length, 1, `按嵌套字段应查到 1 条，实际：${JSON.stringify(got.rows)}`);

  const plan = await db.command({
    explain: { find: physColl, filter: { [NESTED_PATH]: 'u2' } },
    verbosity: 'queryPlanner',
  });
  const winning = (plan.queryPlanner && plan.queryPlanner.winningPlan) || {};
  const ixscans = stages(winning).filter((s) => s.stage === 'IXSCAN');
  assert.ok(ixscans.length,
    `按 ${NESTED_PATH} 查询应走索引，实际执行计划：${JSON.stringify(winning)}`);
  assert.ok(String(ixscans[0].indexName || '').startsWith(NESTED_PATH),
    `应命中 ${NESTED_PATH} 索引，实际：${ixscans[0].indexName}`);
});
