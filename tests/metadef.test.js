'use strict';

/**
 * meta-store 定义持久化与版本化（Node 宿主侧）：D1 发布闭环桥 + D2 版本唯一性。
 *
 * - D2：persist 落行带自然键 `_id`=(tenant,env,name,version)；同版本二次写入 →
 *   存储层唯一键冲突（SQLite UNIQUE）显式上抛，不产重复 version。
 * - D1：persist 只落库、不注册；`restoreDefs` 从 `__schemaDef` 重建注册表（同版本幂等），
 *   网关 reload 即据此让协议面看到新定义。
 *
 * 与本仓其它端到端用例同规：走 store 统一入口 + 内存 SQLite（无需外部服务）。
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, ddl } = require('../src');
const md = require('../src/metadef');

const _US = '\u001f';

/** 建内存库 + 建内建 `__schemaDef` 表 → init → 执行 body（每个用例独立库） */
async function run(body) {
  const db = new Database(':memory:');
  db.exec(String(ddl.generate('sqlite', ['__schemaDef'])));
  await init({ default: executors.createConnection('sqlite', db) });
  try {
    return await body();
  } finally {
    db.close();
  }
}

/** 建内存库 + 建内建 `__workflowDef` 表 → init → 执行 body（workflow 定义用） */
async function runWf(body) {
  const db = new Database(':memory:');
  db.exec(String(ddl.generate('sqlite', ['__workflowDef'])));
  await init({ default: executors.createConnection('sqlite', db) });
  // B1 前置：wfDefn 默认 gql `Item(){ _id }` 引用 Item，注册期可规划性校验要求其已注册。
  store.register({
    name: 'Item', collection: 'items', idPrefix: 'it',
    fields: { _id: { type: 'string' }, title: { type: 'string' } },
  });
  try {
    return await body();
  } finally {
    db.close();
  }
}

/** 最小合法 workflow defn（注册期白名单通过；gql 内容不参与注册期校验） */
function wfDefn(name, gql = 'Item(){ _id }') {
  return { name, steps: [{ op: 'query', as: 'a', gql }] };
}

test('defId：自然键 (tenant,env,name,version)（对齐 py def_id）', () => {
  assert.equal(md.defId('t1', 'dev', 'Item', 2), `t1${_US}dev${_US}Item${_US}2`);
  assert.equal(md.defId(null, null, 'Item', 1), `${_US}${_US}Item${_US}1`);
});

test('D2：版本唯一性由行自然键 _id 在存储层保证', async () => {
  await run(async () => {
    const defn = { name: 'UniqItem', fields: { _id: { type: 'string' } } };
    const r1 = await md.persistDef(store, defn, { tenant: 't2', env: 'dev' });
    assert.equal(r1._id, md.defId('t2', 'dev', 'UniqItem', 1));
    assert.equal(r1.version, 1);

    // 并发写同版本的最小复现：绕过「读最新行 +1」直插同版本行 → 唯一键冲突
    const dup = md.buildDefRow(defn, { tenant: 't2', env: 'dev' }, 1);
    dup._id = md.defId('t2', 'dev', 'UniqItem', 1);
    await assert.rejects(
      () => md._runInternal(() => store.insert('__schemaDef', dup)),
      (e) => /unique/i.test(String(e && e.message)),
    );
  });
});

test('D1：restoreDefs 从持久化定义重建注册表（同版本幂等）', async () => {
  await run(async () => {
    const defn = { name: 'RestoredItem', fields: { _id: { type: 'string' }, title: { type: 'string' } } };
    await md.persistDef(store, defn, { tenant: 't3', env: 'dev' });
    assert.equal(store.has('RestoredItem'), false); // 原缺口：落库后协议面不可见

    const out = await md.restoreDefs(store, { tenant: 't3', env: 'dev' });
    assert.equal(out.applied, 1);
    assert.equal(store.has('RestoredItem'), true); // 重建后即可见

    const out2 = await md.restoreDefs(store, { tenant: 't3', env: 'dev' });
    assert.equal(out2.applied, 0); // 同版本幂等：不重复注册
  });
});

test('D1：版本变化时 restoreDefs 以新 defn 覆盖注册', async () => {
  await run(async () => {
    const v1 = { name: 'EvolvingItem', fields: { _id: { type: 'string' }, title: { type: 'string' } } };
    const v2 = {
      name: 'EvolvingItem',
      fields: { _id: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } },
    };
    await md.persistDef(store, v1, { tenant: 't4', env: 'dev' });
    const out1 = await md.restoreDefs(store, { tenant: 't4', env: 'dev' });
    assert.equal(out1.applied, 1);
    assert.deepEqual(Object.keys(store.get('EvolvingItem').fields).sort(), ['_id', 'title']);

    // 版本变化 → 同名覆盖重注册（core.order 出现重复项；host list() 必去重）
    await md.persistDef(store, v2, { tenant: 't4', env: 'dev' });
    const out2 = await md.restoreDefs(store, { tenant: 't4', env: 'dev' });
    assert.equal(out2.total, 1);
    assert.equal(out2.applied, 1);
    assert.deepEqual(Object.keys(store.get('EvolvingItem').fields).sort(), ['_id', 'price', 'title']);

    const names = store.list();
    assert.equal(new Set(names).size, names.length); // 去重：不出现重复名（否则协议皮路由重复）
  });
});

