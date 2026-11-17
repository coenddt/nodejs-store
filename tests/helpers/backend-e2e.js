'use strict';

const assert = require('node:assert/strict');
const { store } = require('../../src');

/** A4 insert + query（含 _id 还原）闭环：读回断言 _id 还原与字段保真（real-backends / sql-executor 共用） */
async function insertAndReadBackPost(schema) {
  const doc = await store.insert(schema, { title: '你好', status: 'draft', views: 3 });
  assert.ok(doc && typeof doc._id === 'string' && doc._id.startsWith('p_'), '应生成 idPrefix 前缀 _id');
  const items = await store.query(`${schema}{_id, title, status, views}`);
  assert.equal(items.length, 1);
  assert.equal(items[0]._id, doc._id);
  assert.equal(items[0].title, '你好');
  assert.equal(items[0].views, 3);
  return doc;
}

/** introspect 产物 widgets/gadgets 断言：字段映射 + 主/外键关系方向（两 sync e2e 共用） */
function assertWidgetsGadgetsDefs(defs, ds) {
  const widgets = defs.find((d) => d.name === 'widgets');
  assert.ok(widgets, '应产出 widgets 定义');
  assert.equal(widgets.collection, 'widgets');
  assert.equal(widgets.datasource, ds);
  assert.ok(widgets.fields._id, '主键应映射为 _id');
  assert.equal(widgets.fields.sku.required, true, 'NOT NULL 应映射 required');
  assert.equal(widgets.fields.price.type, 'number');
  assert.ok(widgets.relations.gadgets, '外键应生成反向 many 关系');
  assert.equal(widgets.relations.gadgets.type, 'many');

  const gadgets = defs.find((d) => d.name === 'gadgets');
  assert.ok(gadgets.relations.widgets, '外键侧应有 many-to-one 关系');
  assert.equal(gadgets.relations.widgets.type, 'one');
  assert.equal(gadgets.relations.widgets.localField, 'widget_id');
}

module.exports = { insertAndReadBackPost, assertWidgetsGadgetsDefs };
