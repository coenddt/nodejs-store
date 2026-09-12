'use strict';

/**
 * SQLite introspection（驱动：better-sqlite3）
 *
 * 只发 `sqlite_master` / `PRAGMA` 只读查询（铁律 6：绝不写 DDL 回库），产出规范化
 * 行 JSON，交 core `schemaFromRows` 做纯映射（本模块不做任何 schema 推断）。
 *
 * 返回：`{ tables, columns, fks, indexes }`（见 `dialect/introspect.rs` 的输入约定）。
 */

/** PRAGMA 不支持参数化，需内联表名；标识符来自 sqlite_master（非用户输入），并做引号转义 */
function _quote(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function introspect(db, { database = null } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('sqlite introspection 需要 better-sqlite3 Database 实例');
  }
  const tables = [];
  const columns = [];
  const fks = [];
  const indexes = [];

  // attached db 过滤：PRAGMA database_list 校验库名存在（main/temp/ATTACH 的库名），
  // 表清单改从 `<db>.sqlite_master` 读取；显式库名作为 namespace 透出到 def。
  let masterFrom = 'sqlite_master';
  if (database != null) {
    const known = db.prepare('PRAGMA database_list').all().some((r) => r.name === database);
    if (!known) {
      const names = db.prepare('PRAGMA database_list').all().map((r) => r.name).join(', ');
      throw new Error(`SQLite attached db 不存在: ${database}（当前 attached: ${names}）`);
    }
    masterFrom = `${_quote(database)}.sqlite_master`;
  }

  const tableRows = db
    .prepare(`SELECT name FROM ${masterFrom} WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();

  for (const { name } of tableRows) {
    tables.push(database != null ? { name, namespace: database } : { name });

    for (const c of db.prepare(`PRAGMA table_info(${_quote(name)})`).all()) {
      columns.push({
        table: name,
        name: c.name,
        type: c.type || '',
        notnull: c.notnull ? 1 : 0,
        pk: c.pk ? 1 : 0,
      });
    }

    for (const f of db.prepare(`PRAGMA foreign_key_list(${_quote(name)})`).all()) {
      fks.push({
        table: name,
        column: f.from,
        refTable: f.table,
        refColumn: f.to || '_id',
      });
    }

    for (const idx of db.prepare(`PRAGMA index_list(${_quote(name)})`).all()) {
      if (idx.origin === 'pk') continue; // 主键索引不重复登记
      const info = db.prepare(`PRAGMA index_info(${_quote(idx.name)})`).all();
      indexes.push({
        table: name,
        name: idx.name,
        columns: info.map((i) => i.name),
        unique: idx.unique ? 1 : 0,
      });
    }
  }

  return { tables, columns, fks, indexes };
}

module.exports = { introspect };
