'use strict';

/**
 * AI 问数（L1）—— ask() 编排闭环 + describeForAi 摘要（验收矩阵 T1-T12）
 *
 * 对照《AI能力接入设计-L1问数档.md》§7 矩阵逐条落用例；与 py-store/tests/test_ask.py
 * 一一同构（M2 parity）。单测一律假 LLM 注入 + SQLite 内存库（nodejs-store 真实驱动
 * 惯例，对齐 profile.test.js），不依赖网络与真实厂商；档位/权限/硬限判决全部经真实
 * Rust core（LOCAL_CORE 产物），驱动只替 IO。
 *
 * 与矩阵原文的三处按实现取证调整（均已在用例注释留痕，与 py 侧 test_ask.py 同）：
 *   - T2：A15/档位清单定义根级超限为 **clamp**（force/clamp_t2q_limit，不 Err），
 *     矩阵原文「ProfileViolation」与之冲突 —— 按 core 实现验证硬限 clamp 生效；
 *   - T4：route_override 通道在编排面硬编码封闭（D5），LLM 于 params 夹带的
 *     route_override 键是普通未引用参数、不触达路由通道 —— 按「护栏不可触」
 *     断言编排面（crud.query 第三参恒 null），而非依赖夹带触发拦截；
 *   - T8：字段级越权（guest 投影 admin 专属字段）的 core 判决形态是**投影静默剥离**
 *     （is_field_readable 过滤，数据不出）而非报错 —— 「被权限层拒」按数据形态断言。
 *
 * 对 py 侧 test_ask.py 的两处双端取证更新（本轮实测，2026-10-02）：
 *   - T5/T11：rust-store「补 ERR_TEXT2QUERY 前缀」任务已合入本机 LOCAL_CORE 产物
 *     （U1~U4 与 8c-2 收缩判决均携带稳定前缀）→ T5/T11 code=profileBlocked（py 侧
 *     留痕的「无前缀 → planError 一致性缺口」已在新 core 修复；npm rust-store-node
 *     2.0.0 滞后于仓库源码，发版对齐后与 py 侧同步）；
 *   - T8c：core-node 已导出 readableComputes 判决（同任务合入）→ describeForAi
 *     计算列按 core 角色判决进/出摘要（admin 可见 displayName）；旧绑定未导出时
 *     能力探测降级为「配 read 一律收窄 + 告警」（对齐 py 现状），降级分支单独用例覆盖。
 *
 * 方言取证差异（与 py 侧留痕）：py 侧断言 Mongo mock 的聚合管道（$limit 键）；
 * node 侧跑真实 SQLite，对应取证为 SQL 文本 + 绑定参数（LIMIT ? 的 params 值）——
 * 断言意图相同（根级封顶生效），取证形态按方言如实。轨迹键名同理按语言惯例：
 * `llmRaw`（py 为 `llm_raw`），其余结构化键（错误对象 code/layer/feature、事件键、
 * GQL/params）为双端同一套字面量。
 *
 * 运行：node scripts/test.js（scripts/test.js 会置 LOCAL_CORE=1）
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
      throw new assert.AssertionError('假 LLM 输出脚本耗尽（出现了意外的额外轮次）');
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

before(async () => {
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
});

/** 每用例复位（档位/上下文/反馈 sink 为进程级全局，防用例间串扰） */
function _reset() {
  _sc.setProfile('standard');
  permission.setContext(undefined);
  feedback.setSink(null);
  _sqlLog = [];
  _db.exec('DELETE FROM ak_orders; DELETE FROM ak_users;');
}

