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
 *
 * D4-4 零语义拆分：本文件保留门面（导出面键名 / 键序逐字不变），实现按域下沉
 *   - ./workflow/constants.js    白名单与占位符文法常量
 *   - ./workflow/errors.js        WorkflowError / _StepFailure
 *   - ./workflow/builtin.js       内建 __workflowRun schema 与 ensureBuiltin
 *   - ./workflow/permission-eval.js  三级白名单判定 + py 类型名对齐
 *   - ./workflow/validate.js      defn 静态校验（validateDefn 族）
 *   - ./workflow/planable.js      注册期「只校验不绑参」可规划性（validatePlanable 族）
 *   - ./workflow/when.js          when 文法解析 + 结构校验 + 执行期判定
 *   - ./workflow/placeholder.js   占位符解析（执行期）
 *   - ./workflow/registry.js      进程内注册表（_workflows 单例）
 *   - ./workflow/steps.js         步骤执行器（预扫 / when 分流 / 线性循环 / 原子包络）
 *   - ./workflow/runner.js        run 生命周期（权限 → running 落库 → 收尾）
 */

const { WorkflowError } = require('./workflow/errors');
const { ensureBuiltin } = require('./workflow/builtin');
const { validateDefn } = require('./workflow/validate');
const { validatePlanable } = require('./workflow/planable');
const {
  _workflows,
  register,
  get,
  list,
} = require('./workflow/registry');
const { run } = require('./workflow/runner');
const { _evaluate, _runWhitelist } = require('./workflow/permission-eval');
const { _evalWhen } = require('./workflow/when');
const { _resolveStr } = require('./workflow/placeholder');

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
