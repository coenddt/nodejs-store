'use strict';

/**
 * defn 静态校验（注册即检查；D4-4 零语义拆分自 workflow.js）。
 *
 * 纯函数、错误全量收集：顶层/步骤字段白名单、op 白名单、必填字段、as 唯一、
 * 占位符前向引用、when 结构、upsert 必带 match、gql 禁占位符（参数化走 params 绑定，
 * 防注入）。顺序与原实现逐字一致：顶层 → 步骤序列（形态 → 字段 → 语义 → 占位符 → 登记 as）。
 */

const { emit: _emitFeedback } = require('../feedback-core');
const {
  _OPS,
  _TOP_FIELDS,
  _STEP_FIELDS,
  _STEP_REQUIRED,
  _OUTER_PH,
  _GQL_PH,
  _NUM_SEG,
  _NUM_LIT,
  _DEC,
  _INPUT,
} = require('./constants');
const { _validateWhen } = require('./when');

// ─── 校验器（注册即静态检查；纯函数，错误全量收集） ──────────────

/** 深扫结构中的全部占位符表达式（外层完整形态，dec 嵌套一并可见），返回 [{inner, whole}] */
function _scanPlaceholders(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(_OUTER_PH)) out.push({ inner: m[0].slice(2, -2), whole: m[0] });
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

/** input.<path> 段：路径非空且不含数组下标段 */
function _checkInputExpr(inner, errors, where) {
  const path = inner.slice(_INPUT.length);
  if (!path || path.split('.').some((s) => _NUM_SEG.test(s))) {
    errors.push(`${where}: 占位符 {{${inner}}} 路径非法`
      + '（首批不支持数组下标段，需要逐行处理请走宿主代码编排）');
  }
}

/** dec:<a>,<b> 段：恰两操作数，各为占位符（递归校验）或数字字面量 */
function _checkDecExpr(inner, definedAs, errors, where) {
  const parts = inner.slice(_DEC.length).split(',');
  if (parts.length !== 2) {
    errors.push(`${where}: 占位符 {{${inner}}} dec 须恰两个操作数 dec:<a>,<b>`);
    return;
  }
  for (const raw of parts) {
    const p = raw.trim();
    if (p.startsWith('{{') && p.endsWith('}}')) {
      _checkExpr(p.slice(2, -2), definedAs, errors, where);
    } else if (!_NUM_LIT.test(p)) {
      errors.push(`${where}: 占位符 {{${inner}}} 操作数 '${p}' 须为占位符或数字字面量`);
    }
  }
}

/** <as>.<path> 段：as 名已定义（前向引用）+ 路径无数组下标段 */
function _checkAsExpr(inner, definedAs, errors, where) {
  const segs = inner.split('.');
  const asName = segs[0];
  if (!asName) {
    errors.push(`${where}: 占位符 {{${inner}}} 缺少 as 名`);
    return;
  }
  if (!definedAs.has(asName)) {
    const avail = [...definedAs].sort();
    errors.push(`${where}: 占位符 {{${inner}}} 引用了不存在的 as "${asName}"`
      + `（前向可用: ${avail.length ? JSON.stringify(avail) : '无'}；后向引用不支持）`);
    return;
  }
  const path = segs.slice(1).join('.');
  if (path.split('.').some((s) => _NUM_SEG.test(s))) {
    errors.push(`${where}: 占位符 {{${inner}}} 路径非法（首批不支持数组下标段）`);
  }
}

/** 校验单个占位符表达式：input.<path> / dec:<a>,<b> / <as>.<path>（前向） */
function _checkExpr(inner, definedAs, errors, where) {
  if (inner.startsWith(_INPUT)) return _checkInputExpr(inner, errors, where);
  if (inner.startsWith(_DEC)) return _checkDecExpr(inner, definedAs, errors, where);
  return _checkAsExpr(inner, definedAs, errors, where);
}

/** read/write/run 白名单形态；空名单按「未配置」放行（旧语义），emit 可定位告警 */
function _checkWhitelists(defn, errors) {
  for (const k of ['read', 'write', 'run']) {
    const v = defn[k];
    if (v != null && (!Array.isArray(v) || !v.every((r) => typeof r === 'string'))) {
      errors.push(`${k} 白名单须为字符串数组`);
    } else if (Array.isArray(v) && v.length === 0) {
      // 空名单按「未配置」放行（旧语义），必须可定位告警，禁止悄悄放宽
      _emitFeedback({
        type: 'warning',
        code: 'workflowWhitelistEmptyAsUnconfigured',
        layer: 'workflow',
        message: `workflow "${defn.name}" 的 ${k} 是空名单，按「未配置」放行（旧语义，避免升级即 403）`,
        hint: '如需显式拒绝读，请改用顶层 denyRead',
      });
    }
  }
}

