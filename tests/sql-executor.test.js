'use strict';

/**
 * Phase 4 端到端：SQLite 执行器 + introspection + sync（A4 的最小回路）
 *
 * 全程只走「store 统一入口」：GQL/命令规划在 Rust core，本文件验证 JS Host 侧
 *   store.init(SQL 连接) → crud.* → datasource 路由 → core.dialectTranslate
 *     → executors（绑定参数 + 执行 + restoreRows）→ 结果塑形
 * 的完整闭环，以及 `syncSchema`（introspect → schemaFromRows → register）。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, permission, schema: _sc } = require('../src');

const SRC = 'sqlite_e2e';

/** 测试用物理表（标量范式，与 core 关系模型一致） */
function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE posts (
      _id TEXT PRIMARY KEY, title TEXT, status TEXT, views INTEGER, __present TEXT
    );
    CREATE TABLE posts_deleted (
      _id TEXT PRIMARY KEY, title TEXT, status TEXT, views INTEGER, deletedAt INTEGER, __present TEXT
    );
  `);
  return db;
}

/** 每次都换一个内存库并重新绑定数据源（schema 注册为全局，模块级注册一次） */
async function freshStore() {
  const db = createDb();
  await init({ [SRC]: executors.createConnection('sqlite', db) });
  return db;
}

_sc.register({
  name: 'Post',
  collection: 'posts',
  idPrefix: 'p_',
  timestamps: false,
  fields: {
    title: { type: 'string' },
    status: { type: 'string' },
    views: { type: 'number' },
  },
  relations: {},
  datasource: SRC,
});

before(() => {
  permission.setContext(undefined);
});

// ─── A4：insert / query / update / updateMany / remove / count / mutation / upsert ───

test('sqlite e2e: insert + query（含 _id 还原）', async () => {
  await freshStore();
  const doc = await store.insert('Post', { title: '你好', status: 'draft', views: 3 });
  assert.ok(doc && typeof doc._id === 'string' && doc._id.startsWith('p_'), '应生成 idPrefix 前缀 _id');

  const items = await store.query('Post{_id, title, status, views}');
  assert.equal(items.length, 1);
  assert.equal(items[0]._id, doc._id);
  assert.equal(items[0].title, '你好');
  assert.equal(items[0].views, 3);
});

test('sqlite e2e: count / exists', async () => {
  await freshStore();
  await store.insertMany('Post', [
    { title: 'A', status: 'draft', views: 1 },
    { title: 'B', status: 'draft', views: 2 },
  ]);
  assert.equal(await store.count('Post', {}), 2);
  assert.equal(await store.count('Post', { status: 'draft' }), 2);
  assert.equal(await store.count('Post', { views: { $gte: 2 } }), 1);
  assert.equal(await store.exists('Post', { title: 'A' }), true);
  assert.equal(await store.exists('Post', { title: 'nope' }), false);
});

test('sqlite e2e: update（findOneAndUpdate → RETURNING 回读）', async () => {
  await freshStore();
  const doc = await store.insert('Post', { title: 'x', status: 'draft', views: 1 });
  const out = await store.update('Post', { _id: doc._id }, { views: 42 });
  assert.ok(out && out._id === doc._id, '应回读到被更新文档');
  assert.equal(out.views, 42);

  const items = await store.query('Post{_id, views}');
  assert.equal(items[0].views, 42);
});

test('sqlite e2e: updateMany（$inc）', async () => {
  await freshStore();
  await store.insertMany('Post', [
    { title: 'A', status: 'draft', views: 1 },
    { title: 'B', status: 'draft', views: 2 },
  ]);
  const r = await store.updateMany('Post', { status: 'draft' }, { $inc: { views: 10 } });
  assert.equal(r.modifiedCount, 2);
  const items = await store.query('Post{_id, views}');
  assert.deepEqual(items.map((d) => d.views).sort((a, b) => a - b), [11, 12]);
});

test('sqlite e2e: remove（归档 + 物理删除）', async () => {
  await freshStore();
  const doc = await store.insert('Post', { title: 'gone', status: 'done', views: 7 });
  const r = await store.remove('Post', { _id: doc._id });
  assert.equal(r.deletedCount, 1);
  assert.equal(r.archivedCount, 1);

  assert.equal(await store.count('Post', {}), 0);
  const archived = await store.query('PostDeleted{_id, title, deletedAt}');
  assert.equal(archived.length, 1);
  assert.equal(archived[0]._id, doc._id);
  assert.ok(archived[0].deletedAt > 0, '归档应写 deletedAt');
});

test('sqlite e2e: mutation（upsert 语义）', async () => {
  await freshStore();
  const created = await store.mutation('Post', { title: 'm1', status: 'new', views: 5 });
  assert.ok(created && typeof created._id === 'string', 'mutation 应写入并回读 _id');
  assert.equal(await store.count('Post', {}), 1);
});

test('sqlite e2e: upsert（_id 冲突目标：未命中新建 / 命中更新）', async () => {
  await freshStore();
  // 冲突目标必须是唯一约束列（此处 _id 为主键），条件等值随之写入 INSERT
  const created = await store.upsert('Post', { _id: 'p_u1' }, { status: 'on', views: 1 });
  assert.ok(created && created._id === 'p_u1', 'upsert 未命中应新建并回读');
  assert.equal(created.status, 'on');

  const hit = await store.upsert('Post', { _id: 'p_u1' }, { views: 9 });
  assert.equal(hit._id, 'p_u1');
  assert.equal(hit.views, 9);
  assert.equal(await store.count('Post', {}), 1, '命中时不应产生新行');
});

// ─── introspection → syncSchema ─────────────────────────────

test('sqlite sync: introspect → schemaFromRows → register', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE widgets (_id TEXT PRIMARY KEY, sku TEXT NOT NULL, price REAL, __present TEXT);
    CREATE TABLE gadgets (
      _id TEXT PRIMARY KEY, widget_id TEXT, label TEXT, __present TEXT,
      FOREIGN KEY (widget_id) REFERENCES widgets(_id)
    );
  `);

  const defs = await store.syncSchema({ backend: 'sqlite', driver: db, datasource: SRC });

  const widgets = defs.find((d) => d.name === 'widgets');
  assert.ok(widgets, '应产出 widgets 定义');
  assert.equal(widgets.collection, 'widgets');
  assert.equal(widgets.datasource, SRC);
  assert.ok(widgets.fields._id, '主键应映射为 _id');
  assert.equal(widgets.fields.sku.required, true, 'NOT NULL 应映射 required');
  assert.equal(widgets.fields.price.type, 'number');
  // 反向关系：widgets 侧应有 gadgets 的 many
  assert.ok(widgets.relations.gadgets, '外键应生成反向 many 关系');
  assert.equal(widgets.relations.gadgets.type, 'many');

  const gadgets = defs.find((d) => d.name === 'gadgets');
  assert.ok(gadgets.relations.widgets, '外键侧应有 many-to-one 关系');
  assert.equal(gadgets.relations.widgets.type, 'one');
  assert.equal(gadgets.relations.widgets.localField, 'widget_id');

  assert.ok(store.has('widgets'), 'syncSchema 应完成注册');
});

