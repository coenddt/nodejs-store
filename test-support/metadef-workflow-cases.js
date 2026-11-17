'use strict';

/**
 * metadef 用例的 workflow 定义持久化四例（D4-4 零语义拆分）。
 *
 * 自 tests/metadef.test.js 原样下沉：persist 同名同形幂等 / loadDefs 取各 name 最新
 * active / restoreDefs(kind=workflow) 幂等重建 / rollbackTo 追加式；用例名、断言与
 * 注释逐字未改。主文件在原位置（schema 用例之后、A3 之前）require 本模块，故 test
 * 注册顺序与原文件一致。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { store } = require('../src');
const md = require('../src/metadef');
const { runWf, wfDefn } = require('./metadef-helpers');

test('workflow：persist 同名同形幂等 + 异形 version+1 + list version desc', async () => {
  await runWf(async () => {
    const o = { tenant: 't6', env: 'dev', kind: 'workflow' };
    const w1 = wfDefn('WfPersist');
    const w2 = wfDefn('WfPersist', 'Item(){ _id title }');
    const r1 = await md.persistDef(store, w1, o);
    assert.equal(r1.version, 1);
    const again = await md.persistDef(store, w1, o);
    assert.equal(again.version, 1); // 同名同形 → 幂等不新增
    const r2 = await md.persistDef(store, w2, o);
    assert.equal(r2.version, 2); // 异形 → version+1

    const rows = await md.listDefs(store, { tenant: 't6', env: 'dev', name: 'WfPersist', kind: 'workflow' });
    assert.deepEqual(rows.map((r) => r.version), [2, 1]); // version desc
    assert.equal(rows[0]._id, md.defId('t6', 'dev', 'WfPersist', 2)); // 自然键
  });
});

test('workflow：loadDefs 取各 name 最新 active', async () => {
  await runWf(async () => {
    const o = { tenant: 't7', env: 'dev', kind: 'workflow' };
    await md.persistDef(store, wfDefn('WfLoad'), o);
    await md.persistDef(store, wfDefn('WfLoad', 'Item(){ _id title }'), o);
    await md.persistDef(store, { name: 'WfOther', steps: [{ op: 'fail', message: 'x' }] }, o);
    const rows = await md.loadDefs(store, o);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.version]));
    assert.deepEqual(byName, { WfLoad: 2, WfOther: 1 });
  });
});

test('workflow：restoreDefs(kind=workflow) 重建 workflow 注册表（幂等）', async () => {
  await runWf(async () => {
    const o = { tenant: 't8', env: 'dev' };
    await md.persistDef(store, wfDefn('WfRestore'), { ...o, kind: 'workflow' });
    assert.equal(store.workflows().includes('WfRestore'), false); // 落库未注册

    const out = await md.restoreDefs(store, { ...o, kind: 'workflow' });
    assert.equal(out.applied, 1);
    assert.equal(store.workflows().includes('WfRestore'), true); // 重建后可见

    const out2 = await md.restoreDefs(store, { ...o, kind: 'workflow' });
    assert.equal(out2.applied, 0); // 同版本幂等
  });
});

test('workflow：rollbackTo 追加式 → loadDefs 按历史 defn，本进程重注册', async () => {
  await runWf(async () => {
    const o = { tenant: 't10', env: 'dev', kind: 'workflow' };
    const v1 = wfDefn('WfRb');
    const v2 = wfDefn('WfRb', 'Item(){ _id title }');
    await md.persistDef(store, v1, o);
    await md.persistDef(store, v2, o);
    const rb = await md.rollbackTo(store, { tenant: 't10', env: 'dev', name: 'WfRb', version: 1, kind: 'workflow' });
    assert.equal(rb.version, 3); // 追加式：回滚 = 以 v1 defn 追加 v3
    assert.deepEqual(rb.defn, v1);
    const latest = await md.loadDefs(store, o);
    assert.equal(latest[0].version, 3);
    assert.deepEqual(latest[0].defn, v1);
    assert.equal(store.getWorkflow('WfRb').steps[0].gql, 'Item(){ _id }'); // 本进程重注册为 v1
  });
});