/** 顶层字段：name 形态、白名单、read/write/run 白名单、denyRead 开关 */
function _checkTopFields(defn, errors) {
  const name = defn.name;
  if (!name || typeof name !== 'string') {
    errors.push('name 必填（非空字符串）');
  } else if (name.startsWith('__')) {
    errors.push(`name "${name}" 以 __ 开头（前缀保留给内建 schema，禁止用于工作流）`);
  }
  for (const k of Object.keys(defn)) {
    if (!_TOP_FIELDS.has(k)) {
      errors.push(`未知顶层字段 "${k}"（白名单: ${JSON.stringify([..._TOP_FIELDS].sort())}）`);
    }
  }
  _checkWhitelists(defn, errors);
  if (defn.denyRead && typeof defn.denyRead !== 'boolean') {
    errors.push('denyRead 须为布尔值（显式拒绝读开关，口径以 core 为准）');
  }
}

/** 步骤形态：对象判定 + op 白名单；失败即告警并返回 null（后续检查跳过） */
function _stepShape(step, where, errors) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    errors.push(`${where}: 步骤须为 JSON 对象`);
    return null;
  }
  const op = step.op;
  if (!_OPS.includes(op)) {
    errors.push(`${where}: WORKFLOW_UNSUPPORTED 未知步骤类型 ${JSON.stringify(op)}`
      + `（首批白名单: ${JSON.stringify(_OPS)}；循环/并行/子工作流/审批节点均不支持）`);
    return null;
  }
  return op;
}

/** 步骤字段白名单与必填字段（按 op 查表） */
function _stepFields(step, where, op, errors) {
  for (const k of Object.keys(step)) {
    if (!_STEP_FIELDS[op].has(k)) {
      errors.push(`${where}: 未知步骤字段 "${k}"（${op} 白名单: `
        + `${JSON.stringify([..._STEP_FIELDS[op]].sort())}）`);
    }
  }
  for (const k of _STEP_REQUIRED[op]) {
    if (step[k] == null || step[k] === '') {
      errors.push(`${where}: ${op} 步骤缺少必填字段 "${k}"`);
    }
  }
}

/** 步骤语义：as 唯一、upsert 必带 match、when 结构 */
function _stepSemantics(step, where, op, definedAs, errors) {
  const asName = step.as;
  if ((op === 'query' || op === 'mutation') && asName && definedAs.has(asName)) {
    errors.push(`${where}: as "${asName}" 重复（引用歧义，禁止覆盖）`);
  }
  if (op === 'mutation' && step.upsert && !step.match) {
    errors.push(`${where}: upsert: true 须提供 match 条件`);
  }
  if (step.when != null) _validateWhen(step.when, errors, `${where}.when`);
}

/** gql 占位符禁用 + 占位符前向引用扫描（gql 除外——已禁） */
function _stepPlaceholders(step, where, op, definedAs, errors) {
  if (op === 'query' && typeof step.gql === 'string' && _GQL_PH.test(step.gql)) {
    errors.push(`${where}: gql 内嵌占位符不支持（注入面）；动态参数请走 params 绑定`);
  }
  const scanPool = {};
  for (const k of Object.keys(step)) {
    if (k !== 'op' && k !== 'gql') scanPool[k] = step[k];
  }
  for (const { inner } of _scanPlaceholders(scanPool)) {
    _checkExpr(inner, definedAs, errors, where);
  }
}

/** 单个步骤校验（顺序与原实现一致：形态 → 字段 → 语义 → 占位符 → 登记 as） */
function _validateStep(step, i, definedAs, errors) {
  const where = `steps[${i}]`;
  const op = _stepShape(step, where, errors);
  if (op == null) return;
  _stepFields(step, where, op, errors);
  // 前向引用集合：不含当前步骤自身的 as（自引用在执行期必然悬空——结果尚不存在）；直接用 definedAs
  _stepSemantics(step, where, op, definedAs, errors);
  _stepPlaceholders(step, where, op, definedAs, errors);
  if ((op === 'query' || op === 'mutation') && step.as) definedAs.add(step.as);
}

/**
 * Workflow defn 静态校验 → 错误列表（空 = 通过）。纯函数，白名单外全量收集。
 *
 * 检查项：顶层/步骤字段白名单、op 白名单、必填字段、as 唯一、占位符前向引用、
 * when 结构（恰一个白名单算子 + 合法参数键）、upsert 必带 match、gql 禁占位符
 * （参数化走 params 绑定，防注入）。
 */
function validateDefn(defn) {
  const errors = [];
  if (!defn || typeof defn !== 'object' || Array.isArray(defn)) return ['defn 须为 JSON 对象'];
  _checkTopFields(defn, errors);
  const steps = defn.steps;
  if (!Array.isArray(steps) || !steps.length) {
    errors.push('steps 必填（非空数组，线性步骤序列）');
    return errors;
  }
  const definedAs = new Set();
  steps.forEach((step, i) => _validateStep(step, i, definedAs, errors));
  return errors;
}

module.exports = {
  _scanPlaceholders,
  _checkInputExpr,
  _checkDecExpr,
  _checkAsExpr,
  _checkExpr,
  _checkWhitelists,
  _checkTopFields,
  _stepShape,
  _stepFields,
  _stepSemantics,
  _stepPlaceholders,
  _validateStep,
  validateDefn,
};