describe('ask L1 · 验收矩阵 T1-T12', () => {
  // ── T1 正常问数（正向断言：成功态轨迹无任何错误字段） ──────────

  it('T1: 正常问数——数据 + 单次成功轨迹，成功态无任何错误字段', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(_out(..._GOOD));
    const res = await store.ask('列出全部订单', { llm, ctx: CTX_USER });
    assert.deepEqual(res.data, _PROJ_DOCS);
    assert.equal(res.attempts.length, 1);
    const a = res.attempts[0];
    assert.equal(a.gql, _GOOD[0]);
    assert.deepEqual(a.params, _GOOD[1]);
    assert.equal(a.rows, 1);
    // no-error-masking 正向断言：成功态轨迹中不得出现任何错误字段
    assert.ok(res.attempts.every((x) => !('error' in x)));
    // 无拦截 → 无反馈事件
    assert.deepEqual(res.events, []);
    // 沙箱退出恢复：档位 / 上下文 / sink 全部还原（token-set/reset）
    assert.equal(_sc.getProfile(), 'standard');
    assert.equal(permission.getContext(), undefined);
    assert.equal(feedback.getSink(), null);
  });

  it('T1/D5: 受信物零暴露——ctx 值不出现在任何 LLM 消息；system 含 json 契约措辞', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(_out(..._GOOD));
    await store.ask('列出全部订单', { llm, ctx: CTX_USER });
    assert.equal(llm.calls.length, 1);
    const [system, user] = llm.calls[0];
    assert.equal(system.role, 'system');
    assert.ok(system.content.toLowerCase().includes('json'));
    assert.deepEqual(user, { role: 'user', content: '列出全部订单' });
    const dumped = JSON.stringify(llm.calls[0]);
    assert.ok(!dumped.includes('u1') && !dumped.includes('userId'));
  });

  // ── T2 行数硬限（按实现取证：根级 clamp，见文件头注释） ────────

  it('T2: 根级 $limit 5000 被 clamp 到 1000（SQL 取 LIMIT 1000，不 Err）', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(_out('AkOrder($condition:@c0,$limit:@l){_id, code}', { c0: {}, l: 5000 }));
    const res = await store.ask('取前 5000 条订单', { llm, ctx: CTX_USER });
    assert.deepEqual(res.data, _PROJ_DOCS);
    // core force/clamp_t2q_limit：根级显式超限夹到 T2Q_MAX_ROWS=1000（A15）；
    // SQLite 方言 LIMIT 值参数化（LIMIT ?），绑定参数里取证
    const last = _lastReadSql();
    assert.match(last.text, /LIMIT\s+\?/i);
    assert.deepEqual(last.params, [1000]);
    assert.deepEqual(res.events, []);
  });

  // ── T3 关系深度 4 → 档位判决 → 回喂重试 ────────────────────────

  it('T3: 关系深度 4 被档位拦截（profileBlocked/layer=core）→ 回喂重试成功', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(
      _out('AkOrder{items{stock{owner{posts{title}}}}}', {}),
      _out(..._GOOD),
    );
    const res = await store.ask('订单连同明细库存和作者帖子', { llm, ctx: CTX_USER });
    assert.equal(res.attempts.length, 2);
    const err = res.attempts[0].error;
    // 深度超限走稳定前缀（lookup.rs ERR_TEXT2QUERY）→ ProfileViolation 事件原样回喂
    assert.equal(err.code, 'profileBlocked');
    assert.equal(err.layer, 'core');
    assert.ok(err.message.includes('深度'));
    assert.equal(res.attempts[1].rows, 1);
    assert.deepEqual(res.events.map((e) => e.code), ['profileBlocked']);
  });

  // ── T4 route_override 夹带（按 D5 取证：通道封闭，见文件头注释） ─

  it('T4: params 夹带 route_override 是惰性键——编排面第三参恒 null，查询照常成功', async () => {
    _reset();
    seedOrders();
    const captured = { routeOverride: '哨兵（未被调用则本值留存）' };
    const origQuery = crudMod.query;
    crudMod.query = async (gql, params, routeOverride) => {
      captured.routeOverride = routeOverride;
      return origQuery(gql, params, routeOverride);
    };
    try {
      const llm = fakeLlm(_out('AkOrder($condition:@c0){_id, code}',
        { c0: {}, route_override: { source: 'evil' } }));
      const res = await store.ask('列出全部订单', { llm, ctx: CTX_USER });
      // 编排面硬编码：crud.query 收到的 routeOverride 实参恒为 null（LLM 不可触）
      assert.equal(captured.routeOverride, null);
      // 夹带键只是未引用参数，不产生任何路由效果，查询照常成功
      assert.deepEqual(res.data, _PROJ_DOCS);
    } finally {
      crudMod.query = origQuery;
    }
  });

  // ── T5 object 字段条件（U2 收缩）→ 回喂重试 ────────────────────

  it('T5: object 字段整值条件（U2 收缩）→ profileBlocked 回喂重试成功', async () => {
    _reset();
    seedUsers();
    const llm = fakeLlm(
      _out('AkUser($condition:@c0){_id, name}', { c0: { profile: { city: 'x' } } }),
      _out('AkUser($condition:@c0){_id, name}', { c0: { name: 'bob' } }),
    );
    const res = await store.ask('查住在 x 城的用户', { llm, ctx: CTX_USER });
    const err = res.attempts[0].error;
    // U2 收缩判决携带 ERR_TEXT2QUERY 稳定前缀（rust-store 补前缀任务已合入本地产物）
    assert.equal(err.code, 'profileBlocked');
    assert.equal(err.layer, 'core');
    assert.ok(err.message.includes('U2') && err.message.includes('text2query'));
    assert.deepEqual(res.data, [{ _id: 'aku1', name: 'bob' }]);
  });

  // ── T6 非法 JSON / 非法 GQL → 结构化回喂 ───────────────────────

  it('T6: 非法 JSON 与非法 GQL 结构化回喂，第三轮成功；回喂消息面符合 §4.3 契约', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(
      '这不是 json',
      '{"gql": "AkOrder((((", "params": {}}',
      _out(..._GOOD),
    );
    const res = await store.ask('列出全部订单', { llm, ctx: CTX_USER });
    assert.deepEqual(res.attempts.slice(0, 2).map((a) => a.error.code), ['badLlmOutput', 'planError']);
    assert.equal(res.attempts[0].error.raw, '这不是 json');
    assert.equal(res.attempts.length, 3);
    // 回喂消息面：assistant 原文 + user {"error": ...}（§4.3 契约）
    const third = llm.calls[2];
    assert.deepEqual(third[third.length - 2],
      { role: 'assistant', content: '{"gql": "AkOrder((((", "params": {}}' });
    assert.equal(third[third.length - 1].role, 'user');
    assert.equal(JSON.parse(third[third.length - 1].content).error.code, 'planError');
  });

  // ── T7 重试耗尽 → AskExhausted 携带全轨迹，不返回空结果 ─────────

  it('T7: 重试 3 次耗尽抛 AskExhausted（4 次尝试全轨迹），不返回空结果', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm('坏输出', '坏输出', '坏输出', '坏输出');
    await assert.rejects(
      () => store.ask('列出全部订单', { llm, ctx: CTX_USER, maxRetries: 3 }),
      (e) => {
        assert.ok(e instanceof AskExhausted);
        // 总尝试 = 1 + maxRetries；全轨迹在案；异常形态（非数据）即「不返回空结果」
        assert.equal(e.attempts.length, 4);
        assert.ok(e.attempts.every((a) => a.error.code === 'badLlmOutput'));
        assert.equal(llm.calls.length, 4);
        assert.match(e.message, /badLlmOutput/);
        return true;
      },
    );
  });

  it('T7b: maxRetries=0 单次尝试即耗尽', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm('坏输出');
    await assert.rejects(
      () => store.ask('列出全部订单', { llm, ctx: CTX_USER, maxRetries: 0 }),
      (e) => {
        assert.equal(e.attempts.length, 1);
        return true;
      },
    );
  });

  // ── T8 guest：摘要过滤 + 越权查询被权限层拒 ────────────────────

  it('T8: guest 摘要无 admin 专属字段与归档表；越权投影 role 被权限层剥离（数据不出）', async () => {
    _reset();
    seedUsers();
    const s = store.describeForAi(CTX_GUEST);
    assert.ok(s.every((m) => !m.name.endsWith('Deleted'))); // 归档表排除（A12）
    const aku = s.find((m) => m.name === 'AkUser');
    assert.ok(!('role' in aku.fields));           // admin 专属字段被 A11 过滤
    assert.ok('name' in aku.fields);
    assert.ok(!('displayName' in aku.computes));  // read 白名单计算列收窄
    assert.ok('upperName' in aku.computes);
    assert.ok(s.every((m) => !('indexes' in m || 'datasource' in m || 'namespace' in m)));
    // 越权查询：guest 投影 admin 专属字段 role → 权限层剥离（数据不出，见文件头注释留痕）
    const llm = fakeLlm(_out('AkUser($condition:@c0){_id, role}', { c0: {} }));
    const res = await store.ask('列出用户和角色', { llm, ctx: CTX_GUEST });
    assert.ok(res.data.every((row) => !('role' in row)));
    assert.equal(res.attempts[0].rows, 1);
  });

  it('T8b: 无 ctx 摘要仅暴露模型名与字段名（排序数组），不暴露类型/关系/计算列（防探针）', () => {
    _reset();
    const s = store.describeForAi();
    const aku = s.find((m) => m.name === 'AkUser');
    assert.ok(Array.isArray(aku.fields));
    assert.deepEqual(aku.fields, ['_id', 'name', 'profile', 'role']);
    assert.ok(!('relations' in aku) && !('computes' in aku));
  });

  it('T8c: admin 摘要含 role 与 read 白名单计算列（core readableComputes 判决），无收窄告警', () => {
    _reset();
    askMod._computeSkipSigs.clear(); // 告警去重为进程级，单测内复位以保证可断言
    // 清单化语义（设计 §11.5）：AkUser.read 白名单不含 admin，admin 视角需显式豁免
    permission.setExemptRoles(['admin']);
    try {
      const events = [];
      feedback.setSink((e) => events.push(e));
      const s = store.describeForAi(CTX_ADMIN);
      const aku = s.find((m) => m.name === 'AkUser');
      assert.equal(aku.fields.role, 'string');
      // core-node 已导出 readableComputes（rust-store 联动任务合入）：read 白名单计算列
      // 按角色判决——admin 可读 → 进摘要；不再走旧绑定的收窄 + 告警路径
      assert.deepEqual(aku.computes.displayName, { type: 'string' });
      assert.deepEqual(aku.computes.upperName, { type: 'string' });
      assert.ok('itemCount' in s.find((m) => m.name === 'AkOrder').computes);
      // 新绑定路径不产生收窄告警（guest 侧不进摘要由 T8 断言）
      assert.deepEqual(events.filter((e) => e.type === 'ask_summary_compute_skipped'), []);
    } finally {
      permission.setExemptRoles([]);
    }
  });

  it('T8c-旧绑定降级: core 未导出 readableComputes 时收窄 + 告警（同签名去重，对齐 py 现状）', () => {
    _reset();
    askMod._computeSkipSigs.clear();
    const coreObj = _sc.core;
    coreObj.readableComputes = undefined; // 能力探测降级：模拟旧绑定（如 npm rust-store-node 2.0.0）
    // 清单化语义（设计 §11.5）：AkUser.read 白名单不含 admin，admin 视角需显式豁免
    permission.setExemptRoles(['admin']);
    const events = [];
    feedback.setSink((e) => events.push(e));
    try {
      const s = store.describeForAi(CTX_ADMIN);
      const aku = s.find((m) => m.name === 'AkUser');
      // 宁缺勿泄：配 read 的计算列无论角色一律不进摘要（执行面判决仍在 core）
      assert.ok(!('displayName' in aku.computes));
      assert.ok('upperName' in aku.computes);
      const warns = events.filter((e) => e.type === 'ask_summary_compute_skipped');
      assert.equal(warns.length, 1);
      assert.equal(warns[0].model, 'AkUser');
      assert.equal(warns[0].compute, 'displayName');
      // 同签名只告警一次（再次 describe 不重复）
      store.describeForAi(CTX_ADMIN);
      assert.equal(events.filter((e) => e.type === 'ask_summary_compute_skipped').length, 1);
    } finally {
      delete coreObj.readableComputes; // 摘除实例遮蔽，恢复原型方法
      permission.setExemptRoles([]);
      feedback.setSink(null);
    }
  });

  // ── T9 无 ctx 直接拒绝（fail-secure，A4） ──────────────────────

  it('T9: 无 ctx 直接拒绝（fail-secure），不发生任何 LLM 调用，档位未被改动', async () => {
    _reset();
    const llm = fakeLlm(_out(..._GOOD));
    await assert.rejects(
      () => store.ask('列出全部订单', { llm, ctx: null }),
      /ctx/,
    );
    assert.equal(llm.calls.length, 0); // 未发生任何 LLM 调用
    assert.equal(_sc.getProfile(), 'standard');
  });

  // ── T10 聚合放行 + 省略 $limit 视为上限 1000（A15/W1） ─────────

  it('T10a: 根级 $group/$having 聚合放行，真实执行并封顶 LIMIT 1000', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(_out('AkOrder($group:@g0,$sort:@s0){code, n}',
      { g0: { by: ['code'], agg: { n: { $count: '*' } } }, s0: { n: -1 } }));
    const res = await store.ask('按 code 分组计数', { llm, ctx: CTX_USER });
    // 真实 SQLite 聚合（py 侧为 mock 管道取证；此处按方言以真实结果 + SQL 文本取证）
    assert.deepEqual(res.data, [{ code: 'A1', n: 1 }]);
    const last = _lastReadSql();
    assert.match(last.text, /GROUP\s+BY/i);
    assert.match(last.text, /LIMIT\s+\?/i);
    assert.deepEqual(last.params, [1000]);
  });

  it('T10b: 省略 $limit 的根级查询视为上限 1000（force_t2q_limit 注入）', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(_out('AkOrder{_id, code}', {}));
    const res = await store.ask('全部订单', { llm, ctx: CTX_USER });
    assert.deepEqual(res.data, _PROJ_DOCS);
    // 省略 $limit → force_t2q_limit 注入根级 1000
    assert.match(_lastReadSql().text, /LIMIT\s+\?/i);
    assert.deepEqual(_lastReadSql().params, [1000]);
  });

  // ── T11 关系聚合谓词嵌套路径（8c-2 收缩）→ 回喂重试 ────────────

  it('T11: 关系聚合谓词嵌套路径（关系.字段 下钻）显式拒绝 → 回喂重试成功', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(
      _out('AkOrder($condition:@c0){_id}', {
        c0: { items: { filter: { 'stock.sku': 's1' },
          agg: { n: { $count: '*' } },
          having: { n: { $gt: 0 } } } },
      }),
      _out(..._GOOD),
    );
    const res = await store.ask('库存里有 s1 的订单', { llm, ctx: CTX_USER });
    const err = res.attempts[0].error;
    // 8c-2 收缩判决携带 ERR_TEXT2QUERY 稳定前缀（rust-store 补前缀任务已合入本地产物）
    assert.equal(err.code, 'profileBlocked');
    assert.equal(err.layer, 'core');
    assert.ok(err.message.includes('嵌套关系路径'));
    assert.deepEqual(res.data, _PROJ_DOCS);
  });

  // ── T12 $pipeline 直通（forbid_t2q）→ 回喂重试 ─────────────────

  it('T12: $pipeline 直通被 forbid_t2q 拒绝（feature=$pipeline 直通）→ 回喂重试成功', async () => {
    _reset();
    seedOrders();
    const llm = fakeLlm(
      _out('AkOrder($pipeline:@p0){_id, code}', { p0: [{ $match: {} }] }),
      _out(..._GOOD),
    );
    const res = await store.ask('自定义管道查询', { llm, ctx: CTX_USER });
    const err = res.attempts[0].error;
    assert.equal(err.code, 'profileBlocked');
    assert.equal(err.feature, '$pipeline 直通');
    assert.deepEqual(res.data, _PROJ_DOCS);
    assert.deepEqual(res.events.map((e) => e.code), ['profileBlocked']);
  });

  // ── D6 插拔注册表：注册名与客户端两路同一入口 ──────────────────

  it('D6: 注册名走 ask() 同一入口；未注册取用 / 重复注册显式报错', async () => {
    _reset();
    seedOrders();
    llmReg.registerLlm('ak-test-llm', fakeLlm(_out(..._GOOD)));
    try {
      const res = await store.ask('列出全部订单', { llm: 'ak-test-llm', ctx: CTX_USER });
      assert.deepEqual(res.data, _PROJ_DOCS);
      assert.throws(() => llmReg.getLlm('ak-not-registered'), /未注册/);
      assert.throws(() => llmReg.registerLlm('ak-test-llm', fakeLlm()), /重复注册/);
    } finally {
      llmReg._registry.delete('ak-test-llm');
    }
  });
});

