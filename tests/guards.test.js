'use strict';

/**
 * 宿主接入守卫测试（对齐 py-store tests/test_py_store.py 守卫用例）
 *
 * 覆盖：timestamps 单位感知（秒级注入 / 毫秒缺省）、非法 timestamps 注册即报错
 * （core 校验）、feedback 事件通道（sink 回调 / 默认 stderr / SQL 下推拦截自动反馈）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { schema: _sc, crud: _crud_mod, datasource: _ds, feedback } = require('../src');
const { core } = require('../src/schema');
const { permission: perm } = require('../src');

// ─────────────────────────────────────────────────────────────
// 内置最小 schema（node --test 每文件独立进程，需自注册）
// ─────────────────────────────────────────────────────────────

_sc.register({
  name: 'CommercialLedger', collection: 'commercial_ledger', idPrefix: 'CL', timestamps: true,
  fields: { unit: 'string', income: 'float' }, relations: {}, read: null, write: null,
});

// ─────────────────────────────────────────────────────────────
// mock 驱动（与 test-nodejs-store.js 同构的最小内存实现）
// ─────────────────────────────────────────────────────────────

class _MemColl {
  constructor(docs) {
    this.docs = docs !== undefined ? docs : [];
  }

  find() {
    return { toArray: async () => [...this.docs] };
  }

  aggregate() {
    return { toArray: async () => [...this.docs] };
  }

  async findOne() {
    return this.docs.length ? { ...this.docs[0] } : null;
  }

  async countDocuments() {
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

  async updateMany() {
    return { modifiedCount: this.docs.length };
  }

  async deleteMany() {
    const n = this.docs.length;
    this.docs = [];
    return { deletedCount: n };
  }

  listIndexes() {
    return { toArray: async () => [] };
  }
}

class _FakeDb {
  constructor(coll) {
    this._colls = {};
    if (coll !== undefined) this._colls.commercial_ledger = coll;
  }

  collection(name) {
    if (!this._colls[name]) this._colls[name] = new _MemColl();
    return this._colls[name];
  }
}

/** 写路径 mock：ctx=空 + 内存 coll + CommercialLedger schema */
function _crudWMock(docs) {
  const coll = new _MemColl(docs);
  perm.setContext(undefined);
  _crud_mod.setConnections(new _FakeDb(coll));
  return coll;
}

// ─────────────────────────────────────────────────────────────
// 扩展守卫：timestamps 单位 / feedback 事件
// ─────────────────────────────────────────────────────────────

test('timestamps: "s" → Host 时钟注入秒级时间戳', async () => {
  _sc.register({
    name: 'SecLedger', collection: 'sec_ledger', idPrefix: 'SEC', timestamps: 's',
    fields: { unit: 'string' }, relations: {}, read: null, write: null,
  });
  assert.equal(_sc.get('SecLedger').timestampUnit, 's');
  _crudWMock();
  const doc = await _crud_mod.insert('SecLedger', { unit: 'x' });
  assert.ok(doc.createdAt > 0 && doc.createdAt < 1e10);
  assert.ok(doc.updatedAt > 0 && doc.updatedAt < 1e10);
});

test('缺省 timestamps: true → 毫秒级（13 位量级）', async () => {
  _crudWMock();
  const doc = await _crud_mod.insert('CommercialLedger', { unit: 'x', income: 1.0 });
  assert.ok(doc.createdAt >= 1e12);
});

test('非法 timestamps 注册即报错（core 校验，行为收紧）', () => {
  assert.throws(
    () => _sc.register({
      name: 'BadLedger', collection: 'bad_ledger', timestamps: 'years',
      fields: {}, relations: {},
    }),
    /timestamps 仅支持/,
  );
});

test('feedback sink 回调与默认 stderr（不抛错即可）', () => {
  const events = [];
  feedback.setSink((e) => events.push(e));
  feedback.emit({
    type: 'federation_degraded', code: 'crossSourceSort',
    layer: 'federation', message: 'm', hint: 'h',
  });
  assert.ok(events.length && events[0].code === 'crossSourceSort');
  feedback.setSink(null); // 恢复默认 stderr
  feedback.emit({ code: 'x' });
});

test('PushdownUnsupportedError 结构与 feedback() 投影', () => {
  const err = new _ds.PushdownUnsupportedError('mysql_a', 'mysql', ['lookupTopN'], ['每父 top-N 无法下推']);
  assert.ok(err instanceof Error); // 旧调用方兼容
  const ev = err.feedback();
  assert.equal(ev.type, 'sql_pushdown_unsupported');
  assert.equal(ev.code, 'pushdownUnsupported');
  assert.equal(ev.layer, 'dialect');
  assert.equal(ev.source, 'mysql_a');
});

test('execSql unsupported：抛结构化异常的同时自动产出反馈事件', async () => {
  const origTranslate = core.dialectTranslate;
  const events = [];
  core.dialectTranslate = () => ({ unsupported: [{ code: 'lookupTopN' }], warnings: ['w1'] });
  feedback.setSink((e) => events.push(e));
  try {
    await assert.rejects(
      () => _ds.execSql(
        'mysql_a',
        { kind: 'mysql', exec: async () => { throw new Error('不应执行到 SQL 执行器'); } },
        { collection: 'commercial_ledger' },
      ),
      (e) => e instanceof _ds.PushdownUnsupportedError && /lookupTopN/.test(e.message),
    );
  } finally {
    core.dialectTranslate = origTranslate;
    feedback.setSink(null);
  }
  assert.ok(events.length && events[0].type === 'sql_pushdown_unsupported');
});
