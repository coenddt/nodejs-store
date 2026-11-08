'use strict';

/**
 * update 返回值（returns）：只叠 **同步 fn 计算列**，**不补任何默认值**。
 *
 * 契约：入参必须是 `returnDocument: AFTER` 的落库文档；默认值只在 insert 物化一次，
 * 否则同一行会出现「落库 / returns / 读回」三种取值（D1）。
 * 与 py-store `tests/test_session.py` 的 returns 用例同构。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connect } = require('../src/local');
const { init, store, schema: _sc } = require('../src');
const { writeReturns } = require('../src/crud/write');

const _dirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nodejs-store-wret-${tag}-`));
  _dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of _dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('returns: update 返回值含同步 fn 计算列', async () => {
  _sc.setFn('retItemTotal', (it) => (it.a || 0) + (it.b || 0));
  const defn = {
    name: 'RetItem', collection: 'ret_items', idPrefix: 'ri', timestamps: false,
    fields: { _id: { type: 'string' }, a: { type: 'int' }, b: { type: 'int' } },
    computes: { total: { type: 'int', fn: true, depends: ['a', 'b'] } },
  };
  _sc.register(defn);
  _sc.assertFnsCovered([defn]);

  await init(connect({ dir: tmpDir('computes') }));
  const ins = await store.insert('RetItem', { a: 1, b: 2 });
  const out = await store.update('RetItem', { _id: ins._id }, { a: 10 });
  assert.equal(out.total, 12);
});

test('returns: 与再次读回一致（落库 / returns / 读回同值）', async () => {
  _sc.setFn('retSumTotal', (it) => (it.a || 0) + (it.b || 0));
  const defn = {
    name: 'RetSum', collection: 'ret_sums', idPrefix: 'rs', timestamps: false,
    fields: {
      _id: { type: 'string' }, a: { type: 'int' }, b: { type: 'int' },
      n: { type: 'int', default: 7 },
    },
    computes: { total: { type: 'int', fn: true, depends: ['a', 'b'] } },
  };
  _sc.register(defn);
  _sc.assertFnsCovered([defn]);

  await init(connect({ dir: tmpDir('reread') }));
  const ins = await store.insert('RetSum', { a: 2, b: 3 });
  const out = await store.update('RetSum', { _id: ins._id }, { b: 5 });
  const rows = await store.query('RetSum{ _id, a, b, n, total }');
  assert.equal(out.total, rows[0].total, 'returns 与读回的计算列一致');
  assert.equal(out.total, 7);
  assert.equal(out.n, rows[0].n, '默认值不被重复填充，两边一致');
  assert.equal(out.n, 7);
});

test('returns: 无 fn 声明原样返回（不补默认值）', () => {
  _sc.register({
    name: 'RetPlain', collection: 'ret_plains', idPrefix: 'rp', timestamps: false,
    fields: {
      _id: { type: 'string' }, v: { type: 'string' }, n: { type: 'int', default: 9 },
    },
  });
  const out = writeReturns('RetPlain', { _id: 'rp1', v: 'a' });
  assert.deepEqual(out, { _id: 'rp1', v: 'a' }, '不得补 n=9');
});

test('returns: fn: true 未注册实现 ⇒ 显式报错', () => {
  _sc.register({
    name: 'RetNoFn', collection: 'ret_nofns', idPrefix: 'rn', timestamps: false,
    fields: { _id: { type: 'string' }, a: { type: 'int' } },
    computes: { orphan: { type: 'int', fn: true, depends: ['a'] } },
  });
  assert.throws(
    () => writeReturns('RetNoFn', { _id: 'rn1', a: 1 }),
    /未注册同步实现/,
  );
});
