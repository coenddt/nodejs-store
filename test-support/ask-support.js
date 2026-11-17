'use strict';

/**
 * ask / llm 工厂 / conformance 测试的共用支撑（D4-4 零语义拆分）。
 *
 * 自 tests/ask.test.js 原样下沉：假 LLM 脚本化桩、SQLite 内存库与 exec spy、
 * 双端基线常量、环境 bootstrap（旧 before 体）、每用例复位与断言骨架、
 * 场景 schema 注册。用例文件只保留用例块，断言与用例名逐字未改。
 *
 * 放在 tests/ 之外的原因：scripts/test.js 以 node --test 递归收集 tests 下所有 js，
 * 该集合里任何无 test() 的文件都会被计为一个文件级 pass —— 共用支撑不得进入。
 */

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  init, store, executors, permission, feedback, schema: _sc,
  text2query, AskExhausted, llm: llmReg,
} = require('../src');
const askMod = require('../src/ask');
const crudMod = require('../src/crud');
const { LlmError } = require('../src/llm');
const { _guardRouteOverride } = require('../src/crud/query');

const SRC = 'ak_src';

// ── 假 LLM（脚本化；记录每轮 messages，断言回喂与护栏零暴露） ──

function fakeLlm(...outputs) {
  const fn = async (messages) => {
    fn.calls.push(JSON.parse(JSON.stringify(messages)));
    if (!fn.outputs.length) {
      // Node 的 AssertionError 运行期支持字符串消息；@types/node 的构造签名只声明 options 对象
      throw new (/** @type {any} */ (assert.AssertionError))('假 LLM 输出脚本耗尽（出现了意外的额外轮次）');
    }
    return fn.outputs.shift();
  };
  fn.outputs = [...outputs];
  fn.calls = [];
  return fn;
}

function _out(gql, params) {
  return JSON.stringify({ gql, params });
}

// ── 最小 SQLite 内存库（真实驱动；exec spy 记录 SQL 文本供方言取证） ──