// ── llm.js 工厂行为矩阵（py 侧原型实测事实的 node 侧固化） ─────
// ── llm.js 工厂行为矩阵（py 侧原型实测事实的 node 侧固化） ─────

describe('llm · OpenAI 兼容工厂（D6）', () => {
  const BASE = { baseUrl: 'https://llm.example/v1', model: 'deepseek-flash', apiKey: 'sk-test' };

  /** 临时替换全局 fetch（makeOpenaiCompat 的唯一 IO 面），用毕恢复 */
  function withFetch(fake, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = fake;
    return Promise.resolve()
      .then(fn)
      .finally(() => { globalThis.fetch = orig; });
  }

  it('json_mode 契约预检：prompt 缺 "json" 字样即抛 llmJsonPromptMissing（不发出请求）', async () => {
    let fetched = 0;
    await withFetch(async () => { fetched += 1; }, async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      await assert.rejects(
        () => client([{ role: 'user', content: '随便聊聊今天的天气' }]),
        (e) => {
          assert.ok(e instanceof LlmError);
          assert.equal(e.detail.code, 'llmJsonPromptMissing');
          return true;
        },
      );
      assert.equal(fetched, 0, '预检失败不得发出网络请求');
    });
  });

  it('HTTP 4xx/5xx → llmHttpError（携状态码与响应体片段）', async () => {
    await withFetch(async () => ({
      ok: false, status: 500, text: async () => 'boom-body',
    }), async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      await assert.rejects(
        () => client([{ role: 'user', content: '输出 json' }]),
        (e) => {
          assert.equal(e.detail.code, 'llmHttpError');
          assert.equal(e.detail.status, 500);
          assert.equal(e.detail.body, 'boom-body');
          return true;
        },
      );
    });
  });

  it('网络层断连 → llmNetworkError', async () => {
    await withFetch(async () => { throw new Error('socket hang up'); }, async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      await assert.rejects(
        () => client([{ role: 'user', content: '输出 json' }]),
        (e) => {
          assert.equal(e.detail.code, 'llmNetworkError');
          assert.match(e.detail.detail, /socket hang up/);
          return true;
        },
      );
    });
  });

  it('空 content → llmEmptyContent（携 finish_reason 与 reasoning_tokens，禁静默空串）', async () => {
    await withFetch(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { completion_tokens_details: { reasoning_tokens: 440 } },
      }),
    }), async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      await assert.rejects(
        () => client([{ role: 'user', content: '输出 json' }]),
        (e) => {
          assert.equal(e.detail.code, 'llmEmptyContent');
          assert.equal(e.detail.finish_reason, 'length');
          assert.equal(e.detail.reasoning_tokens, 440);
          return true;
        },
      );
    });
  });

  it('正常路径返回 content；json_mode 与 effort 开关如实反映在请求体', async () => {
    const bodies = [];
    await withFetch(async (url, init) => {
      bodies.push({ url, body: JSON.parse(init.body), ua: init.headers['User-Agent'] });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"gql":"M{_id}","params":{}}' } }] }),
      };
    }, async () => {
      const client = llmReg.makeOpenaiCompat(BASE);
      const out = await client([{ role: 'user', content: '输出 json' }]);
      assert.equal(out, '{"gql":"M{_id}","params":{}}');
      assert.equal(bodies[0].url, 'https://llm.example/v1/chat/completions');
      assert.equal(bodies[0].body.model, 'deepseek-flash');
      assert.equal(bodies[0].body.response_format.type, 'json_object');
      assert.equal(bodies[0].body.reasoning_effort, 'low');
      assert.equal(bodies[0].body.max_tokens, 4096);
      // 默认 UA 被网关断连（py 侧实证），工厂显式覆盖
      assert.equal(bodies[0].ua, 'nodejs-store-ask/0.1');
    });
    // jsonMode=false：不传 response_format；effort=null：不传 reasoning_effort
    await withFetch(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    }, async () => {
      const client = llmReg.makeOpenaiCompat({ ...BASE, jsonMode: false, effort: null });
      await client([{ role: 'user', content: '随意' }]);
      assert.ok(!('response_format' in bodies[1]));
      assert.ok(!('reasoning_effort' in bodies[1]));
    });
  });
});

