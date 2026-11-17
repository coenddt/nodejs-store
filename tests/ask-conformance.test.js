'use strict';

/**
 * conformance · 与 py-store 逐字节一致（D4-4 零语义拆分）。
 *
 * 自 ask.test.js 原样迁出 `conformance · 与 py-store 逐字节一致（GQL / 错误前缀 /
 * 事件形状）` describe；用例名与断言逐字未改（`__dirname` 相对层级不变）。
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  seedOrders, _reset, bootstrap,
  CTX_USER, _GOOD, _PROJ_DOCS,
  store, permission, feedback, schema: _sc, text2query, crudMod, _guardRouteOverride,
} = require('../test-support/ask-support');

before(bootstrap);

// ── 双端一致性（对齐 store-api conformance 先例：同一输入，双端判决同构） ──

describe('conformance · 与 py-store 逐字节一致（GQL / 错误前缀 / 事件形状）', () => {
  it('ask_knowledge.md 正文与 py-store 基线逐字节一致（剥离端差异化头注释后）', (t) => {
    const pyPath = path.join(__dirname, '..', '..', 'py-store', 'src', 'py_store', 'ask_knowledge.md');
    if (!fs.existsSync(pyPath)) return t.skip('[环境依赖] py-store 基线不存在（非 monorepo 环境）');
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
    // ② 解析期拒绝类：$pipeline 直通（core 5.0.0 撤销，与 py test_t12 同输入）
    _sc.setProfile('text2query');
    permission.setContext(CTX_USER);
    await assert.rejects(
      () => store.query('AkOrder($pipeline:@p0){_id, code}', { p0: [{ $match: {} }] }),
      (/** @type {any} */ e) => String(e.message).includes('$pipeline 直通已移除'),
    );
    // ③ 计划错误类：8c-2 嵌套关系路径（与 py test_t11 同输入；新 core 已带稳定前缀）
    await assert.rejects(
      () => store.query('AkOrder($condition:@c0){_id}', {
        c0: { items: { filter: { 'stock.sku': 's1' },
          agg: { n: { $count: '*' } },
          having: { n: { $gt: 0 } } } },
      }),
      (/** @type {any} */ e) => e.name === 'ProfileViolation' && e.message.includes('嵌套关系路径'),
    );
  });
});
