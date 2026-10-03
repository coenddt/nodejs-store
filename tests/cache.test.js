'use strict';

/**
 * 缓存状态注记（B6）：注记必须为真——无 provider 恒 BYPASS；
 * 非法值/抛错回落 BYPASS 且走反馈通道留痕（不打断响应，禁静默）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../src/cache');
const feedback = require('../src/feedback');

/** 收集期间 emit 的事件（用后恢复原 sink，并复位 provider 防跨用例污染） */
function collect(body) {
  const prev = feedback.getSink();
  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    body();
  } finally {
    feedback.setSink(prev);
    cache.setCacheStatus(null);
  }
  return events;
}

test('B6：无 provider → 恒 BYPASS（注记必须为真）', () => {
  cache.setCacheStatus(null);
  assert.equal(cache.cacheStatus(), 'BYPASS');
});

test('B6：provider 返回非法值 → BYPASS 且反馈留痕', () => {
  const events = collect(() => {
    cache.setCacheStatus(() => 'NOPE');
    assert.equal(cache.cacheStatus(), 'BYPASS');
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'cacheStatusInvalid');
  assert.equal(events[0].layer, 'host');
});

test('B6：provider 抛错 → BYPASS 且反馈留痕（不打断响应）', () => {
  const events = collect(() => {
    cache.setCacheStatus(() => { throw new Error('boom'); });
    assert.equal(cache.cacheStatus(), 'BYPASS');
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'cacheStatusFailed');
  assert.match(events[0].message, /boom/);
});

test('B6：provider 返回合法值 → 原样透传', () => {
  const events = collect(() => {
    cache.setCacheStatus(() => 'HIT');
    assert.equal(cache.cacheStatus(), 'HIT');
  });
  assert.equal(events.length, 0);
});