// ─── 标识符安全（Phase 4 动作 7） ─────────────────────────────

test('identifier safety: 恶意 field 名加引号后安全，且连接可复用', async () => {
  const WEIRD = 'x"; DROP TABLE users; --';
  const db = new Database(':memory:');
  // posts 真的有一列名就是注入串（证明 core 只把它当标识符、按后端规则转义）
  db.exec('CREATE TABLE users (_id TEXT PRIMARY KEY, name TEXT)');
  db.exec('INSERT INTO users VALUES (\'u1\', \'alice\')');
  db.exec(`CREATE TABLE evil (_id TEXT PRIMARY KEY, title TEXT, "${WEIRD.replace(/"/g, '""')}" TEXT, __present TEXT)`);
  db.exec('INSERT INTO evil VALUES (\'e1\', \'t\', \'v\', NULL)');

  _sc.register({
    name: 'Evil',
    collection: 'evil',
    timestamps: false,
    fields: { title: { type: 'string' }, [WEIRD]: { type: 'string' } },
    relations: {},
    datasource: SRC,
  });
  await init({ [SRC]: executors.createConnection('sqlite', db) });

  const cmd = {
    kind: 'find',
    source: SRC,
    namespace: null,
    collection: 'evil',
    filter: { [WEIRD]: 'v' },
    projection: { _id: 1, title: 1, [WEIRD]: 1 },
  };
  const plan = _sc.core.dialectTranslate('sqlite', cmd);
  const sqlText = plan.stmts.map((s) => s.text).join('\n');
  assert.ok(sqlText.includes('"";'), '标识符内的双引号应被转义为 ""');

  const out = await db.prepare(plan.stmts[0].text).all(...plan.stmts[0].params);
  assert.equal(out.length, 1, '转义后应能正常命中该列');

  // 注入未生效 + 连接可复用
  const stillThere = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
  assert.equal(stillThere.length, 1, 'users 表不应被删除');
  const again = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  assert.equal(again.n, 1, '连接应仍可复用');
});

test('identifier safety: 未注册的 collection 直接报错（不拼接用户输入）', async () => {
  assert.throws(
    () => _sc.core.dialectTranslate('sqlite', { kind: 'find', collection: 'users; DROP TABLE users; --', filter: {} }),
    /未注册|not found|未知|不支持|Schema/i,
  );
});
