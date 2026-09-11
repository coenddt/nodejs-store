'use strict';

/**
 * introspection 分派：按后端名把驱动交对应模块，产出统一的规范化行 JSON。
 *
 * 统一输出（交 core `schemaFromRows`）：
 *   `{ tables:[{name}], columns:[{table,name,type,notnull,pk}],
 *      fks:[{table,column,refTable,refColumn}], indexes:[{table,name,columns,unique}] }`
 */

const mysql = require('./mysql');
const postgres = require('./postgres');
const sqlite = require('./sqlite');

const _BACKENDS = { mysql, postgres, sqlite };

/** 按后端名执行 introspection（sqlite 同步、mysql/postgres 异步，统一 await 返回） */
async function run(backend, driver, options) {
  const mod = _BACKENDS[backend];
  if (!mod) throw new Error(`未知 introspection 后端: ${backend}（支持 mysql/postgres/sqlite）`);
  return mod.introspect(driver, options);
}

module.exports = { run, mysql, postgres, sqlite };
