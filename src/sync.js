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
 * @param {string}   [opts.database]          连接内的库名（Mongo/MySQL/SQLite/PG；写入每个 def；缺省 = 连接默认）
 * @param {string}   [opts.schema]            PG schema 名（仅 PG 介质；写入每个 def）
 * @param {boolean}  [opts.registerDefs=true] 是否直接注册（false 时仅返回 defs）
 * @returns {Promise<Array>} 合并后的 schemaJSON 数组
 */
/** 落点注写：datasource / database / schema 逐 def 注写（缺省不动） */
function _applyBind(defs, bind) {
  let out = defs;
  if (bind.datasource) out = out.map((d) => ({ ...d, datasource: bind.datasource }));
  if (bind.database) out = out.map((d) => ({ ...d, database: bind.database }));
  if (bind.schema) out = out.map((d) => ({ ...d, schema: bind.schema }));
  return out;
}

async function syncSchema({
  backend,
  driver,
  introspectOptions,
  overlay = [],
  datasource = null,
  database = null,
  schema = null,
  registerDefs = true,
}) {
  const rows = await introspect.run(backend, driver, introspectOptions);
  let defs = _core.schemaFromRows(rows, backend);
  if (overlay && overlay.length) defs = _core.mergeSchema(defs, overlay);
  defs = _applyBind(defs, { datasource, database, schema });
  if (registerDefs) for (const d of defs) register(d);
  return defs;
}

module.exports = { syncSchema };
