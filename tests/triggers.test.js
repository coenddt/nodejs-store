'use strict';

/**
 * Schema 触发器真库 e2e（02 步骤 5；覆盖总纲 A3/A4/A5/A6/A8/A9 + 回调式触发）
 *
 * 全程只走 store 统一入口：register(triggers) → insert/update → core 规划
 * （plan 附 triggers）→ Host 触发链执行器（占位符/命中判定/去重）→ runAtomic
 * 单源真事务 / 跨源 non_atomic_write 声明。真库 = better-sqlite3 内存库。
 *
 * 运行：LOCAL_CORE=1 node --test tests/triggers.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { init, store, executors, permission, feedback, schema: _sc, NonAtomicWriteError } = require('../src');
const { ProfileViolation } = require('../src/crud/exec');

const SRC_A = 'trg_a';
const SRC_B = 'trg_b';

/** 测试用物理表（标量范式；触发目标表 tAudit 供命令式触发写） */
function createDb() {
  const db = new Database(':memory:');
  // 表名 = SQL 方言物理名（snake_case；_id/__present 保留）
  db.exec(`
    CREATE TABLE t_order (_id TEXT PRIMARY KEY, amount REAL, status TEXT, note TEXT, __present TEXT);
    CREATE TABLE t_order_deleted (_id TEXT PRIMARY KEY, amount REAL, status TEXT, note TEXT, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_audit (_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, amount REAL, __present TEXT);
    CREATE TABLE t_audit_deleted (_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, amount REAL, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_boom (_id TEXT PRIMARY KEY, __present TEXT);
    CREATE TABLE t_boom_deleted (_id TEXT PRIMARY KEY, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_ghost (_id TEXT PRIMARY KEY, __present TEXT);
    CREATE TABLE t_ghost_deleted (_id TEXT PRIMARY KEY, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_cmd_fail (_id TEXT PRIMARY KEY, amount REAL, __present TEXT);
    CREATE TABLE t_cmd_fail_deleted (_id TEXT PRIMARY KEY, amount REAL, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_x_order (_id TEXT PRIMARY KEY, amount REAL, __present TEXT);
    CREATE TABLE t_x_order_deleted (_id TEXT PRIMARY KEY, amount REAL, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_x_audit (_id TEXT PRIMARY KEY, ref TEXT, __present TEXT);
    CREATE TABLE t_x_audit_deleted (_id TEXT PRIMARY KEY, ref TEXT, deleted_at INTEGER, __present TEXT);
  `);
  return db;
}

// ─── schema 注册（模块级；triggers 契约见总纲 T 字段表） ────────

_sc.register({
  name: 'TOrder', collection: 'tOrder', idPrefix: 'o_', timestamps: false, datasource: SRC_A,
  fields: { amount: { type: 'number' }, status: { type: 'string' }, note: { type: 'string' } },
  triggers: {
    insert: [
      // A8：aud_cmd 与 aud_dup 同名 —— 同事务 (name, _id) 去重，只执行一次
      // （若不去重，第二次同 _id insertOne 主键冲突 → 整体失败）
      { name: 'aud_cmd', into: 'TAudit', op: 'insert',
        data: { _id: '{{root._id}}', kind: 'cmd', ref: '{{root._id}}', amount: '{{root.amount}}' } },
      { name: 'aud_cmd', into: 'TAudit', op: 'insert',
        data: { _id: '{{root._id}}', kind: 'cmd', ref: '{{root._id}}', amount: '{{root.amount}}' } },
      { name: 'aud_cb', fnRef: 'audRecorder', args: { ref: '{{root._id}}' } },
    ],
    update: [
      { name: 'aud_upd', onFields: ['amount'], into: 'TAudit', op: 'insert',
        data: { _id: '{{now}}', kind: 'upd', ref: '{{root._id}}', amount: '{{root.amount}}' } },
    ],
  },
});

_sc.register({
  name: 'TAudit', collection: 'tAudit', idPrefix: 'a_', timestamps: false, datasource: SRC_A,
  fields: { kind: { type: 'string' }, ref: { type: 'string' }, amount: { type: 'number' } },
});

_sc.register({
  name: 'TBoom', collection: 'tBoom', idPrefix: 'b_', timestamps: false, datasource: SRC_A,
  fields: {},
  triggers: { insert: [{ name: 'boom', fnRef: 'boom' }] },
});

