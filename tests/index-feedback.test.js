'use strict';

/**
 * 索引创建失败 → 统一反馈通道用例（第 8 轮整改 R7-m1 回归）
 *
 * init() 期间 Mongo 源 `createIndex` 抛错时：
 *   1. 不阻塞 init（索引为辅助动作，失败不中断启动）；
 *   2. 必须经 `feedback.emit` 产出 `{type:'index_create_failed', code, layer, message, hint}`
 *      事件 —— 宿主 sink 可接管（允许拦截，禁止静默失守），无 sink 时由
 *      feedback 默认落 stderr（不双份打印）。
 *
 * 运行：node scripts/test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init, feedback, schema: _sc } = require('../src');

/** listIndexes 正常返回空、createIndex 必失败的 Mongo db 实例桩（collection 为函数形态） */
const failDb = {
  collection() {
    return {
      listIndexes() {
        return { toArray: async () => [] };
      },
      async createIndex() {
        throw new Error('模拟索引创建失败');
      },
    };
  },
};

test('索引创建失败 → feedback sink 收到 index_create_failed 事件，且 init 不中断', async () => {
  _sc.register({
    name: 'IdxFailDoc',
    collection: 'idx_fail_docs',
    timestamps: false,
    fields: { title: { type: 'string' } },
    relations: {},
    indexes: [{ keys: { title: 1 } }],
  });

  const events = [];
  feedback.setSink((e) => events.push(e));
  try {
    await init(failDb); // 不应因 createIndex 抛错而中断

    const ev = events.find((e) => e.type === 'index_create_failed');
    assert.ok(ev, 'sink 应收到 index_create_failed 事件（原表与归档表镜像至少各一条）');
    assert.equal(ev.code, 'indexCreateFailed');
    assert.equal(ev.layer, 'host');
    assert.match(ev.message, /idx_fail_docs/, 'message 应含集合名与失败原因');
    assert.ok(ev.hint, '应携带修复指引 hint');
  } finally {
    feedback.setSink(null); // 恢复默认 stderr，避免污染同进程后续用例
  }
});
