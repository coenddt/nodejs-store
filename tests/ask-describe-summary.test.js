'use strict';

/**
 * ask L1 · 验收矩阵 T8–D6（D4-4 零语义拆分）。
 *
 * 自 ask.test.js 原样迁出 describeForAi 摘要面（T8 / T8b / T8c / T8c-旧绑定降级）、
 * fail-secure（T9）、聚合封顶（T10a / T10b）、关系聚合谓词（T11）、$pipeline 直通（T12）
 * 与插拔注册表（D6）；用例名与断言逐字未改（仅去掉 describe 一层缩进）。
 * 顶层放置以保持 describe 计数与拆分前一致。
 */

const { it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  fakeLlm, _out, seedOrders, seedUsers, _lastReadSql,
  CTX_USER, CTX_GUEST, CTX_ADMIN, _GOOD, _PROJ_DOCS,
  bootstrap, _reset, assertFirstBlocked,
  store, permission, feedback, schema: _sc,
  askMod, llm: llmReg,
} = require('../test-support/ask-support');

before(bootstrap);

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
    /** @type {any} */
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
  const err = assertFirstBlocked(res);
  // 8c-2 收缩判决携带 ERR_TEXT2QUERY 稳定前缀（rust-store 补前缀任务已合入本地产物）
  assert.ok(err.message.includes('嵌套关系路径'));
  assert.deepEqual(res.data, _PROJ_DOCS);
});

// ── T12 $pipeline 直通（core 5.0.0 撤销：解析期一律显式报错）→ 回喂重试 ──

it('T12: $pipeline 直通在解析期显式报错（不再按档位放行）→ 回喂重试成功', async () => {
  _reset();
  seedOrders();
  const llm = fakeLlm(
    _out('AkOrder($pipeline:@p0){_id, code}', { p0: [{ $match: {} }] }),
    _out(..._GOOD),
  );
  const res = await store.ask('自定义管道查询', { llm, ctx: CTX_USER });
  const err = res.attempts[0].error;
  assert.equal(err.code, 'planError');
  assert.ok(err.message.includes('$pipeline 直通已移除'));
  assert.deepEqual(res.data, _PROJ_DOCS);
  assert.deepEqual(res.events.map((e) => e.code), []);
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