_sc.register({
  name: 'TGhost', collection: 'tGhost', idPrefix: 'g_', timestamps: false, datasource: SRC_A,
  fields: {},
  triggers: { insert: [{ name: 'ghost', fnRef: 'ghost' }] },
});

_sc.register({
  name: 'TCmdFail', collection: 'tCmdFail', idPrefix: 'cf_', timestamps: false, datasource: SRC_A,
  fields: { amount: { type: 'number' } },
  // A5：命令式触发写失败（data._id 固定字面量，与预置行冲突）
  triggers: {
    insert: [{ name: 'cf_aud', into: 'TAudit', op: 'insert',
      data: { _id: 'fixed-collision', kind: 'cf', ref: '{{root._id}}' } }],
  },
});

_sc.register({
  name: 'TXOrder', collection: 'tXOrder', idPrefix: 'x_', timestamps: false, datasource: SRC_A,
  fields: { amount: { type: 'number' } },
  // A6：跨源触发链（目标在 SRC_B）
  triggers: {
    insert: [{ name: 'x_aud', into: 'TXAudit', op: 'insert',
      data: { _id: '{{root._id}}', ref: '{{root._id}}' } }],
  },
});

_sc.register({
  name: 'TXAudit', collection: 'tXAudit', idPrefix: 'xa_', timestamps: false, datasource: SRC_B,
  fields: { ref: { type: 'string' } },
});

// ─── 回调实现注入（启动期一次；运行期计数在用例内自管） ─────────

let cbCalls = [];
store.setTriggerFn('audRecorder', async (args, ctx, { store: s }) => {
  cbCalls.push(args);
  await s.insert('TAudit', { kind: 'cb', ref: args.ref, amount: 0 });
});
store.setTriggerFn('boom', async () => { throw new Error('boom-err'); });

// ─── 环境复位 ────────────────────────────────────────────────

let events = [];
let dbA = null;
let dbB = null;

beforeEach(async () => {
  events = [];
  cbCalls = [];
  feedback.setSink((e) => events.push(e));
  permission.setContext(undefined);
  store.setProfile('standard');
  dbA = createDb();
  dbB = createDb();
  await init({
    [SRC_A]: executors.createConnection('sqlite', dbA),
    [SRC_B]: executors.createConnection('sqlite', dbB),
  });
});

// ─── 用例 ────────────────────────────────────────────────────

test('A2/A3 insert 触发链：命令式 + 回调式依序执行，占位符整值替换', async () => {
  const doc = await store.insert('TOrder', { amount: 100, status: 'new', note: '' });
  const rows = dbA.prepare('SELECT _id, kind, ref, amount FROM t_audit ORDER BY kind').all();
  // aud_cmd（与 aud_dup 去重后一次）+ aud_cb
  assert.deepEqual(rows.map((r) => r.kind), ['cb', 'cmd']);
  const cmd = rows.find((r) => r.kind === 'cmd');
  assert.equal(cmd._id, doc._id, '{{root._id}} 整值替换');
  assert.equal(cmd.ref, doc._id);
  assert.equal(cmd.amount, 100, '{{root.amount}} 整值替换');
  assert.equal(cbCalls.length, 1, '回调执行一次');
  assert.equal(cbCalls[0].ref, doc._id, '回调 args 占位符替换');
});

