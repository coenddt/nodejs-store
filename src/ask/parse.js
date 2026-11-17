'use strict';

/**
 * LLM 输出严格解析（D4-4 零语义拆分自 ask.js 组件 B）
 *
 * 唯一产出形状 `{"gql","params"}` 单 JSON 对象（D3）：严格 JSON 解析、
 * 禁正则容错提取；失败抛 `BadLlmOutput`（携带结构化 detail 供回喂）。
 */

/** LLM 输出未通过严格解析（携带结构化 detail 供回喂）——内部控制流，不外穿 */
class BadLlmOutput extends Error {
  constructor(detail) {
    super(detail.detail || 'badLlmOutput');
    this.name = 'BadLlmOutput';
    this.detail = detail;
  }
}

/** BadLlmOutput 工厂（detail + raw 头 500 字符供回喂定位） */
function _llmFail(raw, detail) {
  return new BadLlmOutput({
    code: 'badLlmOutput',
    message: 'LLM 输出不是合法的 {"gql","params"} 单 JSON 对象',
    detail,
    raw: String(raw ?? '').slice(0, 500),
  });
}

/** 顶层形状 + 键集合校验：必须为单 JSON 对象且键恰为 gql/params（sorted 后比对，键序无关） */
function _checkShape(parsed, fail) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(`顶层不是 JSON 对象: ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'gql' || keys[1] !== 'params') {
    throw fail(`键集合必须恰为 gql/params，实际: ${keys}`);
  }
}

/** 成员校验：gql 非空字符串；params 为 JSON 对象 */
function _checkMembers(parsed, fail) {
  const { gql, params } = parsed;
  if (typeof gql !== 'string' || !gql.trim()) throw fail('gql 必须为非空字符串');
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw fail('params 必须为 JSON 对象');
  }
  return { gql, params };
}

/** 严格 JSON 解析 + 形状校验（D3）；失败抛 BadLlmOutput（禁正则容错提取） */
function _parseLlmOutput(raw) {
  const fail = (detail) => _llmFail(raw, detail);

  if (typeof raw !== 'string') throw fail(`输出不是字符串: ${typeof raw}`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw fail(`JSON 解析失败: ${(e && e.message) || e}`);
  }
  _checkShape(parsed, fail);
  return _checkMembers(parsed, fail);
}

module.exports = {
  BadLlmOutput,
  _llmFail,
  _checkShape,
  _checkMembers,
  _parseLlmOutput,
};
