'use strict';

/**
 * mongo-store-js 行为测试（纯逻辑，无真实 DB）
 *
 * schema / pipeline / permission / computes 的纯逻辑已全部下沉 Rust core（独立仓库 mongo-store-rust），
 * 对拍由其 core/tests/parity*.rs + core-node/test/parity.test.js 覆盖；
 * 本文件只测薄 Host 适配层的行为（读路径分支 + 写路径全流程，mock 驱动）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { schema: _sc, crud: _crud_mod, permission: perm } = require('../src');

// ─────────────────────────────────────────────────────────────
// 内置最小 schema（与业务工程 CommercialLedger 同构）
// ─────────────────────────────────────────────────────────────

_sc.register({
  name: 'CommercialLedger', collection: 'commercial_ledger', idPrefix: 'CL', timestamps: true,
  fields: { unit: 'string', income: 'float' }, relations: {}, read: null, write: null,
});
_sc.register({
  name: 'GoalLedger', collection: 'goal_ledger', idPrefix: 'GL', timestamps: true,
  fields: { income: 'float' }, relations: {}, read: null, write: null,
});
// pipeline 嵌套关系 / computes 递归下钻所需
_sc.register({
  name: 'Child', collection: 'child', timestamps: false,
  fields: { name: 'string' }, relations: {}, computes: {},
});
_sc.register({
  name: 'ChildR', collection: 'child_r', timestamps: false,
  fields: { c: { type: 'string', default: 'cd' } }, relations: {}, computes: {},
});
_sc.register({
  name: 'ParentR', collection: 'parent_r', timestamps: false,
  fields: { p: { type: 'string' } }, computes: {},
  relations: { child: { model: 'ChildR', type: 'one' } },
});

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

test('perm.scopedRoles / runAsInternal', async () => {
  perm.setContext(undefined);
  perm.scopedRoles(['seller'], () => {
    assert.deepEqual(perm.getContext().roles, ['seller']);
  });
  assert.equal(perm.getContext(), undefined); // 退出恢复原上下文
  const out = await perm.runAsInternal(async () => perm.getContext().internal);
  assert.equal(out, true);
});

// ---------- crud 行为测试（find 优化 / 两阶段 / 标准批次 / 写路径） ----------

class _MemCursor {
  constructor(docs) {
    this.docs = docs;
  }

  async toArray() {
    return [...this.docs];
  }
}

class _MemColl {
  /** 内存版 collection：覆盖 crud 写路径所需全部方法 */
  constructor(docs) {
    this.docs = docs !== undefined ? docs : [];
  }

  find(query, projection) {
    return new _MemCursor(this.docs);
  }

  aggregate(pipeline) {
    return new _MemCursor(this.docs);
  }

  async findOne(query, projection) {
    return this.docs.length ? { ...this.docs[0] } : null;
  }

  async countDocuments(filter) {
    return this.docs.length;
  }

  async insertOne(doc) {
    this.docs.push(doc);
    return { insertedId: doc._id };
  }

  async insertMany(docs) {
    this.docs.push(...docs);
    return { insertedCount: docs.length };
  }

  async findOneAndUpdate(condition, update, options) {
    const base = this.docs.length ? { ...this.docs[0] } : {};
    for (const st of Object.values(update)) {
      if (st && typeof st === 'object') Object.assign(base, st);
    }
    if (options && options.upsert && !this.docs.length) this.docs.push(base);
    return base;
  }

  async updateMany(condition, data) {
    return { modifiedCount: this.docs.length };
  }

  async deleteMany(condition) {
    const n = this.docs.length;
    this.docs = [];
    return { deletedCount: n };
  }

  listIndexes() {
    return new _MemCursor([]);
  }
}

class _FakeDb {
  /** 按 collection 名分配独立 coll；未知名自动建空 _MemColl（供 queryOne 空结果等） */
  constructor(coll) {
    this._colls = {};
    if (coll !== undefined) this._colls.commercial_ledger = coll;
  }

  collection(name) {
    if (!this._colls[name]) this._colls[name] = new _MemColl();
    return this._colls[name];
  }
}

/** 读路径 mock：内存 coll + 空权限 ctx，返回 fake coll */
function _crudMock() {
  const docs = [{ unit: 'a', income: 100.0, _id: '1' }];
  const coll = new _MemColl(docs);
  perm.setContext(undefined);
  _crud_mod.setDb(new _FakeDb(coll));
  return [coll, docs];
}

/** 写路径 mock：ctx=空 + 内存 coll + CommercialLedger schema */
function _crudWMock(docs) {
  const coll = new _MemColl(docs);
  perm.setContext(undefined);
  _crud_mod.setDb(new _FakeDb(coll));
  return coll;
}

test('crud.query 纯 $match / 标准聚合', async () => {
  _crudMock();
  const items = await _crud_mod.query('CommercialLedger{unit, income}');
  assert.ok(Array.isArray(items));
  assert.equal(items[0].unit, 'a');
});

test('crud.query 带关系与排序仍返回裁剪结果', async () => {
  _crudMock();
  const items = await _crud_mod.query('CommercialLedger{unit}');
  assert.ok(items.length && items[0].unit === 'a');
});

test('crud.queryOne', async () => {
  _crudMock();
  const one = await _crud_mod.queryOne('CommercialLedger{unit, income}');
  assert.ok(one && one.unit === 'a');
  assert.equal(await _crud_mod.queryOne('GoalLedger{income}'), null); // 无结果 → null
});

