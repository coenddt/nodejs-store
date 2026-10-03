'use strict';

/**
 * 缓存状态注记（B6）—— 协议层 `x-cache` 响应头的唯一取值来源。
 *
 * 本轮只落**注记位**：不实现任何实际缓存。无 provider（默认）恒返回 'BYPASS'
 * （响应未经过缓存）——注记必须为真，禁把无缓存谎报为 HIT/MISS。
 * provider 由接入方在实现缓存时经 setCacheStatus 注入，签名 (ctx) => 'HIT'|'MISS'|'BYPASS'。
 */

const { emit } = require('./feedback');

const _VALUES = new Set(['HIT', 'MISS', 'BYPASS']);
let _provider = null;

/** 注册缓存状态 provider；传 null / 非函数恢复默认（恒 BYPASS） */
function setCacheStatus(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

/** 取当前响应的缓存状态注记（恒为 'HIT'|'MISS'|'BYPASS' 之一；非法/异常 → BYPASS + 反馈留痕） */
function cacheStatus(ctx) {
  if (!_provider) return 'BYPASS';
  let v;
  try {
    v = _provider(ctx);
  } catch (e) {
    emit({
      type: 'cache_status_failed',
      code: 'cacheStatusFailed',
      layer: 'host',
      message: `缓存状态 provider 抛错: ${e && e.message ? e.message : e}`,
      hint: '检查 setCacheStatus 注入的 provider；本轮注记位不实现缓存，异常即回落 BYPASS',
    });
    return 'BYPASS';
  }
  if (!_VALUES.has(v)) {
    emit({
      type: 'cache_status_invalid',
      code: 'cacheStatusInvalid',
      layer: 'host',
      message: `缓存状态取值非法: ${JSON.stringify(v)}（值域 HIT|MISS|BYPASS）`,
      hint: 'provider 返回值必须为 HIT/MISS/BYPASS 之一；非法值回落 BYPASS',
    });
    return 'BYPASS';
  }
  return v;
}

module.exports = { setCacheStatus, cacheStatus };
