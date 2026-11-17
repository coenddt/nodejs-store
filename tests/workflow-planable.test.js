'use strict';

/**
 * 工作流编排 · run 文档形状与注册期可规划性分册（D4-4 零语义拆分）。
 *
 * 自 tests/workflow.test.js 原样迁出 parity run 文档/步骤迹形状与 B1 注册期 GQL
 * 可规划性三例；用例名与断言逐字未改。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workflow } = require('../src');

// B1 可规划性依赖 Inventory 已注册（原先置注册见 ../test-support/workflow-cases.js）
require('../test-support/workflow-cases');

// ─── parity 锚：run 文档与步骤迹形状（双宿主逐字段一致） ─────────

test('parity run 文档形状（keys 与迹条目形状）', async () => {
  const Database = require('better-sqlite3');
  const { init, store, schema, executors, permission, ddl } = require('../src');
  schema.register({ name: 'ShapeItem', collection: 'shape_items', idPrefix: 'sh',
    fields: { _id: { type: 'string' }, n: { type: 'int' } } });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE shape_items (_id VARCHAR(64) PRIMARY KEY, n INTEGER, '
    + 'created_at BIGINT, updated_at BIGINT, deleted_at BIGINT, __present TEXT)');
  for (const st of String(ddl.generate('sqlite', ['__workflowRun'])).split('\n\n')) {
    if (st.trim()) db.exec(st);
  }
  await init({ default: executors.createConnection('sqlite', db) });
  permission.setContext({ userId: 'u1', roles: ['admin'] });
  await store.insert('ShapeItem', { _id: 'sh1', n: 5 });
  workflow.register({ name: 'shapeWf', steps: [
    { op: 'query', as: 'it', gql: 'ShapeItem{_id, n}' },
    { op: 'fail', when: { lt: '{{it.n}}', than: 0 }, message: 'neg' },
    { op: 'mutation', as: 'w', model: 'ShapeItem', data: { n: 1 } },
  ] });
  try {
    const runDoc = await store.runWorkflow('shapeWf', {});
    assert.deepEqual(Object.keys(runDoc).sort(),
      ['_id', 'createdAt', 'dryRun', 'error', 'input',
        'now', 'status', 'stepIndex', 'steps', 'updatedAt', 'workflow']);
    assert.equal(runDoc.status, 'succeeded');
    assert.equal(runDoc.error, null);
    assert.deepEqual(runDoc.steps.map((st) => st.state), ['ran', 'skipped', 'ran']);
    assert.deepEqual(Object.keys(runDoc.steps[0]).sort(), ['as', 'op', 'result', 'state']);
    assert.deepEqual(Object.keys(runDoc.steps[1]).sort(), ['as', 'op', 'state']);
  } finally {
    workflow._workflows.delete('shapeWf');
    db.close();
  }
});

// ─── B1：注册期 GQL 可规划性校验（结构 + 参数键完整） ─────────

test('B1：注册期可规划性——gql 不可规划拒绝', () => {
  const bad = { name: 'noModelWf', steps: [
    { op: 'query', as: 'a', gql: 'NoSuchModel{_id}', params: {} },
  ] };
  assert.deepEqual(workflow.validatePlanable(bad).length, 1);
  assert.throws(() => workflow.register(bad), /WORKFLOW_UNSUPPORTED: steps\[0\]: gql 不可规划/);
});

test('B1：注册期可规划性——缺参数键拒绝', () => {
  const bad = { name: 'missParamWf', steps: [
    { op: 'query', as: 'a', gql: 'Inventory($condition:@c0){_id}', params: {} },
  ] };
  assert.deepEqual(workflow.validatePlanable(bad),
    ['steps[0]: gql 引用了未提供的参数 @c0（params 须提供该键）']);
});

test('B1：注册期可规划性——合法通过', () => {
  assert.deepEqual(workflow.validatePlanable({
    name: 'okWf', steps: [
      { op: 'query', as: 'a', gql: 'Inventory($condition:@c0){_id, stock}',
        params: { c0: { stock: 1 } } },
    ],
  }), []);
});