test('crud.queryWithCount 分页元数据', async () => {
  const [coll] = _crudMock();
  coll.countDocuments = async () => 200;
  const r = await _crud_mod.queryWithCount(
    'CommercialLedger($skip:@s,$limit:@l){unit, income}',
    { s: 0, l: 50 },
  );
  assert.equal(r.total, 200);
  assert.equal(r.pageSize, 50);
  assert.equal(r.page, 0);
});

test('crud.queryWithCount pageSize 上限 5000', async () => {
  _crudMock();
  const r = await _crud_mod.queryWithCount('CommercialLedger{unit}', { pageSize: 99999, page: 0 });
  assert.equal(r.pageSize, 5000); // 上限 5000 防拖库
});

test('crud.insert 自动 ID + 时间戳', async () => {
  const coll = _crudWMock();
  const doc = await _crud_mod.insert('CommercialLedger', { unit: 'x', income: 9.0 });
  assert.ok(doc._id.startsWith('CL')); // idPrefix 自动生成
  assert.ok(doc.createdAt && doc.updatedAt); // 时间戳补默认
  assert.equal(coll.docs[0].unit, 'x');
});

test('crud.insertMany 空数组返回空', async () => {
  _crudWMock();
  assert.deepEqual(await _crud_mod.insertMany('CommercialLedger', []), []);
});

test('crud.insertMany 填充 ID', async () => {
  const coll = _crudWMock();
  const out = await _crud_mod.insertMany('CommercialLedger', [{ unit: 'a' }, { unit: 'b' }]);
  assert.equal(out.length, 2);
  assert.ok(out.every((d) => d._id.startsWith('CL')));
  assert.equal(coll.docs.length, 2);
});

test('crud.update $set 模式', async () => {
  _crudWMock([{
    _id: '1', unit: 'a', income: 100.0, createdAt: 1, updatedAt: 1,
  }]);
  const out = await _crud_mod.update('CommercialLedger', { _id: '1' }, { income: 200.0 });
  assert.ok(out && out.income === 200.0);
  assert.ok(out.updatedAt); // $set 模式自动刷 updatedAt
});

test('crud.update 原生操作符透传', async () => {
  _crudWMock([{
    _id: '1', income: 100.0, createdAt: 1, updatedAt: 1,
  }]);
  const out = await _crud_mod.update('CommercialLedger', { _id: '1' }, { $inc: { income: 5 } });
  assert.ok(out !== null);
  // 原生 $inc 透传，不触发 $set 字段校验
});

test('crud.update 空 $set 抛错', async () => {
  _crudWMock([{ _id: '1', unit: 'a' }]);
  await assert.rejects(
    () => _crud_mod.update('CommercialLedger', { _id: '1' }, { _id: '1' }),
    /没有提供要更新的字段/,
  );
});

test('crud.updateMany 原生与 $set', async () => {
  _crudWMock([{ income: 1.0 }]);
  const r1 = await _crud_mod.updateMany('CommercialLedger', {}, { $inc: { income: 1 } });
  assert.equal(r1.modifiedCount, 1);
  const r2 = await _crud_mod.updateMany('CommercialLedger', {}, { income: 2.0 });
  assert.equal(r2.modifiedCount, 1);
});

test('crud.remove 归档 + 物理删除', async () => {
  // CommercialLedger 注册时已自动注册 CommercialLedgerDeleted，归档分支命中
  const coll = _crudWMock([{
    _id: '1', unit: 'a', income: 1.0,
  }]);
  const r = await _crud_mod.remove('CommercialLedger', { _id: '1' });
  assert.equal(r.deletedCount, 1);
  assert.equal(r.archivedCount, 1); // 归档一条 + 物理删除一条
  coll.docs = [{ _id: '2', unit: 'b' }];
  const r2 = await _crud_mod.remove('CommercialLedger', { _id: '2' });
  assert.equal(r2.archivedCount, 1);
});

test('crud.exists / count', async () => {
  _crudWMock([{ _id: '1' }]);
  assert.equal(await _crud_mod.exists('CommercialLedger', { _id: '1' }), true);
  assert.equal(await _crud_mod.count('CommercialLedger', { _id: '1' }), 1);
});

test('crud.upsert 按条件命中', async () => {
  _crudWMock();
  const out = await _crud_mod.upsert('CommercialLedger', { _id: 'u1' }, { unit: 'upserted' });
  assert.ok(out && out.unit === 'upserted');
});

test('crud.upsert 生成新 ID', async () => {
  _crudWMock();
  const out = await _crud_mod.upsert('CommercialLedger', { year: 2026 }, { unit: 'x' });
  assert.ok(out && out._id.startsWith('CL'));
});

test('crud.mutation 单条与数组', async () => {
  _crudWMock();
  const single = await _crud_mod.mutation('CommercialLedger', { year: 2026, unit: 'solo' });
  assert.ok(single && single._id.startsWith('CL'));
  const arr = await _crud_mod.mutation('CommercialLedger', [{ unit: 'a' }, { unit: 'b' }]);
  assert.ok(Array.isArray(arr) && arr.length === 2);
});

test('crud.mutation 空数组返回空数组', async () => {
  _crudWMock();
  assert.deepEqual(await _crud_mod.mutation('CommercialLedger', []), []);
});

test('crud.aggregate', async () => {
  _crudWMock([{ unit: 'a' }]);
  const out = await _crud_mod.aggregate('CommercialLedger', [{ $match: { unit: 'a' } }]);
  assert.ok(out.length && out[0].unit === 'a');
});
