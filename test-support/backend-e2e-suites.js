'use strict';

/**
 * 真实三库 e2e 用例定义器（D4-4 零语义拆分）。
 *
 * 自 tests/real-backends-e2e.test.js 原样下沉：A/B 双行种子、CRUD 闭环六例
 * （insert+query / count / update / updateMany / remove / mutation / upsert）与
 * introspect → schemaFromRows → register 一例；用例名、断言与注释逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { it } = require('node:test');
const assert = require('node:assert/strict');

const { store, schema: _sc } = require('../src');
// 后端 e2e 共享断言与 sql-executor 对齐（insert 读回 / introspect 产物）
const { insertAndReadBackPost, assertWidgetsGadgetsDefs } = require('../tests/helpers/backend-e2e');

// ─── A4：CRUD 闭环（同一套断言跑三个后端） ────────────────────

/** A/B 双行 Post 种子：reset + insertMany（crudSuite 内 count / updateMany 用例共用） */
async function seedTwoDrafts(ctx, S) {
  await ctx.reset();
  await store.insertMany(S, [
    { title: 'A', status: 'draft', views: 1 },
    { title: 'B', status: 'draft', views: 2 },
  ]);
}

function crudSuite(ctx) {
  const S = ctx.schemaName;
  const SD = ctx.archiveSchema;

  it('insert + query（含 _id 还原）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    await insertAndReadBackPost(S);
    // helper 已断言 _id 前缀 / 条数 / title / views；此处补 status 字段读回原样
    const rows = await store.query(`${S}{_id, status}`);
    assert.deepEqual(rows.map((x) => x.status), ['draft'], '写入态 status 应读回原样');
  });

  it('count / exists', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await seedTwoDrafts(ctx, S);
    assert.equal(await store.count(S, {}), 2);
    assert.equal(await store.count(S, { status: 'draft' }), 2);
    assert.equal(await store.count(S, { views: { $gte: 2 } }), 1);
    assert.equal(await store.exists(S, { title: 'A' }), true);
    assert.equal(await store.exists(S, { title: 'nope' }), false);
  });

  it('update（写后回读：PG/SQLite RETURNING，MySQL 两段编排）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const doc = await store.insert(S, { title: 'x', status: 'draft', views: 1 });
    const out = await store.update(S, { _id: doc._id }, { views: 42 });
    assert.ok(out && out._id === doc._id, '应回读到被更新文档');
    assert.equal(out.views, 42);

    const items = await store.query(`${S}{_id, views}`);
    assert.equal(items[0].views, 42);
  });

  it('updateMany（$inc）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await seedTwoDrafts(ctx, S);
    const r = await store.updateMany(S, { status: 'draft' }, { $inc: { views: 10 } });
    assert.equal(r.modifiedCount, 2);
    const items = await store.query(`${S}{_id, views}`);
    assert.deepEqual(items.map((d) => d.views).sort((a, b) => a - b), [11, 12]);
  });

  it('remove（归档 + 物理删除）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const doc = await store.insert(S, { title: 'gone', status: 'done', views: 7 });
    const r = await store.remove(S, { _id: doc._id });
    assert.equal(r.deletedCount, 1);
    assert.equal(r.archivedCount, 1);

    assert.equal(await store.count(S, {}), 0);
    const archived = await store.query(`${SD}{_id, title, deletedAt}`);
    assert.equal(archived.length, 1);
    assert.equal(archived[0]._id, doc._id);
    assert.ok(Number(archived[0].deletedAt) > 0, '归档应写 deletedAt');
  });

  it('mutation（upsert 语义）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const created = await store.mutation(S, { title: 'm1', status: 'new', views: 5 });
    assert.ok(created && typeof created._id === 'string', 'mutation 应写入并回读 _id');
    assert.equal(await store.count(S, {}), 1);
  });

  it('upsert（_id 冲突目标：未命中新建 / 命中更新）', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    await ctx.reset();
    const created = await store.upsert(S, { _id: 'p_u1' }, { status: 'on', views: 1 });
    assert.ok(created && created._id === 'p_u1', 'upsert 未命中应新建并回读');
    assert.equal(created.status, 'on');

    const hit = await store.upsert(S, { _id: 'p_u1' }, { views: 9 });
    assert.equal(hit._id, 'p_u1');
    assert.equal(hit.views, 9);
    assert.equal(await store.count(S, {}), 1, '命中时不应产生新行');
  });
}

// ─── introspection → syncSchema（仅 SQL 后端） ────────────────

function syncSuite(ctx) {
  it('introspect → schemaFromRows → register', async (t) => {
    if (!ctx.ready) return t.skip(ctx.reason);
    // 库里含已注册逻辑模型（my_posts 等），三元组唯一性下直接注册必冲突 ——
    // 故先 registerDefs: false 拿 defs 验证映射，再显式断言冲突 fail fast，
    // 最后单独注册非冲突表验证注册链路。
    const defs = await store.syncSchema({
      backend: ctx.kind,
      driver: ctx.driver,
      datasource: ctx.ds,
      introspectOptions: ctx.introspectOptions,
      registerDefs: false,
    });

    assertWidgetsGadgetsDefs(defs, ctx.ds);

    // 三元组冲突 fail fast：已注册 <ctx.schemaName>（同 source、同 collection）再注册即抛错
    const dupe = defs.find((d) => d.collection === ctx.collection);
    assert.ok(dupe, 'introspect 应产出已注册表的 def');
    assert.throws(
      () => _sc.register({ ...dupe, name: `${dupe.name}_dupe` }),
      /冲突|占用/,
      '同 (source, namespace, collection) 重复注册应抛错而非静默串源'
    );

    const taken = new Set(_sc.list().map((n) => _sc.get(n).collection));
    for (const d of defs) {
      if (taken.has(d.collection)) continue;
      _sc.register(d);
    }
    assert.ok(store.has('widgets'), 'syncSchema 应完成非冲突表注册');
  });
}

module.exports = { crudSuite, syncSuite };
