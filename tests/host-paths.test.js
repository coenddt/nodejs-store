'use strict';

/**
 * Host 执行路径补测（此前 c8 未触达的真实分支）
 *
 * 缺口证据（`npm run test:coverage`，2026-09-27 实跑）：
 *   - `src/crud/query.js` 40-46 / 93-99：两阶段执行（取 ID → 回表 → 还原排序）、联邦两阶段单元；
 *   - `src/crud/query.js` 117-119：联邦降级告警（禁静默失守）；
 *   - `src/crud/query.js` 56：asyncFn 计算列缺实现（禁静默丢列）；
 *   - `src/index.js` 319-320：init 入参校验。
 *
 * 对标 py-store/tests/test_host_paths.py（双端同名同义用例）。
 * 运行：node scripts/test.js（脚本会置 LOCAL_CORE=1）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  init, store, crud: _crud, schema: _sc, permission, feedback, datasource,
} = require('../src');

// ─────────────────────────────────────────────────────────────
// schema（两阶段读路径需要「根 + 关系子表」）
// ─────────────────────────────────────────────────────────────

_sc.register({
  name: 'HpPost', collection: 'hp_posts', idPrefix: 'HP', timestamps: false,
  fields: { title: { type: 'string' }, seq: { type: 'int' } },
  relations: {
    comments: {
      model: 'HpComment', type: 'many', localField: '_id', foreignField: 'postId',
    },
  },
  read: null, write: null,
});
_sc.register({
  name: 'HpComment', collection: 'hp_comments', timestamps: false,
  fields: { postId: { type: 'string' }, body: { type: 'string' } },
  relations: {}, read: null, write: null,
});
// 联邦降级：根与子表分属两个数据源（跨源子级 $limit 无法下推）
_sc.register({
  name: 'HpUser', collection: 'hp_users', datasource: 'hp_mongo_a',
  idPrefix: 'HU', timestamps: false,
  fields: { name: { type: 'string' } },
  relations: {
    orders: {
      model: 'HpOrder', type: 'many', localField: '_id', foreignField: 'userId',
    },
  },
  read: null, write: null,
});
_sc.register({
  name: 'HpOrder', collection: 'hp_orders', datasource: 'hp_mongo_b',
  timestamps: false,
  fields: { userId: { type: 'string' }, code: { type: 'string' } },
  relations: {}, read: null, write: null,
});

/** 每个用例前后的全局状态复位（档位 / 上下文 / sink / 连接） */
function resetGlobals () {
  _sc.setProfile('standard');
  permission.setContext(undefined);
  feedback.setSink(null);
  datasource.setConnections({});
}

// ─────────────────────────────────────────────────────────────
// 内存驱动 mock：phase-1 取 ID / phase-2 回表（按 pipeline 形态分派）
// ─────────────────────────────────────────────────────────────

class Cursor {
  constructor (docs) { this.docs = docs; }

  async toArray () { return [...this.docs]; }
}

/** phase-2 命令首段 `$match._id.$in` → id 数组；非两阶段返回 null */
function phase1Ids (pipeline) {
  const first = Array.isArray(pipeline) ? pipeline[0] : null;
  const match = first && typeof first === 'object' ? first.$match : null;
  const inClause = match && typeof match === 'object' ? match._id : null;
  const val = inClause && typeof inClause === 'object' ? inClause.$in : null;
  return Array.isArray(val) ? val : null;
}

/** 极简阶段模拟（仅本用例所需）：$sort / $skip / $limit / $project */
function applyPhase1 (pipeline, docs) {
  let cur = docs.map((d) => ({ ...d }));
  for (const stage of pipeline) {
    if (stage.$sort) {
      const entries = Object.entries(stage.$sort).reverse();
      for (const [key, dir] of entries) {
        cur.sort((a, b) => {
          const x = a[key]; const y = b[key];
          if (x === y) return 0;
          return (x === undefined || x === null ? 1 : y === undefined || y === null ? -1
            : (x < y ? -1 : 1)) * (dir < 0 ? -1 : 1);
        });
      }
    } else if (stage.$skip !== undefined) {
      cur = cur.slice(Number(stage.$skip));
    } else if (stage.$limit !== undefined) {
      cur = cur.slice(0, Number(stage.$limit));
    } else if (stage.$project) {
      const keys = Object.entries(stage.$project).filter(([, v]) => v).map(([k]) => k);
      cur = cur.map((d) => Object.fromEntries(keys.map((k) => [k, d[k]])));
    }
  }
  return cur;
}

/** 两阶段读路径 mock：phase-1 取 ID、phase-2 按 `$in` 回表（可强制乱序返回） */
class ScriptedColl {
  constructor (docs, { reversePhase2 = false } = {}) {
    this.docs = docs;
    this.pipelines = [];
    this.reversePhase2 = reversePhase2;
    this.phase2RawIds = null;
  }

