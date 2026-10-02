'use strict';

/**
 * 查询档位上下文 —— text2query 便捷上下文
 *
 * 自 index.js 提取为独立模块（ask.js 需硬编码进入 text2query 档，直接依赖本模块
 * 而非包入口，避免循环 require）；对 index.js 的导出面零变化（index.js re-export）。
 *
 * 档位 AsyncLocalStorage：记录「进入 text2query 前的原档」，供退出恢复（嵌套安全）。
 * 与 permission.scopedRoles 同构（token-set/reset，嵌套安全）。
 * 档位是 core 进程级状态（非本 ALS 隔离），ALS 仅记录「进入时的原档」以便正确恢复，
 * 使异步 / 嵌套调用各自回到自己进入前的档位。进入档位即等效强制携带用户上下文
 * （core `ensureProfileCtx`，见执行文档 §4.2）。
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const { getProfile, setProfile } = require('./schema');

const _profileAls = new AsyncLocalStorage();

/** 以 text2query 档执行 fn，退出恢复原档位（AI 问数链路入口） */
async function text2query(fn) {
  const prev = getProfile();
  setProfile('text2query');
  return _profileAls.run(prev, async () => {
    try {
      return await fn();
    } finally {
      setProfile(prev);
    }
  });
}

module.exports = { text2query, _profileAls };