test('D21：rollback 以历史 defn 追加新版本 → restoreDefs 按历史 defn 装配（跨进程闭环）', async () => {
  await run(async () => {
    const v1 = { name: 'RbItem', fields: { _id: { type: 'string' }, title: { type: 'string' } } };
    const v2 = {
      name: 'RbItem',
      fields: { _id: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } },
    };
    const o = { tenant: 't5', env: 'dev' };
    await md.persistDef(store, v1, o);
    await md.restoreDefs(store, o); // 网关首次 hydrate → v1
    await md.persistDef(store, v2, o);
    await md.restoreDefs(store, o); // 网关再次 hydrate → v2
    assert.equal('price' in store.get('RbItem').fields, true);

    // 控制面回滚到 v1 → 追加式落新版本行
    const rb = await md.rollbackTo(store, { tenant: 't5', env: 'dev', name: 'RbItem', version: 1 });
    assert.equal(rb.version, 3); // 追加式：回滚 = 以 v1 defn 追加 v3
    assert.deepEqual(rb.defn, v1);

    // 网关新一次 reload：loadDefs 返回回滚后的最新行（defn=v1），新自然键 → applied
    const latest = await md.loadDefs(store, o);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].version, 3);
    assert.deepEqual(latest[0].defn, v1);
    const out = await md.restoreDefs(store, o);
    assert.equal(out.applied, 1);
    assert.equal('price' in store.get('RbItem').fields, false); // 协议面按历史 defn 装配
  });
});

// ─── N3：回调类定义不可持久化（持久化定义 = 纯 JSON）─────────────

test('N3：含函数回调的 defn 经 persistDef 显式拒绝且库内零新增行', async () => {
  await run(async () => {
    const o = { tenant: 't12', env: 'dev' };
    const defn = { name: 'CbItem', fields: { _id: { type: 'string' } }, computes: { total: { fn: () => 1 } } };
    await assert.rejects(() => md.persistDef(store, defn, o), /不可持久化/);
    const rows = await md.listDefs(store, { ...o, name: 'CbItem' });
    assert.equal(rows.length, 0); // 拒绝先于 IO：库内零新增行
  });
});

test('N3：纯 JSON defn（fnRef 字符串）正常落库且与入参同形', async () => {
  await run(async () => {
    const o = { tenant: 't12', env: 'dev' };
    const defn = {
      name: 'CbPure',
      fields: { _id: { type: 'string' } },
      computes: { total: { fnRef: 'sum', type: 'int' } },
    };
    const row = await md.persistDef(store, defn, o);
    assert.equal(row.version, 1);
    assert.equal(md.sameDefn(row.defn, defn), true); // 落库 defn 与入参同形
  });
});

// ─── workflow 定义持久化（kind=workflow，落 __workflowDef；审计 §8 N1）───────

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

test('A3：宿主 restoreDefs 同时重建 schema 与 workflow 两类', async () => {
  const db = new Database(':memory:');
  db.exec(String(ddl.generate('sqlite', ['__schemaDef', '__workflowDef'])));
  await init({ default: executors.createConnection('sqlite', db) });
  try {
    // B1 前置：HostWf 的 gql `Item(){ _id }` 引用 Item，注册期可规划性校验要求其已注册。
    store.register({
      name: 'Item', collection: 'items', idPrefix: 'it',
      fields: { _id: { type: 'string' }, title: { type: 'string' } },
    });
    const o = { tenant: 't9', env: 'dev' };
    await store.persistDef({ name: 'HostItem', fields: { _id: { type: 'string' } } }, o);
    await store.persistWorkflowDef(wfDefn('HostWf'), o);
    assert.equal(store.has('HostItem'), false);
    assert.equal(store.workflows().includes('HostWf'), false);

    const out = await store.restoreDefs(o);
    assert.equal(out.applied, 2); // 一次调用重建两类
    assert.equal(store.has('HostItem'), true);
    assert.equal(store.workflows().includes('HostWf'), true);
  } finally {
    db.close();
  }
});

test('workflow：Closed 门禁下 restoreDefs 仍走 internal 重建', async () => {
  await runWf(async () => {
    const o = { tenant: 't11', env: 'dev', kind: 'workflow' };
    await md.persistDef(store, wfDefn('WfRestoreGate'), o);

    store.setMetaPolicy(true, []);
    try {
      const out = await md.restoreDefs(store, { ...o });
      assert.equal(out.applied, 1);
      assert.equal(store.workflows().includes('WfRestoreGate'), true); // Closed 下仍重建（internal）
    } finally {
      store.setMetaPolicy(false, []);
      require('../src/workflow')._workflows.delete('WfRestoreGate');
    }
  });
});

test('workflow：Closed 门禁下 rollbackTo 仍走 internal 重建', async () => {
  await runWf(async () => {
    const o = { tenant: 't11', env: 'dev', kind: 'workflow' };
    await md.persistDef(store, wfDefn('WfRbGate'), o);
    await md.persistDef(store, wfDefn('WfRbGate', 'Item(){ _id title }'), o);

    store.setMetaPolicy(true, []);
    try {
      const rb = await md.rollbackTo(store, { tenant: 't11', env: 'dev', name: 'WfRbGate', version: 1, kind: 'workflow' });
      assert.equal(rb.version, 3); // 追加式
      assert.equal(store.getWorkflow('WfRbGate').steps[0].gql, 'Item(){ _id }'); // Closed 下仍重建（internal）
    } finally {
      store.setMetaPolicy(false, []);
      require('../src/workflow')._workflows.delete('WfRbGate');
    }
  });
});
