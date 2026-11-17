'use strict';

/**
 * when 守卫：文法解析 + 注册期结构校验 + 执行期判定（D4-4 零语义拆分自 workflow.js）。
 *
 * 文法无歧义：含 exists 键即 op=exists（is 作参数键），其余算子右值键统一 than。
 * 判定口径：exists 走「存在性 vs 期望」双等；is/eq/ne 走 JSON 语义相等；lt/lte/gt/gte
 * 要求双方均为 number（类型不可比显式 Err，不猜）。
 */

const { _WHEN_PARAM } = require('./constants');
const { _StepFailure } = require('./errors');
const { _pyTypeName } = require('./permission-eval');
const { _resolveTree } = require('./placeholder');

/**
 * when → {op, paramKey}；无歧义文法：含 exists 键即 op=exists（is 作参数键），
 * 其余算子的右值键统一 than（is 键已被 exists 参数占用；is/eq 算子同用 than）
 */
function _splitWhen(when) {
  if ('exists' in when) return { op: 'exists', paramKey: 'is' };
  const op = Object.keys(when).find((k) => k in _WHEN_PARAM) || null;
  return op ? { op, paramKey: _WHEN_PARAM[op] } : { op: null, paramKey: null };
}

/** when 守卫结构：恰一个白名单算子键；右操作数参数键按算子定（is/than） */
function _validateWhen(when, errors, where) {
  if (!when || typeof when !== 'object' || Array.isArray(when)) {
    errors.push(`${where}: 须为 JSON 对象`);
    return;
  }
  const { op, paramKey } = _splitWhen(when);
  if (op == null) {
    const ops = Object.keys(when).filter((k) => k in _WHEN_PARAM);
    errors.push(`${where}: 须恰一个白名单算子 ${JSON.stringify(Object.keys(_WHEN_PARAM))}，收到 `
      + `${JSON.stringify(ops.length ? ops : '无')}`);
    return;
  }
  const extra = Object.keys(when).filter((k) => k !== op && k !== paramKey);
  if (extra.length) {
    errors.push(`${where}: 未知参数键 ${JSON.stringify(extra)}（${op} 算子右值键为 "${paramKey}"）`);
  }
  if (op !== 'exists' && !(paramKey in when)) {
    errors.push(`${where}: ${op} 算子缺少右值键 "${paramKey}"`);
  }
}

/** JSON 语义相等：数值互比（NaN 不等），其余须严格同型同值（对齐 1 !== true） */
function _jsonEq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
}

// ─── when 守卫判定 ───────────────────────────────────────────

/** exists 分支：路径存在性断言（is 键缺省 = 断言存在；显式 is null/false → 期望不存在） */
function _evalExists(when, paramKey, left, right) {
  const present = left !== null && left !== undefined;
  const want = paramKey in when
    ? (right !== null && right !== undefined && right !== false)
    : true;
  return present === want;
}

/** when 判定（取值位非 strict：路径取不到 → null 三态，服务 exists/is null 断言） */
function _evalWhen(when, inputMap, ctxMap) {
  const { op, paramKey } = _splitWhen(when);
  const left = _resolveTree(when[op], inputMap, ctxMap, false);
  const right = paramKey in when
    ? _resolveTree(when[paramKey], inputMap, ctxMap, false)
    : null;
  if (op === 'exists') return _evalExists(when, paramKey, left, right);
  if (op === 'is' || op === 'eq') return _jsonEq(left, right);
  if (op === 'ne') return !_jsonEq(left, right);
  // lt / lte / gt / gte：数值比较；类型不可比显式 Err（不猜）
  const cmp = { lt: (x, y) => x < y, lte: (x, y) => x <= y, gt: (x, y) => x > y, gte: (x, y) => x >= y }[op];
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new _StepFailure(
      `when 算子 ${op} 的操作数类型不可比: ${_pyTypeName(left)} vs ${_pyTypeName(right)}`);
  }
  return cmp(left, right);
}

module.exports = { _splitWhen, _validateWhen, _jsonEq, _evalExists, _evalWhen };