// ── 双端一致性（对齐 store-api conformance 先例：同一输入，双端判决同构） ──

describe('conformance · 与 py-store 逐字节一致（GQL / 错误前缀 / 事件形状）', () => {
  it('ask_knowledge.md 正文与 py-store 基线逐字节一致（剥离端差异化头注释后）', (t) => {
    const pyPath = path.join(__dirname, '..', '..', 'py-store', 'src', 'py_store', 'ask_knowledge.md');
    if (!fs.existsSync(pyPath)) return t.skip('py-store 基线不存在（非 monorepo 环境）');
    const stripHeader = (s) => s.replace(/^<!--[\s\S]*?-->\r?\n/, '');
    const nodeText = stripHeader(fs.readFileSync(path.join(__dirname, '..', 'src', 'ask_knowledge.md'), 'utf8'));
    const pyText = stripHeader(fs.readFileSync(pyPath, 'utf8'));
    assert.equal(nodeText, pyText);
  });

  it('ERR_TEXT2QUERY: 稳定前缀按前缀映射并剥离，不匹配中文文案（与 py crud/exec 同构）', () => {
    const { _call, ProfileViolation } = crudMod;
    assert.throws(
      () => _call(() => { throw new Error('ERR_TEXT2QUERY:深度超限 [关系嵌套深度]（功能收缩）'); }),
      (e) => {
        assert.ok(e instanceof ProfileViolation);
        // 映射时剥离稳定前缀（与 py-store/src/py_store/crud/exec.py 同语义）
        assert.ok(!e.message.startsWith('ERR_TEXT2QUERY:'));
        assert.ok(e.message.includes('深度超限'));
        return true;
      },
    );
  });

  it('profile_blocked 事件形状逐键同构（core 层与 host 层同一键集，对齐 py feedback 契约）', async () => {
    _reset();
    seedOrders();
    const events = [];
    feedback.setSink((e) => events.push(e));
    // core 层：text2query 档强制 ctx（无 ctx 即拦），事件由 core 前缀映射 emit
    await assert.rejects(() => text2query(() => store.query('AkOrder{items{stock{owner{posts{title}}}}}')));
    const coreEv = events[events.length - 1];
    assert.deepEqual(Object.keys(coreEv).sort(),
      ['code', 'feature', 'hint', 'layer', 'message', 'profile', 'type'].sort());
    assert.equal(coreEv.type, 'profile_blocked');
    assert.equal(coreEv.code, 'profileBlocked');
    assert.equal(coreEv.layer, 'core');
    assert.equal(coreEv.profile, 'text2query');
    // host 层：routeOverride 兜底（_guardRouteOverride），同键集、layer=host
    _sc.setProfile('text2query');
    assert.throws(() => _guardRouteOverride({ source: 'evil' }));
    const hostEv = events[events.length - 1];
    assert.deepEqual(Object.keys(hostEv).sort(),
      ['code', 'feature', 'hint', 'layer', 'message', 'profile', 'type'].sort());
    assert.equal(hostEv.layer, 'host');
    assert.equal(hostEv.feature, 'route_override');
  });

  it('同一 GQL/params 字面量双端判决同构（conformance：成功 / 档位收缩 / 计划错误三类）', async () => {
    _reset();
    seedOrders();
    // ① 成功类：py 侧 _GOOD 基线串在本端可执行且投影形状一致
    const ok = await store.query(_GOOD[0], _GOOD[1]);
    assert.deepEqual(ok, _PROJ_DOCS);
    // ② 档位收缩类：$pipeline 直通 forbid_t2q（与 py test_t12 同输入同 code/feature）
    _sc.setProfile('text2query');
    permission.setContext(CTX_USER);
    await assert.rejects(
      () => store.query('AkOrder($pipeline:@p0){_id, code}', { p0: [{ $match: {} }] }),
      (e) => e.name === 'ProfileViolation' && e.message.includes('$pipeline 直通'),
    );
    // ③ 计划错误类：8c-2 嵌套关系路径（与 py test_t11 同输入；新 core 已带稳定前缀）
    await assert.rejects(
      () => store.query('AkOrder($condition:@c0){_id}', {
        c0: { items: { filter: { 'stock.sku': 's1' },
          agg: { n: { $count: '*' } },
          having: { n: { $gt: 0 } } } },
      }),
      (e) => e.name === 'ProfileViolation' && e.message.includes('嵌套关系路径'),
    );
  });
});