let _db = null;
let _sqlLog = [];

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ak_users (_id TEXT PRIMARY KEY, name TEXT, role TEXT, __present TEXT);
    CREATE TABLE ak_orders (_id TEXT PRIMARY KEY, code TEXT, amount REAL, __present TEXT);
  `);
  return db;
}

/** 最后一条读语句的 SQL 文本 + 绑定参数（LIMIT 值参数化，断言需取 params） */
function _lastReadSql() {
  return _sqlLog[_sqlLog.length - 1];
}
function seedOrders() {
  _db.prepare('INSERT INTO ak_orders (_id, code, amount, __present) VALUES (?, ?, ?, NULL)')
    .run('ako1', 'A1', 9.9);
}

function seedUsers() {
  _db.prepare('INSERT INTO ak_users (_id, name, role, __present) VALUES (?, ?, ?, NULL)')
    .run('aku1', 'bob', 'admin');
}

// 双端一致基线（与 py 侧 test_ask.py 逐字节相同的 GQL/params 字面量）
const CTX_USER = { userId: 'u1', roles: ['user'] };
const CTX_GUEST = { userId: 'g1', roles: ['guest'] };
const CTX_ADMIN = { userId: 'a1', roles: ['admin'] };
const _GOOD = ['AkOrder($condition:@c0){_id, code}', { c0: {} }];
const _PROJ_DOCS = [{ _id: 'ako1', code: 'A1' }];

/** 旧 tests/ask.test.js 顶层 before 的逐字体（连接 + exec spy + init + 复位上下文） */
async function bootstrap() {
  _db = createDb();
  const conn = executors.createConnection('sqlite', _db);
  const origExec = conn.exec;
  conn.exec = (plan) => {
    for (const stmt of plan.stmts || []) {
      _sqlLog.push({ text: stmt.text, params: (stmt.params || []).slice() });
    }
    return origExec(plan);
  };
  await init({ [SRC]: conn });
  permission.setContext(undefined);
}

/** 每用例复位（档位/上下文/反馈 sink 为进程级全局，防用例间串扰） */
function _reset() {
  _sc.setProfile('standard');
  permission.setContext(undefined);
  feedback.setSink(null);
  _sqlLog = [];
  _db.exec('DELETE FROM ak_orders; DELETE FROM ak_users;');
}

/** 断言首轮 attempt 被 U2 档位拦截（profileBlocked / core），返回首轮错误供细分断言 */
function assertFirstBlocked(res) {
  const err = res.attempts[0].error;
  assert.equal(err.code, 'profileBlocked');
  assert.equal(err.layer, 'core');
  return err;
}

/** client 首调拒绝 + 差异化断言骨架（HTTP 错误用例共用；check 原样透传，断言异常自然上抛） */
async function assertClientRejects(llmReg, BASE, check) {
  const client = llmReg.makeOpenaiCompat(BASE);
  await assert.rejects(
    () => client([{ role: 'user', content: '输出 json' }]),
    (e) => check(e),
  );
}

// ── 场景 schema（前缀 Ak；关系链深度 4 供 T3；与 py 侧 test_ask.py 同构） ──

function _registerAkSchemas() {
  _sc.register({
    name: 'AkUser', collection: 'ak_users', idPrefix: 'aku', timestamps: true, datasource: SRC,
    // 显式列出 user/guest（core 已统一 read:[] = 显式不允许，不再按「未配置」处理），
    // 但 role 字段仍 admin 专属 → T8 验证列级过滤
    read: ['user', 'guest'],
    fields: {
      _id: 'string',
      name: 'string',
      role: { type: 'string', read: ['admin'] },
      profile: { type: 'object', fields: { city: 'string' } },
    },
    relations: {
      posts: { model: 'AkPost', type: 'many', localField: '_id', foreignField: 'userId' },
    },
    computes: {
      // read 白名单计算列：core-node 未导出 readableComputes 判决 → 摘要收窄 + 告警
      displayName: { type: 'string', read: ['admin'], fn: (item) => item.name },
      upperName: { type: 'string', fn: (item) => String(item.name || '').toUpperCase() },
    },
  });
  _sc.register({
    name: 'AkOrder', collection: 'ak_orders', idPrefix: 'ako', timestamps: true, datasource: SRC,
    // 本用例组只验问数编排，不验 schema 级读限制：未配置（null = 缺省 Open）；
    // 不得写 read:[]（core 语义为「显式不允许」）
    read: null,
    fields: { _id: 'string', code: 'string', amount: 'float' },
    relations: { items: { model: 'AkOrderItem', type: 'many',
      localField: '_id', foreignField: 'orderId' } },
    computes: { itemCount: { type: 'int', agg: { $count: 'items' } } },
  });
  _sc.register({
    name: 'AkOrderItem', collection: 'ak_order_items', idPrefix: 'aki',
    timestamps: false, read: null, datasource: SRC,
    fields: { _id: 'string', sku: 'string', qty: 'int' },
    relations: { stock: { model: 'AkStock', type: 'one', localField: 'sku', foreignField: 'sku' } },
  });
  _sc.register({
    name: 'AkStock', collection: 'ak_stocks', idPrefix: 'aks',
    timestamps: false, read: null, datasource: SRC,
    fields: { _id: 'string', sku: 'string', qty: 'int' },
    relations: { owner: { model: 'AkUser', type: 'one', localField: 'ownerId', foreignField: '_id' } },
  });
  _sc.register({
    name: 'AkPost', collection: 'ak_posts', idPrefix: 'akp',
    timestamps: false, read: null, datasource: SRC,
    fields: { _id: 'string', title: 'string' },
  });
}

_registerAkSchemas();

module.exports = {
  SRC,
  fakeLlm,
  _out,
  seedOrders,
  seedUsers,
  _lastReadSql,
  CTX_USER,
  CTX_GUEST,
  CTX_ADMIN,
  _GOOD,
  _PROJ_DOCS,
  bootstrap,
  _reset,
  assertFirstBlocked,
  assertClientRejects,
  store,
  executors,
  permission,
  feedback,
  schema: _sc,
  text2query,
  AskExhausted,
  llm: llmReg,
  askMod,
  crudMod,
  LlmError,
  _guardRouteOverride,
};
