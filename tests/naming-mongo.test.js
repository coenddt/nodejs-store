'use strict';

/**
 * Mongo 物理名翻译与结果回映射（设计 §6 / 03 执行文档 §4.5、步骤 9–10）
 *
 * 覆盖：
 *   - 正向 `_toMongo`：collection / 键 / 点号路径 / `$lookup` / `$fieldRef` → camelCase；
 *     `$` 操作符、`_id`、`__` 内部名、关系名（`$lookup.as`）不翻译；`database` 定位名不翻译；
 *   - 反向 `_toLogical`：按逐 schema 逆表 physical → logical（含关系子文档递归）；
 *   - 集成：经 `store.query`/`store.insert` 断言 Mongo 落库用物理集合名 + 逻辑键回读。
 *
 * 说明：本文件 schema 不声明 datasource（回落 `default` 源），故不依赖 P6 落点注入。
 * 运行：node scripts/test.js（置 LOCAL_CORE=1）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init, store, schema } = require('../src');
const naming = require('../src/naming');

// ── 单元：_toMongo 正向翻译 ──────────────────────────────────

test('_toMongo: collection/键/点号路径/$lookup/字段引用 → camelCase；关系名与定位名不译', () => {
  schema.register({
    name: 'NmParent',
    collection: 'nm_parent_items',
    timestamps: false,
    fields: { order_no: 'string', order_total: 'number' },
    relations: {
      line_items: {
        model: 'NmChild', type: 'many', localField: '_id', foreignField: 'parent_id',
      },
    },
  });
  schema.register({
    name: 'NmChild',
    collection: 'nm_child_items',
    timestamps: false,
    fields: { parent_id: 'string', sku_code: 'string' },
    relations: {},
  });

  const cmd = {
    kind: 'aggregate',
    collection: 'nm_parent_items',
    database: 'db_tenant_1',
    filter: { order_no: 'x', order_total: { $gt: 1 } },
    pipeline: [
      {
        $lookup: {
          from: 'nm_child_items',
          as: 'line_items',
          localField: '_id',
          foreignField: 'parent_id',
          pipeline: [{ $match: { $expr: { $eq: ['$parent_id', '$$rel__id'] } } }],
        },
      },
      { $project: { _id: 1, line_items: 1, order_no: 1 } },
    ],
  };

  const out = naming._toMongo(cmd);
  assert.equal(out.collection, 'nmParentItems', 'collection → 物理 camelCase');
  assert.equal(out.database, 'db_tenant_1', 'database 为定位名（非数据标识符）不翻译');
  assert.deepEqual(Object.keys(out.filter), ['orderNo', 'orderTotal'], 'filter 键翻译');

  const lk = out.pipeline[0].$lookup;
  assert.equal(lk.from, 'nmChildItems', '$lookup.from 按集合名翻译');
  assert.equal(lk.as, 'line_items', '$lookup.as 关系名不翻译');
  assert.equal(lk.localField, '_id', 'localField `_id` 保留');
  assert.equal(lk.foreignField, 'parentId', '$lookup.foreignField 关系字段翻译');
  assert.deepEqual(
    lk.pipeline[0].$match.$expr.$eq,
    ['$parentId', '$$rel__id'],
    '字段引用翻译、`$$` 系统变量保留',
  );
  assert.deepEqual(
    Object.keys(out.pipeline[1].$project),
    ['_id', 'line_items', 'orderNo'],
    '$project：`_id` 保留、关系名保留、数据字段翻译',
  );
});

// ── 单元：_toLogical 反向映射（逐 schema 逆表 + 关系递归） ──

test('_toLogical: physical → logical（关系子文档按目标 schema 递归）', () => {
  const cmd = { collection: 'nm_parent_items', kind: 'findOne' };
  const phys = {
    _id: '1',
    orderNo: 'o1',
    orderTotal: 9,
    line_items: [{ _id: 'c1', parentId: 'o1', skuCode: 's1' }],
  };
  assert.deepEqual(naming._toLogical(phys, cmd), {
    _id: '1',
    order_no: 'o1',
    order_total: 9,
    line_items: [{ _id: 'c1', parent_id: 'o1', sku_code: 's1' }],
  });
});

test('_toLogical: 未注册 collection（无法建逆表）原样返回（不臆测反推）', () => {
  const phys = { orderNo: 'x' };
  assert.deepEqual(naming._toLogical(phys, { collection: '__no_such_collection__' }), phys);
});

// ── 集成：Mongo 落库物理集合名 + 逻辑键回读 ──────────────────

class _MemCursor {
  constructor(docs) { this.docs = docs; }

  async toArray() { return [...this.docs]; }
}

class _MemColl {
  constructor(docs) { this.docs = docs || []; }

  find() { return new _MemCursor(this.docs); }

  aggregate() { return new _MemCursor(this.docs); }

  async findOne() { return this.docs.length ? { ...this.docs[0] } : null; }

  async countDocuments() { return this.docs.length; }

  async insertOne(doc) { this.docs.push(doc); return { insertedId: doc._id }; }

  listIndexes() { return new _MemCursor([]); }
}

class _FakeDb {
  constructor(colls) { this.colls = colls || {}; this.accessed = []; }

  collection(name) {
    this.accessed.push(name);
    if (!this.colls[name]) this.colls[name] = new _MemColl();
    return this.colls[name];
  }
}

test('集成：Mongo 命令按物理集合名取集合，结果键还原为逻辑名', async () => {
  schema.register({
    name: 'NmBill',
    collection: 'nm_bills',
    idPrefix: 'nb_',
    timestamps: false,
    fields: { bill_no: 'string', pay_total: 'number' },
    relations: {},
  });

  const physColl = new _MemColl([{ _id: '1', billNo: 'B1', payTotal: 12 }]);
  const db = new _FakeDb({ nmBills: physColl });
  await init(db);

  const rows = await store.query('NmBill{bill_no, pay_total}');
  assert.ok(db.accessed.includes('nmBills'), 'Mongo 应按物理集合名 nmBills 取集合');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bill_no, 'B1', '回读键还原为逻辑名 bill_no');
  assert.equal(rows[0].pay_total, 12, '回读键还原为逻辑名 pay_total');

  const inserted = await store.insert('NmBill', { bill_no: 'B2', pay_total: 7 });
  assert.ok(inserted && inserted.bill_no === 'B2', '写返回逻辑键');
  assert.ok(
    physColl.docs.some((d) => d.billNo === 'B2'),
    '写入落库为物理键 billNo（camelCase）',
  );
});
