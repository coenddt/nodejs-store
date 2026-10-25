'use strict';

/**
 * fields 键空间完全开放（原初设计修复回归）：字段名叫 `type` 的合法 schema 全链路
 *
 * 背景：core 4.8.x 的 RESERVED_KEYS 保留键检查把 field 级契约键误当字段名保留字，
 * `fields: { type: { type: 'string' } }` 注册即抛 ERR_NAME_CONFLICT；core 4.9.0 移除
 * 保留键检查后全链路可用。本文件是用户验收锚点（注册 + insert + GQL + update + remove）。
 *
 * 运行：`cd nodejs-store; $env:LOCAL_CORE='1'; node --test tests/field-name-type.test.js`
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { connect } = require('../src/memory');
const datasource = require('../src/datasource');
const { init, store, schema: _sc } = require('../src');

test('field name `type`: 注册 + insert(default) + GQL 查询 + update + remove 全链路', async () => {
  _sc.register({
    name: 'TypeFieldMsg', collection: 'type_field_msgs', idPrefix: 'tfm_', timestamps: false,
    fields: {
      _id: { type: 'string' },
      type: { type: 'string', default: 'text' },
      content: { type: 'string' },
    },
    relations: {},
  });
  try {
    await init(connect({ store: new Map() }));

    // insert：缺省 type → default 'text' 生效
    const a = await store.insert('TypeFieldMsg', { content: 'hello' });
    assert.equal(a.type, 'text', 'default 应生效');

    // insert：显式 type 保真
    const b = await store.insert('TypeFieldMsg', { type: 'image', content: 'pic' });
    assert.equal(b.type, 'image');

    // GQL 查询：投影含 type 字段 + $condition 过滤（GQL 参数只接受 $var:@key 引用形态）
    const rows = await store.query(
      'TypeFieldMsg($condition:@c){ _id type content }',
      { c: { type: 'image' } },
    );
    assert.deepEqual(rows, [{ _id: b._id, type: 'image', content: 'pic' }]);

    // update：type 字段可写
    await store.update('TypeFieldMsg', { _id: b._id }, { type: 'video' });
    const after = await store.query('TypeFieldMsg{ _id type }');
    assert.deepEqual(after.find((r) => r._id === b._id).type, 'video');

    // remove
    await store.remove('TypeFieldMsg', { _id: a._id });
    assert.equal(await store.count('TypeFieldMsg', {}), 1);
  } finally {
    datasource.setConnections({});
  }
});
