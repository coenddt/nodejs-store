'use strict';

/**
 * `fields ∩ computes` 同名（计算列覆盖同名字段）—— Node 宿主 parity 用例
 *
 * 语义（蓝本行为，core 5.1.0 起 py-store / go-store 对齐）：
 *   - 查询期：computes 拥有同名键的输出所有权，输出计算列求值结果；
 *   - 写入期：字段仍在 fields 中，`$inc` 等增量更新按同名键落库。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/fields-computes-same-name.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { connect } = require('../src/memory');
const datasource = require('../src/datasource');
const { init, store, schema: _sc } = require('../src');

async function liveFavoriteCount(items) {
  for (const it of items) it.favoriteCount = 3;
}

test('fields ∩ computes 同名：注册放行 + 查询输出计算列 + $inc 按字段落库', async () => {
  _sc.register({
    name: 'FavoriteListing',
    collection: 'favorite_listings',
    idPrefix: 'fl_',
    timestamps: false,
    fields: {
      _id: { type: 'string' },
      title: { type: 'string' },
      // 与 computes 同名：保留类型声明，供写入校验 / DDL / $inc 使用
      favoriteCount: { type: 'int' },
    },
    relations: {},
    computes: {
      favoriteCount: { type: 'int', asyncFn: liveFavoriteCount, depends: [] },
    },
  });

  const mem = new Map();
  try {
    await init(connect({ store: mem }));

    await store.insert('FavoriteListing', {
      _id: 'fl_1', title: 'a', favoriteCount: 7,
    });

    const rows = await store.query(
      'FavoriteListing($sort:@s0){ _id favoriteCount }',
      { s0: { _id: 1 } },
    );
    assert.deepEqual(rows, [{ _id: 'fl_1', favoriteCount: 3 }], '查询期计算列覆盖同名字段');

    await store.update('FavoriteListing', { _id: 'fl_1' }, { $inc: { favoriteCount: 1 } });
    const stored = mem.get('favoriteListings') || [];
    assert.equal(stored.length, 1, `内存集合应有 1 条文档：${JSON.stringify(stored)}`);
    assert.equal(stored[0].favoriteCount, 8, '$inc 按 fields 同名键落库（7 → 8）');
  } finally {
    datasource.setConnections({});
  }
});
