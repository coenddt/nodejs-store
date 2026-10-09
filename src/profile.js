'use strict';

/**
 * 查询档位上下文 —— text2query 便捷上下文
 *
 * 自 index.js 提取为独立模块（ask.js 需硬编码进入 text2query 档，直接依赖本模块
 * 而非包入口，避免循环 require）；对 index.js 的导出面零变化（index.js re-export）。
 *
 * R2（03 §3.2/§4.1）：档位随**作用域视图**隔离——入口一次性派生 text2query 档位视图，
 * 交由 `withScope` 承载；退出作用域即回退 base 档位。不再全局 `setProfile` 再恢复，
 * 故并发 / 嵌套调用各自回到自己进入前的档位（无需记录「原档」的 ALS），
 * 进程级改档的串扰根源随之消除。档位判决仍在 core（`withPolicy` 入参走 01 §4.3 契约）。
 */

const { getCore } = require('./schema');
const { withScope } = require('./scope');

/** 以 text2query 档位视图执行 fn，退出即回退 base（AI 问数链路入口） */
async function text2query(fn) {
  const view = getCore().withPolicy({ profile: 'text2query' });
  return withScope({ view }, () => fn());
}

module.exports = { text2query };