test('A3/A4 update onFields 命中才触发；未命中（值未变/字段不在 onFields）不触发', async () => {
  const doc = await store.insert('TOrder', { amount: 100, status: 'new', note: '' });
  const updCount = () => dbA.prepare("SELECT COUNT(*) AS n FROM t_audit WHERE kind = 'upd'").get().n;

  // 未命中：字段不在 onFields
  await store.update('TOrder', { _id: doc._id }, { note: 'x' });
  assert.equal(updCount(), 0, 'onFields 外的字段变化不触发');

  // 未命中：值未变（no-op 抑制）
  await store.update('TOrder', { _id: doc._id }, { amount: 100 });
  assert.equal(updCount(), 0, 'onFields 字段值未变不触发');

  // 命中：amount 真变
  const updated = await store.update('TOrder', { _id: doc._id }, { amount: 200 });
  assert.equal(updated.amount, 200);
  const rows = dbA.prepare("SELECT ref, amount FROM t_audit WHERE kind = 'upd'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, doc._id, '{{root._id}}');
  assert.equal(rows[0].amount, 200, '{{root.amount}} = 主写后的新值');
});

test('A5 单源回滚：触发回调失败 → 主写整体回滚', async () => {
  await assert.rejects(() => store.insert('TBoom', {}), /boom-err/);
  assert.equal(dbA.prepare('SELECT COUNT(*) AS n FROM t_boom').get().n, 0, '主写已回滚');
});

test('A5 单源回滚：命令式触发写失败 → 主写整体回滚', async () => {
  // 预置同 _id 审计行 → 触发 insertOne 主键冲突 → 触发链失败 → 主写回滚
  dbA.prepare("INSERT INTO t_audit (_id, kind, ref, amount) VALUES ('fixed-collision', 'seed', '', 0)").run();
  await assert.rejects(() => store.insert('TCmdFail', { amount: 1 }), /UNIQUE constraint failed/);
  assert.equal(dbA.prepare('SELECT COUNT(*) AS n FROM t_cmd_fail').get().n, 0, '主写已回滚');
});

test('A6 跨源触发链：发 non_atomic_write（含涉及源）并顺序执行落库', async () => {
  const doc = await store.insert('TXOrder', { amount: 1 });
  const listed = events.filter((e) => e.type === 'non_atomic_write');
  assert.equal(listed.length, 1, '恰发一次 non_atomic_write 声明');
  assert.deepEqual(listed[0].sources, [SRC_A, SRC_B].sort(), '声明含全部涉及源');
  assert.equal(dbB.prepare('SELECT COUNT(*) AS n FROM t_x_audit WHERE ref = ?').get(doc._id).n, 1,
    '跨源触发写已落库（顺序执行，非原子）');
});

test('A6 会话内跨源触发 fail-closed：NonAtomicWriteError 且全部回滚', async () => {
  await assert.rejects(
    () => store.session(async (s) => {
      await s.insert('TXOrder', { amount: 1 });
    }),
    NonAtomicWriteError,
  );
  assert.equal(dbA.prepare('SELECT COUNT(*) AS n FROM t_x_order').get().n, 0, '主写已回滚');
  assert.equal(dbB.prepare('SELECT COUNT(*) AS n FROM t_x_audit').get().n, 0, '触发写已回滚');
});

test('A8 同事务去重：同名触发只执行一次（若不去重将主键冲突整体失败）', async () => {
  const doc = await store.insert('TOrder', { amount: 7, status: 'new', note: '' });
  const cmd = dbA.prepare("SELECT COUNT(*) AS n FROM t_audit WHERE kind = 'cmd' AND _id = ?")
    .get(doc._id).n;
  assert.equal(cmd, 1, '同名 (aud_cmd) 触发去重后只执行一次');
});

test('A9 text2query 档：触发器显式拒绝（ProfileViolation + profile_blocked 反馈）', async () => {
  store.setProfile('text2query');
  await assert.rejects(() => store.insert('TOrder', { amount: 1, status: 'new', note: '' }),
    ProfileViolation);
  const blocked = events.filter((e) => e.type === 'profile_blocked');
  assert.equal(blocked.length, 1, '发 profile_blocked 反馈事件');
});

test('回调缺实现：启动期 assertTriggerFnsCovered 与运行期均显式报 ERR_TRIGGER_FN_MISSING', async () => {
  assert.throws(
    () => store.assertTriggerFnsCovered([{ name: 'X', triggers: { insert: [{ fnRef: 'ghost' }] } }]),
    /ERR_TRIGGER_FN_MISSING/,
  );
  await assert.rejects(() => store.insert('TGhost', {}), /ERR_TRIGGER_FN_MISSING/);
});

test('占位符内嵌拼接：显式报 ERR_TRIGGER_PLACEHOLDER（禁静默漂移）', () => {
  const { resolveTriggerPlaceholders } = require('../src/crud/triggers');
  assert.throws(
    () => resolveTriggerPlaceholders('order-{{root._id}}', { root: { _id: 'x' }, before: null, now: 1 }),
    /ERR_TRIGGER_PLACEHOLDER/,
  );
  assert.throws(
    () => resolveTriggerPlaceholders('a{{now}}b', { root: {}, before: null, now: 1 }),
    /ERR_TRIGGER_PLACEHOLDER/,
  );
  // 引用缺失字段 = 整值替换语义（取值缺失 → undefined），不抛
  assert.equal(
    resolveTriggerPlaceholders('{{root.missing}}', { root: {}, before: null, now: 1 }),
    undefined,
  );
});
