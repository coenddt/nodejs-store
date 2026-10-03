'use strict';

/**
 * 工作流编排（首批：线性步骤 + when 守卫 + fail-fast）
 *
 * 设计见 `common-store/工作流编排设计文档.md`。两条铁律：
 *   - 铁律 A（定义即数据）：Workflow defn 是与 schema defn 同构的纯 JSON——同注册模式、
 *     同校验文化（白名单外显式 Err，文案含 `WORKFLOW_UNSUPPORTED`）、权限三级白名单内嵌 defn；
 *   - 铁律 B（运行即数据）：run 记录落库为内建 schema `__workflowRun`，用户可用普通 GQL
 *     查询失败/输入/步骤迹——可观测性零新接口。
 *
 * 引擎落在宿主层、core 零改动（执行全是 IO；校验与执行共用同一套步骤语义）。
 * 首批明确不做（检出即 Err，不静默降级）：循环 / 并行 / 子工作流 / 人工审批 / 自动重试 /
 * 自动补偿 / 步骤级宿主回调 / gql 内嵌占位符（参数化请走 params 绑定）/ 数组下标路径。
 * 对齐 `py-store/src/py_store/workflow.py`（双宿主输出逐字节一致由 parity 锚单测守护）。
 */

const {
  core: _core,
  has: _hasSchema,
  register: _registerSchema,
  requireContext: _requireContext,
} = require('./schema');
const crud = require('./crud');
const { emit: _emitFeedback } = require('./feedback');
const { getContext, _als } = require('./permission');
const { _call, sourcesOf: _sourcesOf, runAtomic } = require('./crud/exec');
const { _newIdPool } = require('./crud/id');

// ─── 白名单（首批边界；白名单外注册即 Err，不猜测语义） ──────────

// 步骤类型白名单（§4.2）
const _OPS = ['query', 'mutation', 'fail'];
// when 算子白名单（§4.2）→ 右操作数参数键（exists 的参数键 is；is/eq/ne/lte/gt/gte 统一 than）
const _WHEN_PARAM = {
  exists: 'is', is: 'than', eq: 'than',
  ne: 'than', lt: 'than', lte: 'than', gt: 'than', gte: 'than',
};
// defn 顶层字段白名单（§4.1）
const _TOP_FIELDS = new Set(['name', 'steps', 'read', 'write', 'run', 'description']);
// 步骤字段白名单（按 op；as 语义见 §4.2——query 必填，mutation 可选，fail 无）
const _STEP_FIELDS = {
  query: new Set(['op', 'as', 'gql', 'params', 'when']),
  mutation: new Set(['op', 'as', 'model', 'data', 'match', 'upsert', 'when']),
  fail: new Set(['op', 'message', 'when']),
};
// 步骤必填字段
const _STEP_REQUIRED = { query: ['as', 'gql'], mutation: ['model', 'data'], fail: ['message'] };

