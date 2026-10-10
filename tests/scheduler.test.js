'use strict';

/**
 * 宿主定时任务插件 e2e（04；覆盖总纲 A6 + 禁静默失守）
 *
 * 全程只走 store 统一入口：register(triggers.schedule) → tickOnce →
 * core expandScheduleTriggers 枚举 → cron 匹配 → 复用触发链执行器。
 * 真库 = better-sqlite3 内存库。cron 对拍数据 = rust-store/fixtures/triggers/cases.json
 * 的 cronCases（与 py-store/tests/test_scheduler.py 两端共用）。
 *
 * 运行：LOCAL_CORE=1 node --test tests/scheduler.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const { init, store, executors, schema: _sc } = require('../src');
const scheduler = require('../src/scheduler');

const SRC = 'sch_a';
// cron 对拍 fixture 的单一事实源在 rust-store 仓（与 py-store/tests/test_scheduler.py 共用）：
// 本地开发 = 与 nodejs-store 平级的 common-store 布局（`../rust-store`）；
// CI = checkout coenddt/rust-store 到 workspace 内（`<repo>/rust-store`，见 .github/workflows/ci.yml）。
const FX = [path.resolve(__dirname, '../../rust-store'), path.resolve(__dirname, '../rust-store')]
  .map((root) => path.join(root, 'fixtures/triggers/cases.json'))
  .find((p) => fs.existsSync(p));
if (!FX) {
  throw new Error(
    '未找到 rust-store/fixtures/triggers/cases.json（本地需与 rust-store 平级；CI 需 checkout rust-store）'
  );
}
const cronCases = JSON.parse(fs.readFileSync(FX, 'utf8')).cronCases;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE t_s_log (_id TEXT PRIMARY KEY, kind TEXT, __present TEXT);
    CREATE TABLE t_s_log_deleted (_id TEXT PRIMARY KEY, kind TEXT, deleted_at INTEGER, __present TEXT);
    CREATE TABLE t_s_boom (_id TEXT PRIMARY KEY, __present TEXT);
    CREATE TABLE t_s_boom_deleted (_id TEXT PRIMARY KEY, deleted_at INTEGER, __present TEXT);
  `);
  return db;
}

// ─── schema 注册（_register 约定不适用于 node:test；模块级即注册） ─

_sc.register({
  name: 'SOrder', collection: 'sOrder', idPrefix: 'so_', timestamps: false, datasource: SRC,
  fields: { amount: { type: 'number' } },
  triggers: {
    schedule: [
      // A6：* * * * * 必到点（回调式 + {{now}} 占位符）
      { name: 'sch_cb', cron: '* * * * *', fnRef: 'schRecorder', args: { at: '{{now}}' } },
      // 02:00 到点（tickOnce 注入 12:34 时不命中）
      { name: 'sch_cb2', cron: '0 2 * * *', fnRef: 'schRecorder', args: { at: '{{now}}' } },
      // 命令式：到点执行 step 命令落库
      { name: 'sch_cmd', cron: '* * * * *', into: 'SLog', op: 'insert',
        data: { _id: '{{now}}', kind: 'sch' } },
    ],
  },
});

_sc.register({
  name: 'SLog', collection: 'tSLog', idPrefix: 'sl_', timestamps: false, datasource: SRC,
  fields: { kind: { type: 'string' } },
});

_sc.register({
  name: 'SBoom', collection: 'tSBoom', idPrefix: 'sb_', timestamps: false, datasource: SRC,
  fields: {},
  // schedule step 执行失败 → tickOnce 上抛（禁静默跳过）；
  // cron 锁 12-31 23:59，只在失败用例的注入时刻命中（不污染其他用例）
  triggers: { schedule: [{ name: 'sch_boom', cron: '59 23 31 12 *', fnRef: 'schBoom' }] },
});

// ─── 回调实现注入 ─────────────────────────────────────────────

let cbCalls = [];
store.setTriggerFn('schRecorder', async (args) => {
  cbCalls.push(args);
});
store.setTriggerFn('schBoom', async () => { throw new Error('boom-err'); });

// ─── 环境复位 ────────────────────────────────────────────────

let dbA = null;

beforeEach(async () => {
  cbCalls = [];
  dbA = createDb();
  await init({ [SRC]: executors.createConnection('sqlite', dbA) });
});

// ─── cron 匹配器 ─────────────────────────────────────────────

test('cron 匹配器：fixture cronCases 逐组断言（分量构造，时区无关）', () => {
  for (const c of cronCases) {
    const a = c.at;
    const d = new Date(a.y, a.mo - 1, a.d, a.h, a.mi);
    assert.equal(scheduler.cronMatches(c.cron, d), c.expect,
      `${c.cron} @ ${JSON.stringify(a)}`);
  }
});

test('cron 非法表达式显式报错（ERR_CRON）', () => {
  const d = new Date();
  assert.throws(() => scheduler.cronMatches('* * * *', d), /ERR_CRON/);       // 段数
  assert.throws(() => scheduler.cronMatches('a * * * *', d), /ERR_CRON/);     // 非法字符
  assert.throws(() => scheduler.cronMatches('99 * * * *', d), /ERR_CRON/);    // 超出范围
  assert.throws(() => scheduler.cronMatches('0 0 * * 8', d), /ERR_CRON/);     // 周越界
  assert.throws(() => scheduler.cronMatches('5-1 * * * *', d), /ERR_CRON/);   // 范围倒置
});

// ─── A6：tickOnce 触发执行链 ─────────────────────────────────

test('A6 tickOnce：* * * * * 到点触发执行链（回调 + 命令式落库；未到点不触发）', async () => {
  const now = new Date(2026, 0, 1, 12, 34).getTime();
  const fired = await scheduler.tickOnce(now);
  // sch_cb2（0 2 * * *）在 12:34 不命中 → 未到点不触发
  assert.deepEqual(fired.map((f) => f.name).sort(),
    ['SOrder.schedule.sch_cb', 'SOrder.schedule.sch_cmd']);
  assert.equal(cbCalls.length, 1, '回调执行一次');
  assert.equal(cbCalls[0].at, now, '{{now}} 整值替换为毫秒时刻');
  assert.equal(dbA.prepare("SELECT COUNT(*) AS n FROM t_s_log WHERE kind = 'sch'").get().n, 1,
    '命令式 step 已落库');
});

test('A6 tickOnce：连续两轮各独立执行（去重集合按次独立，无跨轮状态）', async () => {
  await scheduler.tickOnce(new Date(2026, 0, 1, 12, 34).getTime());
  const fired = await scheduler.tickOnce(new Date(2026, 0, 1, 12, 35).getTime());
  assert.deepEqual(fired.map((f) => f.name).sort(),
    ['SOrder.schedule.sch_cb', 'SOrder.schedule.sch_cmd'], '第二轮照常触发');
  assert.equal(cbCalls.length, 2, '每轮各执行一次（错过即跳过、无补跑判定）');
});

test('tickOnce：到点集合随时刻变化（02:00 时 0 2 * * * 亦命中）', async () => {
  const fired = await scheduler.tickOnce(new Date(2026, 0, 1, 2, 0).getTime());
  assert.deepEqual(fired.map((f) => f.name).sort(),
    ['SOrder.schedule.sch_cb', 'SOrder.schedule.sch_cb2', 'SOrder.schedule.sch_cmd']);
});

test('tickOnce：schedule step 执行失败上抛（禁静默跳过）', async () => {
  await assert.rejects(
    () => scheduler.tickOnce(new Date(2026, 11, 31, 23, 59).getTime()),
    /boom-err/,
  );
});

// ─── 启动期校验覆盖 schedule ─────────────────────────────────

test('assertTriggerFnsCovered 覆盖 schedule 的 fnRef（缺实现显式报错）', () => {
  assert.throws(
    () => store.assertTriggerFnsCovered([{
      name: 'X', triggers: { schedule: [{ name: 's', cron: '* * * * *', fnRef: 'noSuchFn' }] },
    }]),
    /ERR_TRIGGER_FN_MISSING/,
  );
  // 已注入的 fnRef 不误报
  store.assertTriggerFnsCovered([{
    name: 'Y', triggers: { schedule: [{ name: 's', cron: '* * * * *', fnRef: 'schRecorder' }] },
  }]);
});

// ─── 循环控制 ────────────────────────────────────────────────

test('start/stop 幂等', () => {
  scheduler.start();
  scheduler.start();
  scheduler.stop();
  scheduler.stop();
});
