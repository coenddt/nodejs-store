'use strict';

/**
 * L2 计算列包绑定契约（共享分层与多落点择优 05 / A6）
 *
 * 覆盖：
 *   1. A6：schema 逻辑 fnRef="Order.total" 与 Node 实现 orderTotal 归一匹配；
 *   2. A6 默认复合名：无 fnRef 时逻辑 ref = <name>.<key>；
 *   3. 缺失实现 ⇒ ERR_FN_MISSING（不静默丢列）；
 *   4. 归一后实现名重复 ⇒ ERR_FN_CONFLICT（不静默覆盖）。
 *
 * 依赖 core 透出的 `native.canonical`（02 落地）——须以 LOCAL_CORE=1 从相邻
 * rust-store/core-node/dist 加载调试产物运行（与其余宿主用例同口径）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const schema = require('../src/schema');

test('A6：逻辑 fnRef="Order.total" 与 Node 实现 orderTotal 归一匹配', () => {
  schema.setFn('orderTotal', (it) => it.a + it.b);
  const defn = {
    name: 'Order',
    collection: 'order',
    fields: { _id: { type: 'string' }, a: { type: 'int' }, b: { type: 'int' } },
    computes: { total: { type: 'int', fn: true, fnRef: 'Order.total', depends: ['a', 'b'] } },
  };
  assert.doesNotThrow(() => schema.assertFnsCovered([defn]));
});

test('A6 默认复合名：无 fnRef 时逻辑 ref = <name>.<key>，可由 orderTotal 匹配', () => {
  schema.setFn('orderTotal', (it) => it.a + it.b);
  assert.doesNotThrow(() => schema.assertFnsCovered([
    { name: 'Order', computes: { total: { type: 'int', fn: true } } },
  ]));
});

test('缺失实现 ⇒ ERR_FN_MISSING（不静默）', () => {
  let err;
  try {
    schema.assertFnsCovered([
      { name: 'Nope', computes: { zzz: { type: 'int', fn: true } } },   // 逻辑 ref Nope.zzz 无实现
    ]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, '应抛 ERR_FN_MISSING');
  assert.match(err.message, /ERR_FN_MISSING/);
  assert.equal(err.code, 'ERR_FN_MISSING');
});

test('归一冲突 ⇒ ERR_FN_CONFLICT', () => {
  assert.throws(() => {
    schema.setFn('orderTotal', () => 1);
    schema.setFn('order_total', () => 2);
  }, /ERR_FN_CONFLICT/);
});