// 占位符（§4.3）：整值形态（允许一层嵌套——dec 参数；dec 嵌套 dec 注册即 Err）
const _FULL_PH = /^\{\{(?:[^{}]|\{\{[^{}]*\}\})*\}\}$/;
const _INNER_PH = /\{\{([^{}]*)\}\}/g;
// 外层完整占位符（含一层 dec 嵌套）——校验扫描用：dec 形态错误只有在外层可见时才拦得住
const _OUTER_PH = /\{\{(?:[^{}]|\{\{[^{}]*\}\})*\}\}/g;
const _GQL_PH = /\{\{/;
const _NUM_SEG = /^\d+$/;
const _NUM_LIT = /^-?\d+(\.\d+)?$/;
const _DEC = 'dec:';
const _INPUT = 'input.';

// run 终态状态机（§5）：running → succeeded | failed | rejected；dry-run 终态 drySucceeded | dryFailed
const _BUILTIN_NAME = '__workflowRun';

// 内建 run 表 schema（§5）。write 显式空名单（R2：core 对显式 [] 拒绝一切写，
// super_admin/admin/internal 保留——实测空白名单写被普通角色放行，不收紧则 run 审计
// 可被 GQL 篡改）；read 缺省 = 跟随既有全局语义（可读可观测，铁律 B 自举查询）。
// 模块内部写入走干净 internal 上下文（不含触发者 roles：core 对 guest 硬拒先于
// internal 放行——permission.rs can_write_schema，故不能复用保留 roles 的 runAsInternal）。
// now 为 number（毫秒，与 mutation 的 now 同型同源）——设计文档 §5 写 string，
// 实现按同构语义取 number，留痕见交付说明。
const _RUN_SCHEMA = {
  name: _BUILTIN_NAME,
  system: true,
  collection: _BUILTIN_NAME,
  idPrefix: 'wfrun',
  write: [],
  fields: {
    _id: { type: 'string' },
    workflow: { type: 'string' },
    status: { type: 'string' },
    input: { type: 'object' },
    steps: { type: 'array' },
    error: { type: 'string' },
    stepIndex: { type: 'int' },
    dryRun: { type: 'bool' },
    now: { type: 'number' },
  },
};

/** 注册内建 `__workflowRun` schema（幂等；core 对重复三元组显式报错，故先 has 守卫） */
function ensureBuiltin() {
  if (!_hasSchema(_BUILTIN_NAME)) _registerSchema(_RUN_SCHEMA);
}

// ─── 错误 ────────────────────────────────────────────────────

/** Workflow defn 校验失败（白名单外 / 结构非法）；文案含 WORKFLOW_UNSUPPORTED 前缀 */
class WorkflowError extends Error {}

/** 步骤失败内部信号：fail 步骤语义失败（message）或步骤执行 Err——fail-fast + 整体回滚 */
class _StepFailure extends Error {
  constructor(message, index = null) {
    super(message);
    this.name = '_StepFailure';
    this.index = index;
  }
}

// ─── 权限：三级白名单判定（§0.6；core permission.rs::evaluate 同构，doc=Missing 语义） ──

/** 类型名对齐 py type(v).__name__（错误文案 parity：NoneType/int/float/str/bool/list/dict） */
function _pyTypeName(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'dict';
  return typeof v;
}

/**
 * 角色白名单评估（与 core evaluate 同构；新建 run 无属主文档 → creator 按 Missing 通过）。
 * roleList 传 null（缺省）而非 [] 时同样走「无配置」默认行为（py falsy 统一回退语义）。
 */
function _evaluate(roleList, ctx) {
  const list = roleList ?? null;
  if (!list || list.length === 0) {
    // 空白名单 = 无权限配置 → 默认行为（ctx 缺失放行；internal 放行；guest 拒绝）
    if (ctx == null) return true;
    if (ctx.internal) return true;
    return !(ctx.roles || []).includes('guest');
  }
  if (ctx == null) return true;
  if (ctx.internal) return true;
  const roles = ctx.roles || [];
  if (roles.includes('super_admin') || roles.includes('admin')) return true;
  const effective = roles.length ? roles : [ctx.role];
  if (effective.some((r) => list.includes(r))) return true;
  return list.includes('creator');
}

/** run 白名单：显式声明优先；缺省回退 write（§0.6，falsy 统一回退） */
function _runWhitelist(defn) {
  return defn.run || defn.write || null;
}

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

/** 校验单个占位符表达式：input.<path> / dec:<a>,<b> / <as>.<path>（前向） */
function _checkExpr(inner, definedAs, errors, where) {
  if (inner.startsWith(_INPUT)) {
    const path = inner.slice(_INPUT.length);
    if (!path || path.split('.').some((s) => _NUM_SEG.test(s))) {
      errors.push(`${where}: 占位符 {{${inner}}} 路径非法`
        + '（首批不支持数组下标段，需要逐行处理请走宿主代码编排）');
    }
    return;
  }
  if (inner.startsWith(_DEC)) {
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
    return;
  }
  // <as>.<path>
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
  for (const k of ['read', 'write', 'run']) {
    const v = defn[k];
    if (v != null && (!Array.isArray(v) || !v.every((r) => typeof r === 'string'))) {
      errors.push(`${k} 白名单须为字符串数组`);
    }
  }

  const steps = defn.steps;
  if (!Array.isArray(steps) || !steps.length) {
    errors.push('steps 必填（非空数组，线性步骤序列）');
    return errors;
  }

  const definedAs = new Set();
  steps.forEach((step, i) => {
    const where = `steps[${i}]`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`${where}: 步骤须为 JSON 对象`);
      return;
    }
    const op = step.op;
    if (!_OPS.includes(op)) {
      errors.push(`${where}: WORKFLOW_UNSUPPORTED 未知步骤类型 ${JSON.stringify(op)}`
        + `（首批白名单: ${JSON.stringify(_OPS)}；循环/并行/子工作流/审批节点均不支持）`);
      return;
    }
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
    const asName = step.as;
    if ((op === 'query' || op === 'mutation') && asName && definedAs.has(asName)) {
      errors.push(`${where}: as "${asName}" 重复（引用歧义，禁止覆盖）`);
    }
    // 前向引用集合：不含当前步骤自身的 as（自引用在执行期必然悬空——结果尚不存在）；直接用 definedAs
    if (op === 'mutation' && step.upsert && !step.match) {
      errors.push(`${where}: upsert: true 须提供 match 条件`);
    }
    if (op === 'query' && typeof step.gql === 'string' && _GQL_PH.test(step.gql)) {
      errors.push(`${where}: gql 内嵌占位符不支持（注入面）；动态参数请走 params 绑定`);
    }
    // 占位符前向引用：扫描该步全部占位符字段（gql 除外——已禁）
    const scanPool = {};
    for (const k of Object.keys(step)) {
      if (k !== 'op' && k !== 'gql') scanPool[k] = step[k];
    }
    for (const { inner } of _scanPlaceholders(scanPool)) {
      _checkExpr(inner, definedAs, errors, where);
    }
    // when 结构
    if (step.when != null) _validateWhen(step.when, errors, `${where}.when`);
    if ((op === 'query' || op === 'mutation') && asName) definedAs.add(asName);
  });
  return errors;
}

