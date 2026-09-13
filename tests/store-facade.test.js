'use strict';

/**
 * Store 门面与权限薄包装覆盖测试
 *
 * 覆盖此前只被「绕过」调用、因而从未真正执行的两类公开面：
 *   1. `store` 门面（README 推荐入口 `const { init, store } = require('nodejs-store')`）：
 *      schema 管理 / 写读 / 上下文与角色作用域 / buildPipeline / 连接与反馈注入；
 *   2. `permission` 的 core 薄包装（canReadSchema … filterWritableData）、
 *      `datasource` 的 Host 直连辅助（connectionOfSchema / route）与 `crud.setDb`。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  init, store, executors, permission, crud, datasource, feedback, schema: _sc,
} = require('../src');

const SRC = 'facade_src';

function createDb() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE facade_items (_id TEXT PRIMARY KEY, title TEXT, secret TEXT, '
    + 'createdBy TEXT, locked TEXT, __present TEXT);',
  );
  return db;
}

// 普通 RBAC 表：schema 级 read/write 白名单 + 字段级读写白名单
_sc.register({
  name: 'FacadeItem',
  collection: 'facade_items',
  idPrefix: 'fi_',
  timestamps: false,
  datasource: SRC,
  read: ['reader'],
  write: ['editor'],
  fields: {
    title: { type: 'string' },
    secret: { type: 'string', read: ['admin'] },
    createdBy: { type: 'string' },
    locked: { type: 'string', write: ['admin'] },
  },
  relations: {},
});

// creator 专属读：用于所有者条件注入判定
_sc.register({
  name: 'FacadeOwned',
  collection: 'facade_owned',
  idPrefix: 'fo_',
  timestamps: false,
  datasource: SRC,
  read: ['creator'],
  write: ['editor'],
  fields: { title: { type: 'string' }, createdBy: { type: 'string' } },
  relations: {},
});

before(async () => {
  await init({ [SRC]: executors.createConnection('sqlite', createDb()) });
  permission.setContext(undefined);
});

// ─── 1. 门面：schema 管理 ──────────────────────────────────────

test('store 门面: register/get/has/list', () => {
  const meta = store.register({
    name: 'FacadeAux', collection: 'facade_aux', idPrefix: 'fx_', timestamps: false,
    fields: { note: 'string' }, relations: {}, datasource: SRC,
  });
  assert.equal(meta.collection, 'facade_aux');
  assert.equal(store.get('FacadeAux').idPrefix, 'fx_');
  assert.ok(store.has('FacadeAux'));
  assert.ok(store.list().includes('FacadeAux'));
  assert.throws(() => store.get('NotRegistered'), /Schema 未注册/);
});

// ─── 2. 门面：setConnections + 写入/读取 ────────────────────────

test('store 门面: setConnections + insert/queryOne/queryWithCount', async () => {
  store.setConnections({ [SRC]: executors.createConnection('sqlite', createDb()) });
  permission.setContext({ userId: 'u1', roles: ['reader', 'editor'] });

  const doc = await store.insert('FacadeItem', { title: '门面写入', secret: 's1' });
  assert.ok(doc._id.startsWith('fi_'));

  const one = await store.queryOne('FacadeItem($condition:@c0){ title }', { c0: { title: '门面写入' } });
  assert.equal(one.title, '门面写入');

  const paged = await store.queryWithCount('FacadeItem{ title }');
  assert.equal(paged.items.length, 1);
  assert.equal(Number(paged.total), 1);

  permission.setContext(undefined);
});

// ─── 3. 门面：buildPipeline / 上下文 / 角色作用域 ───────────────

test('store 门面: buildPipeline 返回解析结果', () => {
  const out = store.buildPipeline('FacadeItem{ title }');
  assert.ok(out.pipeline, '应返回 pipeline');
  assert.ok(out.projection !== undefined);
});

test('store 门面: setContext/getContext 与 scopedRoles 嵌套安全', () => {
  store.setContext({ userId: 'u2', roles: ['reader'] });
  assert.equal(store.getContext().userId, 'u2');

  const inner = store.scopedRoles(['admin'], () => store.getContext().roles);
  assert.deepEqual(inner, ['admin']);
  assert.deepEqual(store.getContext().roles, ['reader'], '退出作用域后应恢复外层上下文');

  store.setContext(undefined);
  assert.equal(store.getContext(), undefined);
});

// ─── 4. 门面：反馈出口注入 ─────────────────────────────────────

test('store 门面: setFeedbackSink 接管反馈事件', () => {
  const events = [];
  store.setFeedbackSink((e) => events.push(e));
  feedback.emit({ type: 't', code: 'facadeCode', layer: 'host', message: 'm', hint: 'h' });
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'facadeCode');
  store.setFeedbackSink(null); // 恢复默认 stderr
});

// ─── 5. permission 薄包装：schema 对象 / 名称双形态 ────────────

test('permission 包装: canReadSchema/canWriteSchema 双形态等价', () => {
  const ctx = { userId: 'u1', roles: ['reader'] };
  assert.equal(permission.canReadSchema('FacadeItem', ctx), true);
  assert.equal(permission.canReadSchema(_sc.get('FacadeItem'), ctx), true);
  assert.equal(permission.canReadSchema('FacadeItem', { roles: ['editor'] }), false);
  assert.equal(permission.canReadSchema('FacadeItem', null), true, '无 ctx = fail-open');

  assert.equal(permission.canWriteSchema('FacadeItem', { roles: ['editor'] }), true);
  assert.equal(permission.canWriteSchema('FacadeItem', { roles: ['guest'] }), false);
});

test('permission 包装: 所有者条件注入判定与合并', () => {
  assert.equal(
    permission.shouldInjectOwnerCondition('FacadeOwned', { userId: 'u1', roles: ['creator'] }),
    true,
  );
  assert.equal(
    permission.shouldInjectOwnerCondition('FacadeOwned', { userId: 'u1', roles: ['admin'] }),
    false,
    'admin 不注入',
  );
  assert.equal(permission.shouldInjectOwnerCondition('FacadeOwned', { roles: ['creator'] }), false, '缺 userId 不注入');
  assert.equal(
    permission.shouldInjectOwnerCondition('FacadeOwned', { userId: 'u1', internal: true }),
    false,
    'internal 不注入',
  );

  const ownerCtx = { userId: 'u1', roles: ['creator'] };
  assert.deepEqual(permission.mergeOwnerCondition('FacadeOwned', ownerCtx), { createdBy: 'u1' });
  assert.deepEqual(
    permission.mergeOwnerCondition('FacadeOwned', ownerCtx, { title: 'a' }),
    { $and: [{ title: 'a' }, { createdBy: 'u1' }] },
  );
  // 不注入时原样返回入参条件（core 返回 null 的分支）
  assert.equal(permission.mergeOwnerCondition('FacadeOwned', { roles: ['admin'] }), undefined);
});

test('permission 包装: 字段级读写裁剪', () => {
  const readerCtx = { userId: 'u1', roles: ['reader', 'editor'] };
  const readable = permission.getReadableFields('FacadeItem', readerCtx);
  assert.ok(readable.includes('title'));
  assert.ok(!readable.includes('secret'), 'secret 仅 admin 可读');
  assert.equal(permission.getReadableFields('FacadeItem', null), null, '无 ctx = 不裁剪');
  assert.deepEqual(permission.getReadableRelations('FacadeItem', readerCtx), []);

  const writable = permission.getWritableFields('FacadeItem', readerCtx);
  assert.ok(writable.includes('title'));
  assert.ok(!writable.includes('locked'), 'locked 仅 admin 可写');

  assert.deepEqual(
    permission.filterWritableData('FacadeItem', readerCtx, { _id: 'x', title: 'a', locked: 'b' }),
    { _id: 'x', title: 'a' },
    '_id 豁免字段写权限过滤',
  );
  const data = { title: 'a' };
  assert.deepEqual(permission.filterWritableData('FacadeItem', null, data), data, '无 ctx = 不裁剪');
});

// ─── 6. datasource 直连辅助 + crud.setDb ──────────────────────

test('datasource: connectionOfSchema / route 按 source 精确路由', () => {
  assert.equal(datasource.connectionOfSchema('FacadeItem'), datasource.getConnection(SRC));

  const { source, connection } = datasource.route({ source: SRC, collection: 'facade_items' });
  assert.equal(source, SRC);
  assert.equal(connection, datasource.getConnection(SRC));

  assert.throws(() => datasource.route({ source: 'absent' }), /数据源未配置/);
});

test('crud.setDb: 单库简写等价于 setConnections({ default: db })', () => {
  const fakeDb = { collection: () => ({}) };
  crud.setDb(fakeDb);
  assert.equal(datasource.getConnection(datasource.DEFAULT_SOURCE), fakeDb);
  // 复原：后续测试依赖 facade_src
  store.setConnections({ [SRC]: executors.createConnection('sqlite', createDb()) });
});
