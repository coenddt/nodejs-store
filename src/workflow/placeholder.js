'use strict';

/**
 * 占位符解析（§4.3，执行期；D4-4 零语义拆分自 workflow.js）。
 *
 * 文法唯一在 validate.js 校验、此处求值：整值形态保类型替换、内嵌形态字符串化拼接、
 * dec 递减、点路径取值。strict（参数位）取不到显式 Err；非 strict（when 取值位）→ null
 * 三态（exists/is null 断言依赖三态）。
 */

const { _FULL_PH, _INNER_PH, _DEC, _INPUT } = require('./constants');
const { _StepFailure } = require('./errors');
const { _pyTypeName } = require('./permission-eval');

// ─── 占位符解析（§4.3；执行期） ───────────────────────────────

/** 点路径取值；strict（参数位）取不到显式 Err，非 strict（when 取值位）→ null（三态） */
function _dig(root, path, strict, whole) {
  let cur = root;
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && seg in cur) {
      cur = cur[seg];
    } else {
      if (strict) throw new _StepFailure(`占位符 ${whole} 解析失败: 路径 "${path}" 不存在`);
      return null;
    }
  }
  return cur;
}

/** 解析单个占位符表达式为值（dec 递减；类型不合法显式 Err，不猜） */
function _resolveExpr(inner, inputMap, ctxMap, strict, whole) {
  if (inner.startsWith(_INPUT)) {
    return _dig(inputMap, inner.slice(_INPUT.length), strict, whole);
  }
  if (inner.startsWith(_DEC)) {
    const parts = inner.slice(_DEC.length).split(',');
    const vals = parts.map((raw) => {
      const p = raw.trim();
      if (p.startsWith('{{') && p.endsWith('}}')) {
        return _resolveExpr(p.slice(2, -2), inputMap, ctxMap, strict, p);
      }
      return Number(p);
    });
    const [a, b] = vals;
    vals.forEach((v, i) => {
      if (typeof v !== 'number' || Number.isNaN(v)) {
        throw new _StepFailure(
          `占位符 ${whole} dec 操作数 ${i === 0 ? 'a' : 'b'} 须为数值，收到 ${_pyTypeName(v)}`);
      }
    });
    return a - b;
  }
  const segs = inner.split('.');
  const asName = segs[0];
  const path = segs.slice(1).join('.');
  if (!(asName in ctxMap)) {
    if (strict) {
      throw new _StepFailure(`占位符 ${whole} 引用的 as "${asName}" 无可用结果`
        + '（该步骤可能被 when 跳过或尚未执行）');
    }
    return null;
  }
  return _dig(ctxMap[asName], path, strict, whole);
}

/** 内嵌占位符值的字符串化（仅标量；null/复杂结构显式 Err，禁静默拼 'null'） */
function _stringify(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  throw new _StepFailure(`内嵌占位符仅支持标量值，收到 ${_pyTypeName(v)}`);
}

/** 字符串中的占位符：整值形态 → 保类型替换；内嵌形态 → 字符串化拼接 */
function _resolveStr(s, inputMap, ctxMap, strict) {
  if (_FULL_PH.test(s)) {
    return _resolveExpr(s.slice(2, -2).trim(), inputMap, ctxMap, strict, s);
  }
  if (s.includes('{{')) {
    return s.replace(_INNER_PH, (m, inner) => _stringify(_resolveExpr(inner, inputMap, ctxMap, strict, m)));
  }
  return s;
}

/** 深度替换结构中的占位符（object/array 递归；非字符串原样保留） */
function _resolveTree(value, inputMap, ctxMap, strict) {
  if (typeof value === 'string') return _resolveStr(value, inputMap, ctxMap, strict);
  if (Array.isArray(value)) return value.map((v) => _resolveTree(v, inputMap, ctxMap, strict));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _resolveTree(value[k], inputMap, ctxMap, strict);
    return out;
  }
  return value;
}

module.exports = { _dig, _resolveExpr, _stringify, _resolveStr, _resolveTree };
