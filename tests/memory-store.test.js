'use strict';

/**
 * 进程内内存数据源（memory）Host 单测 —— A1 / A3
 *
 * 约定（对齐执行文档 §5 步骤 6）：
 *   - A1：`connect(...).kind === 'memory'` 且 `handleFor` 为函数，并经**真实 CRUD**
 *     （`init` + `store.insert` / `store.query`）证明该 kind 端到端可用；
 *   - A3：同一载体两个不同 `database`、同名 `collection` **互不可见**（读回各为自身文档集）。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/memory-store.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { connect, MEMORY_KIND } = require('../src/memory');
const datasource = require('../src/datasource');
const { init, store, schema: _sc } = require('../src');

// ─── A1：memory kind 可用（描述符 + 真实 CRUD） ───────────────

test('memory/A1: connect 产 memory 描述符（kind + handleFor）', () => {
  const conn = connect({ database: 'sales_db' });
  assert.equal(MEMORY_KIND, 'memory');
  assert.equal(conn.kind, 'memory');
  assert.equal(conn.database, 'sales_db');
  assert.equal(typeof conn.handleFor, 'function');
  assert.equal(typeof conn.openTransaction, 'function');
  assert.equal(typeof conn.withTransaction, 'function');
});

test('memory/A1: 真实 CRUD（init + insert/query 读回）', async () => {
  _sc.register({
    name: 'MemA1User', collection: 'mem_a1_users', idPrefix: 'ma1_', timestamps: false,
    fields: { name: { type: 'string' } }, relations: {},
  });
  try {
    await init(connect({ store: new Map() }));

    const u = await store.insert('MemA1User', { name: 'Ada' });
    assert.ok(String(u._id).startsWith('ma1_'), '应生成 idPrefix 前缀 _id');

    assert.deepEqual(await store.query('MemA1User{ _id name }'), [{ _id: u._id, name: 'Ada' }]);
    assert.equal(await store.count('MemA1User', {}), 1);
  } finally {
    datasource.setConnections({});
  }
});

// ─── A3：database 维键空间隔离 ──────────────────────────────

test('memory/A3: 同载体两个 database、同名 collection 互不可见', async () => {
  // 同名 collection（mem_a3_items）、不同 database —— 四元组落点不同，core 允许共存
  _sc.register({
    name: 'MemA3A', collection: 'mem_a3_items', idPrefix: 'a3a_', timestamps: false,
    database: 'db_a', fields: { name: { type: 'string' } }, relations: {},
  });
  _sc.register({
    name: 'MemA3B', collection: 'mem_a3_items', idPrefix: 'a3b_', timestamps: false,
    database: 'db_b', fields: { name: { type: 'string' } }, relations: {},
  });
  try {
    await init(connect({ store: new Map() }));

    await store.insert('MemA3A', { name: 'fromA' });
    await store.insert('MemA3B', { name: 'fromB' });

    const a = await store.query('MemA3A{ _id name }');
    const b = await store.query('MemA3B{ _id name }');

    assert.equal(a.length, 1, 'db_a 分区只含自身文档');
    assert.equal(b.length, 1, 'db_b 分区只含自身文档');
    assert.equal(a[0].name, 'fromA');
    assert.equal(b[0].name, 'fromB');
    // 同名 collection、不同 database 互不串源
    assert.notDeepEqual(a, b);
  } finally {
    datasource.setConnections({});
  }
});
