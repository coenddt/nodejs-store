'use strict';

/**
 * 缓存状态 provider —— 「注记为真」（04 §4.3）。
 *
 * 命中真实性由**本次请求选中链路是否 `role === 'cache'`**决定，不由皮伪造：
 * 读请求级选中链路记录（`context.js#currentSelection`，来源 02 的 `plan.links`）后：
 *   1. 无 `role === 'cache'` 链路 ⇒ `'BYPASS'`（本请求不涉及缓存）；
 *   2. 有且本次**选中**它 ⇒ `'HIT'`；有但**未选中** ⇒ `'MISS'`；
 *   3. 读不到选中信息（非查询请求 / 未记录）⇒ `'BYPASS'`（绝不猜）。
 *
 * 「选中」判定：`plan.links` 为各 schema 的候选链路，已由 core `resolve_read_links`
 * 按择优排序 —— 取每组**首项**为本次选中落点；任一所查 schema 选中 `role=cache` 即 `HIT`。
 *
 * 契约（逐字对齐 §4.3）：返回值恒为 `HIT|MISS|BYPASS` 之一；**provider 自身不得吞异常、
 * 不得返回非法值** —— 回落 `BYPASS` + 反馈留痕统一由 `cacheStatus`（`cache.js`）处理。
 */

const { currentSelection } = require('./context');

/**
 * 创建「链路选择驱动」的缓存状态 provider。
 * @param {{selectionOf?: (ctx: any) => object|null}} [spec]
 *        `selectionOf` 缺省读请求级 `currentSelection()`（可注入以复用于非 ALS 场景 / 测试）
 * @returns {(ctx: any) => 'HIT'|'MISS'|'BYPASS'}
 */
function createLinkCacheProvider(spec = {}) {
  const selectionOf = typeof spec.selectionOf === 'function' ? spec.selectionOf : currentSelection;
  return (ctx) => {
    const sel = selectionOf(ctx);
    if (sel == null) return 'BYPASS';                 // 3. 读不到 ⇒ 绝不猜
    const groups = Object.values(sel).filter(Array.isArray);
    const flat = groups.flat();
    if (!flat.some((l) => l && l.role === 'cache')) {
      return 'BYPASS';                                // 1. 无 cache 链路 ⇒ 本请求不涉缓存
    }
    const selectedCache = groups.some((g) => g[0] && g[0].role === 'cache');  // 2. 选中判定
    return selectedCache ? 'HIT' : 'MISS';
  };
}

module.exports = { createLinkCacheProvider };
