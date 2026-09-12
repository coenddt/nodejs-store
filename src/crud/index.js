'use strict';

/**
 * CRUD 包 —— 薄 Host 适配层（对齐 py-store/src/py_store/crud/ 的分工）
 *
 * 全部纯逻辑（GQL 解析、权限、命令规划、结果后处理）都在 Rust core；
 * 本包只做 Host 三件事：
 *   1. 命令执行（唯一 IO 边界：按 collection 绑定路由到 Mongo / SQL，见 `../datasource`）
 *   2. 占位符替换（{{phase1.ids}} / {{step.<N>._id}} 依赖真实执行结果）
 *   3. 原生回调（asyncFn 计算列两段式：prepareQuery 取 fnRefs → Host await → stripQuery）
 *
 * 不确定性输入由本包供给：now（时钟）、newIds（随机 ID，core 按需消费）。
 *
 * 模块划分：
 *   - [`exec`]：命令执行 + 占位符替换 + core 调用包装（唯一 IO 边界）
 *   - [`id`]：ID 生成与 mutation ID 池遍历
 *   - [`query`]：读路径
 *   - [`write`]：写路径
 *   - [`mutation`]：mutation / upsert / 原生聚合
 */

const { setConnections, _nowFor, _ctx, _call, _exec, _substitute, resolvePlaceholders } = require('./exec');
const { _generateId, _truthy, _newIdPool } = require('./id');
const { query, queryOne, queryWithCount, queryFederated } = require('./query');
const { insert, insertMany, update, updateMany, remove, exists, count } = require('./write');
const { mutation, upsert, aggregate } = require('./mutation');

module.exports = {
  setConnections,
  query,
  queryOne,
  queryWithCount,
  queryFederated,
  insert,
  insertMany,
  update,
  updateMany,
  remove,
  exists,
  count,
  mutation,
  upsert,
  aggregate,
  // ── Host 契约件（供跨语言同构契约测试与高级用法；下划线表示内部语义） ──
  _substitute,
  resolvePlaceholders,
  _generateId,
  _truthy,
  _newIdPool,
  // ── 内部工具（包内共享） ──
  _nowFor,
  _ctx,
  _call,
  _exec,
};