/**
 * 注册期「只校验不绑参」可规划性校验 → 错误列表（空 = 通过）。纯内存、无 IO、无参数值绑定。
 *
 * ① 结构性可规划：对每个 query 步骤的 gql，调用 core 规划门面 `_core.buildPipeline(gql, {}, null)`
 *    （params 传 {} = 不绑参；ctx 传 null = 不引入调用点上下文）。parse / model / 关系 /
 *    `$pipeline` / 递归深度任一不可规划 → core 抛错，此处汇聚成注册期错误。
 * ② 参数键完整：返回体 `ast` 暴露 `params`（槽位→@key，含嵌套关系，见 core `pipeline/ast.rs`）；
 *    gql 引用的每个 `@key` 须在 step.params 顶层存在——缺键在运行期会被静默丢弃（条件失效）。
 *
 * 与 `validateDefn`（纯函数、只做结构白名单）分职：本函数需要 core 注册表，故独立、不入 validateDefn。
 */
function _collectParamKeys(v, out = new Set()) {
  if (Array.isArray(v)) {
    v.forEach((x) => _collectParamKeys(x, out));
    return out;
  }
  if (v && typeof v === 'object') {
    const p = v.params;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      // core `ast.params` 的值为 `@key` 形态（含前导 @，实测 core parse.rs 保留 ref 原值）；
      // 归一化去掉前导 @，使错误文案为 `@c0` 而非 `@@c0`。
      for (const k of Object.values(p)) {
        if (typeof k === 'string' && k) out.add(k.startsWith('@') ? k.slice(1) : k);
      }
    }
    Object.values(v).forEach((x) => _collectParamKeys(x, out));
  }
  return out;
}

