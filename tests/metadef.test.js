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
