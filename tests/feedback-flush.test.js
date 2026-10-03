'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const feedback = require('../src/feedback');

/** mock store：只记录 __feedback 落库 */
function mockStore() {
  const rows = [];
  return { rows, async insert(name, row) { rows.push({ name, row }); return row; } };
}

test('A3残留：emit 后 flush() → 在途事件已入库（无丢事件窗口）', async () => {
  const s = mockStore();
  const dispose = feedback.enableFeedbackTable(s);
  feedback.emit({ type: 't', code: 'c', layer: 'host', message: 'm', hint: 'h' });
  await feedback.flush();
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].name, '__feedback');
  assert.equal(s.rows[0].row.code, 'c');
  await dispose();               // disposer 为 async：恢复 sink + flush
});

test('A3残留：落库失败不静默（failCount 递增、不抛回 emit）', async () => {
  const s = { async insert() { throw new Error('boom'); } };
  const before = feedback.failCount();
  const dispose = feedback.enableFeedbackTable(s);
  assert.doesNotThrow(() => feedback.emit({ type: 't', code: 'c', layer: 'host' }));
  await feedback.flush();
  assert.equal(feedback.failCount(), before + 1);
  await dispose();
});
