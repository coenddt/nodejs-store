'use strict';

/**
 * 工作流错误类型（D4-4 零语义拆分自 workflow.js）。
 *
 * - `WorkflowError`：defn 校验失败（白名单外 / 结构非法），文案含 WORKFLOW_UNSUPPORTED 前缀；
 * - `_StepFailure`：步骤失败内部信号（fail 步骤语义失败或步骤执行 Err）——fail-fast + 整体回滚。
 *   构造签名 `(message, index = null)` 与 `this.name = '_StepFailure'` 逐字保留（执行器按
 *   `instanceof` 分流、按 `.index` 定位步骤下标）。
 */

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

module.exports = { WorkflowError, _StepFailure };