  find () { return new Cursor(this.docs); }

  aggregate (pipeline) {
    this.pipelines.push(pipeline);
    const ids = phase1Ids(pipeline);
    if (ids === null) return new Cursor(applyPhase1(pipeline, this.docs));
    const byId = new Map(this.docs.map((d) => [d._id, { ...d }]));
    const picked = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
    if (this.reversePhase2) picked.reverse();
    this.phase2RawIds = picked.map((d) => d._id);
    return new Cursor(picked);
  }

  async countDocuments () { return this.docs.length; }
}

/** 按 collection 名分派独立 coll 的 Mongo db 桩 */
class FakeDb {
  constructor (mapping = {}) { this.colls = { ...mapping }; }

  collection (name) {
    if (!this.colls[name]) this.colls[name] = new ScriptedColl([]);
    return this.colls[name];
  }
}

const POSTS = [
  { _id: 'p1', title: 'A', seq: 1 },
  { _id: 'p2', title: 'B', seq: 2 },
  { _id: 'p3', title: 'C', seq: 3 },
];

function dbWithPosts ({ posts = POSTS, reversePhase2 = false } = {}) {
  const coll = new ScriptedColl(posts, { reversePhase2 });
  return { db: new FakeDb({ hp_posts: coll }), coll };
}

// ─────────────────────────────────────────────────────────────
// 1. 两阶段读路径（src/crud/query.js:_runQueryPlan）
// ─────────────────────────────────────────────────────────────

test('two_phase: 先取 ID 再携 phase1.ids 回表，并还原排序', async () => {
  resetGlobals();
  const { db, coll } = dbWithPosts({ reversePhase2: true });
  _crud.setDb(db);

  const items = await _crud.query(
    'HpPost($sort:@s,$limit:@l){ _id, title, comments{ _id } }',
    { s: { seq: 1 }, l: 2 },
  );

  assert.equal(coll.pipelines.length, 2, '两阶段应恰发两条命令（取 ID → 回表）');
  const [phase1, phase2] = coll.pipelines;
  assert.deepEqual(phase1[phase1.length - 1], { $project: { _id: 1 } }, 'phase-1 只取 _id');
  assert.ok(phase1.some((s) => s.$limit !== undefined), 'phase-1 应带根级 $limit');
  assert.deepEqual(phase2[0].$match._id.$in, ['p1', 'p2'], 'phase-2 须携 phase-1 的 ID 列表');
  assert.deepEqual(coll.phase2RawIds, ['p2', 'p1'], 'phase-2 原始顺序被 mock 故意颠倒');
  assert.deepEqual(items.map((d) => d._id), ['p1', 'p2'], 'core restoreSortOrder 应还原排序');
});

test('two_phase: phase-1 空结果短路（不再发第二条命令）', async () => {
  resetGlobals();
  const { db, coll } = dbWithPosts({ posts: [] });
  _crud.setDb(db);

  const items = await _crud.query(
    'HpPost($sort:@s,$limit:@l){ _id, comments{ _id } }',
    { s: { seq: 1 }, l: 2 },
  );
  assert.deepEqual(items, []);
  assert.equal(coll.pipelines.length, 1, '空结果应短路，只发 phase-1 一条命令');
});

test('two_phase: 排序引用关联字段时保持单命令聚合', async () => {
  resetGlobals();
  const { db, coll } = dbWithPosts();
  _crud.setDb(db);

  await _crud.query(
    'HpPost($sort:@s,$limit:@l){ _id, comments{ _id } }',
    { s: { 'comments.body': 1 }, l: 2 },
  );

  assert.equal(coll.pipelines.length, 1, '关联字段排序无法先取 ID，须单命令聚合');
  assert.ok(coll.pipelines[0].some((s) => s.$lookup), '单命令里应含关系 $lookup');
  assert.ok(coll.pipelines[0].some((s) => s.$sort), '排序仍在同一 pipeline 内下推');
});

// ─────────────────────────────────────────────────────────────
// 2. 联邦：两阶段取数单元 + 降级告警
// ─────────────────────────────────────────────────────────────

test('federated: 单源根单元 two_phase 同样还原排序', async () => {
  resetGlobals();
  const { db, coll } = dbWithPosts({ reversePhase2: true });
  _crud.setDb(db);

  const items = await _crud.queryFederated(
    'HpPost($sort:@s,$limit:@l){ _id, title, comments{ _id } }',
    { s: { seq: 1 }, l: 2 },
  );

  assert.equal(coll.pipelines.length, 2, '联邦取数单元同样应走两阶段（取 ID → 回表）');
  assert.deepEqual(coll.pipelines[1][0].$match._id.$in, ['p1', 'p2']);
  assert.deepEqual(items.map((d) => d._id), ['p1', 'p2']);
});