// ── 场景 schema（前缀 Ak；关系链深度 4 供 T3；与 py 侧 test_ask.py 同构） ──

function _registerAkSchemas() {
  _sc.register({
    name: 'AkUser', collection: 'ak_users', idPrefix: 'aku', timestamps: true, datasource: SRC,
    // guest 显式可读模型（read:[] 时 guest 默认禁止），但 role 字段仍 admin 专属 → T8 验证列级过滤
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
    read: [],
    fields: { _id: 'string', code: 'string', amount: 'float' },
    relations: { items: { model: 'AkOrderItem', type: 'many',
      localField: '_id', foreignField: 'orderId' } },
    computes: { itemCount: { type: 'int', agg: { $count: 'items' } } },
  });
  _sc.register({
    name: 'AkOrderItem', collection: 'ak_order_items', idPrefix: 'aki',
    timestamps: false, read: [], datasource: SRC,
    fields: { _id: 'string', sku: 'string', qty: 'int' },
    relations: { stock: { model: 'AkStock', type: 'one', localField: 'sku', foreignField: 'sku' } },
  });
  _sc.register({
    name: 'AkStock', collection: 'ak_stocks', idPrefix: 'aks',
    timestamps: false, read: [], datasource: SRC,
    fields: { _id: 'string', sku: 'string', qty: 'int' },
    relations: { owner: { model: 'AkUser', type: 'one', localField: 'ownerId', foreignField: '_id' } },
  });
  _sc.register({
    name: 'AkPost', collection: 'ak_posts', idPrefix: 'akp',
    timestamps: false, read: [], datasource: SRC,
    fields: { _id: 'string', title: 'string' },
  });
}

_registerAkSchemas();
