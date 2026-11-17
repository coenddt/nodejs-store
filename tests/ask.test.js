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
 *
 * D4-4 零语义拆分：共用桩 / SQLite 库 / 复位断言骨架 / 场景 schema 下沉
 * ../test-support/ask-support.js；「llm 工厂」与「conformance」两段各自成册，
 * 「T8–D6」段迁 ask-describe-summary.test.js；用例名与断言逐字未改。
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  fakeLlm, _out, seedOrders, seedUsers, _lastReadSql,
  CTX_USER, _GOOD, _PROJ_DOCS,
  bootstrap, _reset, assertFirstBlocked,
  store, permission, feedback, schema: _sc,
  crudMod, AskExhausted,
} = require('../test-support/ask-support');

before(bootstrap);

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
    const err = assertFirstBlocked(res);
    // U2 收缩判决携带 ERR_TEXT2QUERY 稳定前缀（rust-store 补前缀任务已合入本地产物）
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
      (/** @type {any} */ e) => {
        assert.equal(e.attempts.length, 1);
        return true;
      },
    );
  });
});
