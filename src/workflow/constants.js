'use strict';

/**
 * 工作流白名单与占位符文法常量（D4-4 零语义拆分自 workflow.js）。
 *
 * 全部为纯数据：步骤类型白名单、when 算子白名单、defn / 步骤字段白名单与必填字段、
 * 占位符正则与前缀。校验器 / 求值器 / 执行器共用同一份常量，禁止各自复制（口径唯一）。
 */

// ─── 白名单（首批边界；白名单外注册即 Err，不猜测语义） ──────────

// 步骤类型白名单（§4.2）
const _OPS = ['query', 'mutation', 'fail'];
// when 算子白名单（§4.2）→ 右操作数参数键（exists 的参数键 is；is/eq/ne/lte/gt/gte 统一 than）
const _WHEN_PARAM = {
  exists: 'is', is: 'than', eq: 'than',
  ne: 'than', lt: 'than', lte: 'than', gt: 'than', gte: 'than',
};
// defn 顶层字段白名单（§4.1）
const _TOP_FIELDS = new Set(['name', 'steps', 'read', 'write', 'run', 'denyRead', 'description']);
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

module.exports = {
  _OPS,
  _WHEN_PARAM,
  _TOP_FIELDS,
  _STEP_FIELDS,
  _STEP_REQUIRED,
  _FULL_PH,
  _INNER_PH,
  _OUTER_PH,
  _GQL_PH,
  _NUM_SEG,
  _NUM_LIT,
  _DEC,
  _INPUT,
};
