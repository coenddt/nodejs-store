'use strict';

/**
 * 覆盖率余量：crud/id 供给分支（D4-4 零语义拆分）。
 *
 * 自 tests/coverage-margin.test.js 原样迁出 one 关系子节点入池用例；
 * 用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { schema: _sc } = require('../src');
const { _newIdPool } = require('../src/crud/id');

// ─── ID 供给：one 关系子节点 ─────────────────────────────────

test('crud/id: one 关系子节点缺 _id 时入池', () => {
  _sc.register({
    name: 'CovPoolParent', collection: 'cov_pool_parent', timestamps: false,
    fields: { a: { type: 'string' } },
    relations: {
      child: {
        model: 'CovPoolChild', type: 'one', localField: '_id', foreignField: 'parentId',
      },
    },
  });
  _sc.register({
    name: 'CovPoolChild', collection: 'cov_pool_child', idPrefix: 'CPC', timestamps: false,
    fields: { parentId: { type: 'string' } }, relations: {},
  });

  const pool = _newIdPool('CovPoolParent', { _id: 'p1', child: { parentId: 'p1' } });
  assert.equal(pool.length, 1, JSON.stringify(pool));
  assert.ok(pool[0].startsWith('CPC'), 'one 关系子节点缺 _id 时也须入池');
});