test('federated: 跨源子级 $limit 降级 → emit federation_degraded 且不阻断结果', async () => {
  resetGlobals();
  const db = new FakeDb({
    hp_users: new ScriptedColl([{ _id: 'u1', name: 'A' }]),
    hp_orders: new ScriptedColl([{ _id: 'o1', userId: 'u1', code: 'c1' }]),
  });
  _crud.setConnections({ hp_mongo_a: db, hp_mongo_b: db });
  const events = [];
  feedback.setSink((e) => events.push(e));

  const items = await _crud.queryFederated(
    'HpUser($condition:@c0){ name, orders($limit:@l0){ code } }', { c0: {}, l0: 3 },
  );

  const degraded = events.filter((e) => e.type === 'federation_degraded');
  assert.equal(degraded.length, 1, `降级须恰好产出一条反馈事件: ${JSON.stringify(events)}`);
  assert.equal(degraded[0].code, 'crossSourceChildPaging');
  assert.equal(degraded[0].layer, 'federation');
  assert.ok(degraded[0].message && degraded[0].hint);
  assert.deepEqual(items, [{ _id: 'u1', name: 'A', orders: [{ code: 'c1' }] }]);
});

// ─────────────────────────────────────────────────────────────
// 3. Store 门面 + init 入参校验 + 索引创建
// ─────────────────────────────────────────────────────────────

test('store facade: 读路径与 buildPipeline 走 store 实例', async () => {
  resetGlobals();
  const { db } = dbWithPosts();
  _crud.setDb(db);

  assert.equal((await store.query('HpPost{ _id, title }'))[0]._id, 'p1');
  assert.equal((await store.queryOne('HpPost{ _id, title }'))._id, 'p1');
  assert.equal((await store.queryWithCount('HpPost{ _id }')).total, 3);

  const built = store.buildPipeline('HpPost{ _id, title }');
  assert.equal(built.ast.model, 'HpPost');
  assert.deepEqual(built.ast.fields, ['_id', 'title']);
});

test('init: 入参校验（非映射且无 collection 的入参 → TypeError）', async () => {
  resetGlobals();
  await assert.rejects(() => init(123), /init\(connections\)/);
});

/** Mongo db 桩：listIndexes 返回既有索引；createIndex 记录/抛错 */
class IndexColl {
  constructor ({ existing = [], fail = false } = {}) {
    this.existing = existing;
    this.fail = fail;
    this.created = [];
  }

  listIndexes () { return { toArray: async () => this.existing }; }

  async createIndex (keys, options) {
    if (this.fail) throw new Error('模拟索引创建失败');
    this.created.push([keys, options]);
  }
}

class IndexDb {
  constructor (factory) { this.factory = factory; this.colls = {}; }

  collection (name) {
    if (!this.colls[name]) this.colls[name] = this.factory();
    return this.colls[name];
  }
}

_sc.register({
  name: 'HpIndexed', collection: 'hp_indexed', timestamps: false,
  fields: { title: { type: 'string' } },
  relations: {},
  indexes: [{ keys: { title: 1 }, unique: true }],
});

test('init: 幂等建索引（无同名索引则创建，已有同名则跳过）', async () => {
  resetGlobals();
  const db = new IndexDb(() => new IndexColl());
  await init({ default: db });
  assert.deepEqual(db.collection('hp_indexed').created, [[[['title', 1]], { unique: true }]],
    '应按 keys + inline 选项创建索引');

  const db2 = new IndexDb(() => new IndexColl({ existing: [{ name: 'title_1' }] }));
  await init({ default: db2 });
  assert.deepEqual(db2.collection('hp_indexed').created, [], '同名索引已存在时不得重复创建');
});

// ─────────────────────────────────────────────────────────────
// 4. asyncFn 计算列缺实现（禁静默丢列）
//
// 只能经 `schema.core.register` 直连 core 构造「core 已声明 asyncFn、Host 侧未登记实现」
// 的状态（Host `register` 必然同步写入回调表）。该 schema 无 Host 镜像，故本用例
// **必须置于文件末位**（其后不得再调用 init —— init 会遍历 core.list() 并读 Host 镜像）。
// ─────────────────────────────────────────────────────────────

test('asyncFn: core 声明但 Host 未登记实现 → 显式报错', async () => {
  resetGlobals();
  _sc.core.register({
    name: 'HpAsyncOnly', collection: 'hp_async_only', timestamps: false,
    fields: { a: { type: 'int' } },
    computes: { total: { type: 'int', asyncFn: true, fnRef: 'hp_missing_async' } },
    relations: {},
  });
  const { db } = dbWithPosts();
  db.colls.hp_async_only = new ScriptedColl([{ _id: '1', a: 1 }]);
  _crud.setDb(db);

  await assert.rejects(() => _crud.query('HpAsyncOnly{ _id, total }'), /未注册实现/);
});
