'use strict';

/**
 * 目录语义装载（共享分层与多落点择优 06）：A2 目录即落点 / A1 同名主重复 /
 * A3 主从识别 / A11 PG 落点携带 schema / 连接配置与错误上浮。
 *
 * 覆盖 core 纯规划（`planLoad`）与宿主运行期入口（`loadDefs`，含真实 IO + registerBatch）。
 * 依赖 core 透出的 `planLoad` / `registerBatch`（06 步骤 3）——须以 LOCAL_CORE=1
 * 从相邻 rust-store 调试产物加载（与其余宿主用例同口径）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const load = require('../src/load');
const schema = require('../src/schema');

const CFG = {
  sources: {
    mongoMain: { kind: 'mongodb', databases: ['sales_db'] },
    pgMain: { kind: 'pg', databases: ['analytics_db'] },
  },
  defs: ['schema'],
};

const f = (rel, defn) => ({ rel, defn });

function locOf(items, name) {
  const hit = items.find((it) => it.defn && it.defn.name === name && !it.defn.replica);
  return hit && hit.location;
}

test('A2 目录即落点：L1=database；PG L2=schema；L3+ 打平', () => {
  const files = [
    f('sales_db/Order.json', { name: 'Order', fields: { _id: { type: 'string' } } }),
    f('sales_db/inventory/Item.json', { name: 'Item', fields: { _id: { type: 'string' } } }),
    f('analytics_db/app/Customer.json', { name: 'Customer', fields: { _id: { type: 'string' } } }),
    f('analytics_db/app/report/Monthly.json', { name: 'Monthly', fields: { _id: { type: 'string' } } }),
  ];
  const items = load.planLoad(CFG, files);

  assert.deepEqual(locOf(items, 'Order'), { source: 'mongoMain', database: 'sales_db', schema: null });
  // Mongo 不读 L2：inventory 目录被打平，归属仍是 sales_db
  assert.deepEqual(locOf(items, 'Item'), { source: 'mongoMain', database: 'sales_db', schema: null });
  // PG 读 L2：app = schema
  assert.deepEqual(locOf(items, 'Customer'), { source: 'pgMain', database: 'analytics_db', schema: 'app' });
  // PG L3 自由目录打平：schema 仍是 app
  assert.deepEqual(locOf(items, 'Monthly'), { source: 'pgMain', database: 'analytics_db', schema: 'app' });
});

test('A1 同名主 ≥2 ⇒ ERR:LOAD 主定义重复', () => {
  const files = [
    f('sales_db/Order.json', { name: 'Order', fields: { _id: { type: 'string' } } }),
    f('sales_db/inventory/Order.json', { name: 'Order', fields: { _id: { type: 'string' } } }),
  ];
  assert.throws(() => load.planLoad(CFG, files), /ERR:LOAD 主定义重复/);
});

test('A3 主从识别：主 + replica ⇒ 主在前、其后从', () => {
  const files = [
    f('analytics_db/Order.json', { name: 'Order', replica: true }),
    f('sales_db/Order.json', { name: 'Order', collection: 'order', fields: { _id: { type: 'string' } } }),
  ];
  const items = load.planLoad(CFG, files);
  assert.equal(items.length, 2);
  assert.equal(items[0].defn.replica, undefined);          // 主在前
  assert.equal(items[0].location.database, 'sales_db');
  assert.equal(items[1].defn.replica, true);               // 从在后
  assert.equal(items[1].location.database, 'analytics_db');

  schema.registerBatch(items, null);
  assert.equal(schema.has('Order'), true);
});

test('A3 同名主 0 份（全 replica）⇒ ERR:LOAD 主定义缺失', () => {
  const files = [f('sales_db/Order.json', { name: 'Order', replica: true })];
  assert.throws(() => load.planLoad(CFG, files), /ERR:LOAD 主定义缺失/);
});

test('库目录未声明 ⇒ ERR:LOAD 库目录未声明', () => {
  const files = [f('other_db/Order.json', { name: 'Order' })];
  assert.throws(() => load.planLoad(CFG, files), /ERR:LOAD 库目录未声明/);
});

test('连接 kind 非法 ⇒ ERR:LOAD kind 非法', () => {
  const bad = { sources: { x: { kind: 'oracle', databases: ['d'] } }, defs: ['schema'] };
  assert.throws(() => load.planLoad(bad, []), /ERR:LOAD 连接 x 的 kind 非法/);
});

test('loadDefs：真实目录 IO + registerBatch（落点注入 core）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-load-'));
  try {
    fs.mkdirSync(path.join(root, 'schema', 'sales_db'), { recursive: true });
    fs.writeFileSync(path.join(root, 'schema', 'sales_db', 'Order.json'),
      JSON.stringify({ name: 'Order', collection: 'order', fields: { _id: { type: 'string' } } }), 'utf8');
    fs.writeFileSync(path.join(root, 'store.config.json'),
      JSON.stringify({ sources: { mongoMain: { kind: 'mongodb', databases: ['sales_db'] } }, defs: ['schema'] }), 'utf8');

    const items = await load.loadDefs({ config: path.join(root, 'store.config.json') });
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].location, { source: 'mongoMain', database: 'sales_db', schema: null });
    assert.equal(schema.has('Order'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('门面 store.loadDefs 指向目录装载器（不被 metadef 同名方法遮蔽）', async () => {
  const { Store, metadef } = require('../src');
  const s = new Store();
  // 定义控制面仍经导出的 metadef 模块可达
  assert.equal(typeof metadef.loadDefs, 'function', 'metadef 模块应仍提供 loadDefs');
  // 门面 loadDefs 必须是目录装载器语义（缺 config 抛 ERR:LOAD），而非 metadef
  await assert.rejects(() => s.loadDefs({}), /ERR:LOAD loadDefs 缺 config/);
});
