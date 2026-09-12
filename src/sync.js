'use strict';

/**
 * schema 同步：introspect → core.schemaFromRows → core.mergeSchema(overlay) → register
 *
 * 纯编排（无 SQL 拼装、无 schema 推断）：Host 只负责「取物理结构行」与「注册结果」，
 * 映射与合并全在 core（铁律 1/6）。SQL 后端只 pull 结构，**绝不写 DDL 回库**。
 */

const { core: _core, register } = require('./schema');
const introspect = require('./introspect');

/**
 * 同步一个数据源的物理结构到 Registry。
 *
 * @param {object}   opts
 * @param {'mysql'|'postgres'|'sqlite'} opts.backend
 * @param {object}   opts.driver              驱动实例（建议只读账号）
 * @param {object}   [opts.introspectOptions] 透传给 introspection（如 PG 的 `schema`）
 * @param {Array}    [opts.overlay]           本地 overlay schemaJSON（权限/计算列/覆盖）
 * @param {string}   [opts.datasource]        绑定到该 schema 的数据源名（写入每个 def）
 * @param {string}   [opts.namespace]         连接内的库/schema 名（写入每个 def；缺省 = 连接默认）
 * @param {boolean}  [opts.registerDefs=true] 是否直接注册（false 时仅返回 defs）
 * @returns {Promise<Array>} 合并后的 schemaJSON 数组
 */
async function syncSchema({
  backend,
  driver,
  introspectOptions,
  overlay = [],
  datasource = null,
  namespace = null,
  registerDefs = true,
}) {
  const rows = await introspect.run(backend, driver, introspectOptions);
  let defs = _core.schemaFromRows(rows, backend);
  if (overlay && overlay.length) defs = _core.mergeSchema(defs, overlay);
  if (datasource) defs = defs.map((d) => ({ ...d, datasource }));
  if (namespace) defs = defs.map((d) => ({ ...d, namespace }));
  if (registerDefs) for (const d of defs) register(d);
  return defs;
}

module.exports = { syncSchema };