function validatePlanable(defn) {
  const errors = [];
  const steps = defn && Array.isArray(defn.steps) ? defn.steps : null;
  if (!steps) return errors;
  steps.forEach((step, i) => {
    if (!step || step.op !== 'query' || typeof step.gql !== 'string') return;
    const where = `steps[${i}]`;
    let built;
    try {
      built = _core.buildPipeline(step.gql, {}, null);
    } catch (e) {
      errors.push(`${where}: gql 不可规划: ${e && e.message ? e.message : String(e)}`);
      return;
    }
    const p = step.params;
    const provided = new Set(
      p && typeof p === 'object' && !Array.isArray(p) ? Object.keys(p) : [],
    );
    for (const key of [..._collectParamKeys(built && built.ast)].sort()) {
      if (!provided.has(key)) {
        errors.push(`${where}: gql 引用了未提供的参数 @${key}（params 须提供该键）`);
      }
    }
  });
  return errors;
}

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

// ─── 注册表 ──────────────────────────────────────────────────

const _workflows = new Map();

/** 注册工作流定义（注册即静态校验，白名单外显式 Err；name 全局唯一）。
 *
 * `ctx`：可选定义层门禁上下文（`{internal: true}` / `{roles: [...]}`）。判决唯一在 core
 * （`_core.canRegister`，与 schema.register 同一 MetaPolicy）；默认 Open → 全放行。
 * Closed 且 ctx 不过 → 抛 `ERR_PERMISSION:`（定义不写入）。
 *
 * 同名同形重复注册幂等通过（对齐 core schema.register 的复跑语义——场景 harness
 * 每后端复跑同一批用例时必须可重入）；同名异形显式 Err（禁止静默覆盖已注册定义）。
 */
function register(defn, ctx) {
  // 定义层门禁：判决先于静态校验（拒绝即返回，零副作用；与 schema.register_with_ctx 同序）
  if (!_core.canRegister(ctx ?? null)) {
    const name = defn && defn.name ? defn.name : '';
    throw new WorkflowError(`ERR_PERMISSION: 无权注册或覆盖工作流定义 ${name}`);
  }
  const errors = validateDefn(defn);
  if (errors.length) throw new WorkflowError(`WORKFLOW_UNSUPPORTED: ${errors.join('；')}`);
  // B1：注册期「只校验不绑参」可规划性（结构 + 参数键完整）；独立于纯函数 validateDefn
  const planErrors = validatePlanable(defn);
  if (planErrors.length) {
    throw new WorkflowError(`WORKFLOW_UNSUPPORTED: ${planErrors.join('；')}`);
  }
  const name = defn.name;
  if (_workflows.has(name)) {
    if (_workflows.get(name) === defn) return defn;
    throw new WorkflowError(
      `WORKFLOW_UNSUPPORTED: Workflow 已注册且定义不同，禁止覆盖: ${name}`);
  }
  _workflows.set(name, defn);
  return defn;
}

/** 按名取 defn（read 白名单过滤；不可见与不存在同形——防枚举） */
function get(name, ctx = undefined) {
  const d = _workflows.get(name);
  if (!d) throw new Error(`Workflow 未注册: ${name}`);
  const c = ctx === undefined ? getContext() ?? null : ctx;
  if (!_evaluate(d.read ?? null, c)) throw new Error(`Workflow 未注册: ${name}`);
  return d;
}

/** 全部可见工作流名（read 白名单过滤） */
function list(ctx = undefined) {
  const c = ctx === undefined ? getContext() ?? null : ctx;
  return [..._workflows.values()]
    .filter((d) => _evaluate(d.read ?? null, c))
    .map((d) => d.name);
}

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

/** JSON 语义相等：数值互比（NaN 不等），其余须严格同型同值（对齐 1 !== true） */
function _jsonEq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
}

