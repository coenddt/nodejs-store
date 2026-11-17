'use strict';

/**
 * 内建 run 表 `__workflowRun` 的定义与自举（D4-4 零语义拆分自 workflow.js）。
 *
 * run 记录落库为内建 schema（铁律 B：运行即数据，用户可用普通 GQL 查询）。schema 定义
 * 的注释（write 显式空名单 / read 缺省跟随全局 / now 为 number）逐字保留——它们记录的是
 * 权限与类型裁决，不是排版。
 */

const {
  has: _hasSchema,
  register: _registerSchema,
} = require('../schema');

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

module.exports = { _BUILTIN_NAME, _RUN_SCHEMA, ensureBuiltin };