// ─── when 守卫判定 ───────────────────────────────────────────

/** when 判定（取值位非 strict：路径取不到 → null 三态，服务 exists/is null 断言） */
function _evalWhen(when, inputMap, ctxMap) {
  const { op, paramKey } = _splitWhen(when);
  const left = _resolveTree(when[op], inputMap, ctxMap, false);
  const right = paramKey in when
    ? _resolveTree(when[paramKey], inputMap, ctxMap, false)
    : null;
  if (op === 'exists') {
    const present = left !== null && left !== undefined;
    // is 键缺省 = 断言存在；显式 is（null/false → 期望不存在，其余 → 期望存在）
    const want = paramKey in when
      ? (right !== null && right !== undefined && right !== false)
      : true;
    return present === want;
  }
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

// ─── 执行器（线性步骤循环 + fail-fast；§2 生命线） ─────────────

/**
 * 预扫全部 mutation 步骤的数据源集合（run 级原子包络依据；plan 是纯函数不执行）。
 * 返回 null = 预扫失败 → 降级裸跑（单步骤内原子，emit 反馈事件，禁静默）。
 * 占位符原样参与规划（plan 只看结构键，不校验占位符字符串值——实测）。
 */
function _prescanSources(defn, routeOverride, now, ctx) {
  const sources = new Set();
  for (const step of defn.steps) {
    if (step.op !== 'mutation') continue;
    try {
      const pool = _newIdPool(step.model, step.data);
      const plan = _call(() => _core.planMutation(step.model, step.data, now, pool, ctx, routeOverride));
      for (const s of _sourcesOf(plan)) sources.add(s || 'default');
    } catch (e) {
      // 预扫失败降级裸跑（显式声明，禁静默）
      _emitFeedback({
        type: 'workflow_prescan_failed',
        code: 'workflowPrescanFailed',
        layer: 'workflow',
        message: `run 源预扫失败（步骤 model=${step.model}）：${e && e.message ? e.message : e}；`
          + '本 run 降级裸跑（跨步骤非原子，单步骤内仍原子）',
        hint: '检查该 mutation 步骤的 model/结构是否可规划；预扫仅提取数据源，不影响执行',
      });
      return null;
    }
  }
  return sources;
}

/** 多源 run：无法原子 → 程序化声明（允许顺序执行，禁止静默；对齐 non_atomic_write 语义） */
function _warnNonAtomic(sources) {
  const listed = [...sources].sort();
  _emitFeedback({
    type: 'workflow_non_atomic',
    code: 'workflowNonAtomic',
    layer: 'workflow',
    message: `本 run 的写步骤跨 ${listed.length} 个数据源（${listed.join(', ')}）：`
      + '无法原子，按顺序执行（跨步骤非原子）',
    hint: '把写步骤收敛到单一数据源；跨源强一致首批请拆为宿主代码编排',
    sources: listed,
  });
}

/** 执行单步骤（when 已判定通过）：query / mutation / fail */
async function _execStep(step, inputMap, ctxMap, routeOverride, index) {
  const op = step.op;
  if (op === 'query') {
    const params = _resolveTree(step.params ?? null, inputMap, ctxMap, true);
    const rows = await crud.query(step.gql, params, routeOverride);
    if (rows.length > 1) {
      throw new _StepFailure(
        `query 步骤 "${step.as}" 返回 ${rows.length} 行（期望 ≤1：占位符引用要求唯一结果；`
        + '请收紧条件或加 $limit:1）', index);
    }
    return rows.length ? rows[0] : null;
  }
  if (op === 'mutation') {
    const data = _resolveTree(step.data, inputMap, ctxMap, true);
    if (step.upsert) {
      const match = _resolveTree(step.match, inputMap, ctxMap, true);
      return crud.upsert(step.model, match, data, null, routeOverride);
    }
    return crud.mutation(step.model, data, routeOverride);
  }
  // fail：显式业务断言失败（§4.2）——message 支持内嵌占位符丰富错误文案
  throw new _StepFailure(_resolveStr(step.message, inputMap, ctxMap, true), index);
}

/**
 * 线性步骤循环：迹与 defn.steps 一一对应（skipped/wouldRun/ran/failed 均留痕）。
 * 失败抛 _StepFailure（带步骤下标）——外层收尾统一落 failed 终态 + 整体回滚。
 */
async function _runSteps(defn, inputMap, ctxMap, trace, dry, routeOverride) {
  for (const [i, step] of defn.steps.entries()) {
    const op = step.op;
    const asName = step.as ?? null;
    // a. when 判定 → 不满足记 skipped（显式留痕，绝不静默跳过），后续步骤照常
    const when = step.when;
    let ok = true;
    if (when != null) {
      try {
        ok = _evalWhen(when, inputMap, ctxMap);
      } catch (e) {
        if (!(e instanceof _StepFailure)) throw e;
        trace.push({ as: asName, op, state: 'failed', error: String(e.message) });
        e.index = i;
        throw e;
      }
    }
    if (!ok) {
      trace.push({ as: asName, op, state: 'skipped' });
      continue;
    }
    // b. dry-run：mutation / fail 不执行，记 wouldRun（§0.7）
    if (dry && (op === 'mutation' || op === 'fail')) {
      trace.push({ as: asName, op, state: 'wouldRun' });
      continue;
    }
    // c/d. 解析占位符（步骤内）→ 执行 → 结果按 as 入上下文 → 迹追加
    const entry = { as: asName, op, state: 'ran' };
    let result;
    try {
      result = await _execStep(step, inputMap, ctxMap, routeOverride, i);
    } catch (e) {
      if (e instanceof _StepFailure) {
        trace.push({ ...entry, state: 'failed', error: String(e.message) });
        if (e.index == null) e.index = i;
        throw e;
      }
      const msg = `步骤 ${i}（${op}）执行失败: ${e && e.message ? e.message : e}`;
      trace.push({ ...entry, state: 'failed', error: msg });
      throw new _StepFailure(msg, i);
    }
    if (asName) ctxMap[asName] = result;
    entry.result = result;
    trace.push(entry);
  }
}

/**
 * 干净 internal 上下文（{internal: true}，丢弃触发者 roles）
 *
 * 不用 permission.runAsInternal：它保留原 roles，而 core 对 guest **硬拒写**先于
 * internal 放行（permission.rs::can_write_schema）——guest 触发的 rejected 落库会
 * 被自己的 guest 角色挡住。审计通道的身份必须与触发者权限解耦。
 */
async function _runInternal(fn) {
  return _als.run({ internal: true }, fn);
}

/** run 记录写入（internal 上下文——__workflowRun write 显式空名单仅放行 internal/admin） */
async function _persistWrite(doc) {
  return _runInternal(() => crud.mutation(_BUILTIN_NAME, doc));
}

/** run 记录收尾更新（事务外独立提交：业务事务回滚不影响失败 run 可查——铁律 B） */
async function _persistUpdate(rid, patch) {
  return _runInternal(() => crud.update(_BUILTIN_NAME, { _id: rid }, patch));
}

/** 内存 run 文档补落库元数据（_id / createdAt / updatedAt） */
function _withMeta(runDoc, saved) {
  return {
    ...runDoc,
    _id: saved ? saved._id ?? null : null,
    createdAt: saved ? saved.createdAt ?? null : null,
    updatedAt: saved ? saved.updatedAt ?? null : null,
  };
}

/**
 * 触发工作流 → 完整 run 文档（§3）
 *
 * 统一契约：执行期一切业务失败（步骤 Err / fail 步骤 / 权限拒绝）都表达为 run 终态
 * （failed / rejected）+ error 字段返回，不抛异常；编程错误（未注册 / input 非法 /
 * defn 校验失败）照常抛错。dry-run 下 query 真实执行（只读安全），mutation/fail 记
 * wouldRun。跨步骤原子性：单源 run 整体原子（N1 实测可行——外层 runAtomic 包住整个
 * 步骤循环，内层 mutation 嵌套并入）；多源 / 预扫失败按顺序执行并发反馈事件（禁静默）。
 * run 记录时序（§2 生命线）：先落 running（独立提交，进程崩溃可见）→ 步骤事务 →
 * 收尾 update 终态（事务外独立提交——业务回滚不影响失败 run 可查，铁律 B）。
 */
async function run(name, input = null, { dryRun = false, routeOverride = null } = {}) {
  ensureBuiltin();
  const d = _workflows.get(name);
  if (!d) throw new Error(`Workflow 未注册: ${name}`);
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new TypeError(`run(name, input) 的 input 须为 dict，收到 ${typeof input}`);
  }
  const inp = { ...(input || {}) };
  const ctx = getContext() ?? null;
  const now = Date.now();
  const dry = Boolean(dryRun);

  const runDoc = {
    workflow: name, status: 'running', input: inp, steps: [],
    error: null, stepIndex: null, dryRun: dry, now,
  };

  // 1. 权限（§0.6）：fail-secure 优先于 dry-run（N3 实测裁决）——require_context 开启
  //    且无 ctx → rejected 拒跑；run 白名单外 → rejected（落库可审计，一次落终态）
  const require = _requireContext();
  let rejected = null;
  if (require && ctx == null) {
    rejected = 'ERR_NO_CONTEXT: 上下文强制开启，无 ctx 拒跑（fail-secure 优先于 dry-run）';
  } else if (!_evaluate(_runWhitelist(d), ctx)) {
    rejected = `run 白名单拦截: 触发者角色不在 run 白名单内（${JSON.stringify(_runWhitelist(d) || [])}）`;
  }
  if (rejected !== null) {
    runDoc.status = 'rejected';
    runDoc.error = rejected;
    const saved = await _persistWrite(runDoc);
    return _withMeta(runDoc, saved);
  }

  // 2. 状态落库 running（先于步骤：中断可观测）
  const saved = await _persistWrite(runDoc);
  const rid = saved ? saved._id ?? null : null;

  // 3. 步骤循环（单源时整体原子；失败 _StepFailure 冒泡出事务 → 整体回滚）
  const trace = runDoc.steps;
  const ctxMap = Object.create(null);
  const _execute = () => _runSteps(d, inp, ctxMap, trace, dry, routeOverride);

  let status = dry ? 'drySucceeded' : 'succeeded';
  let error = null;
  let stepIndex = null;
  try {
    if (!dry) {
      const sources = _prescanSources(d, routeOverride, now, ctx);
      if (sources !== null && sources.size === 1) {
        await runAtomic(sources, _execute);
      } else {
        if (sources !== null && sources.size > 1) _warnNonAtomic(sources);
        await _execute();
      }
    } else {
      await _execute();
    }
  } catch (e) {
    if (!(e instanceof _StepFailure)) throw e;
    status = dry ? 'dryFailed' : 'failed';
    error = String(e.message);
    stepIndex = e.index;
  }
  // 4. 收尾终态（事务外独立提交）
  runDoc.status = status;
  runDoc.error = error;
  runDoc.stepIndex = stepIndex;
  await _persistUpdate(rid, { status, steps: trace, error, stepIndex });
  return _withMeta(runDoc, saved);
}

// 模块加载即自举内建 run 表（幂等；零配置——require 即可 run）
ensureBuiltin();

module.exports = {
  WorkflowError,
  ensureBuiltin,
  validateDefn,
  validatePlanable,
  register,
  get,
  list,
  run,
  // parity 锚与单测用的内部件（下划线内部语义；对齐 py wf._workflows/_run_whitelist 可达性）
  _workflows,
  _runWhitelist,
  _evaluate,
  _evalWhen,
  _resolveStr,
};
