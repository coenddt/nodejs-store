'use strict';

/**
 * introspect 共享工具（mysql / postgres 复用，避免复制粘贴式重复）
 *
 * 两后端 `_INDEXES` 查询产出的行形态不同（MySQL `nonUnique` 取反、PG `unique` 直取），
 * 由调用方以 `uniqueOf(row)` 参数化该差异；归并逻辑本身逐行一致，抽为单份实现。
 */

/**
 * 把 `{table,name,column,...}` 索引行按 `(table, name)` 归并出
 * `{table, name, columns, unique}` 数组（`unique` 取 `uniqueOf(row)` 的 0/1）
 */
function groupIndexes(rows, uniqueOf) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.table}::${r.name}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { table: r.table, name: r.name, columns: [], unique: uniqueOf(r) };
      byKey.set(key, entry);
    }
    entry.columns.push(r.column);
  }
  return [...byKey.values()];
}

module.exports = { groupIndexes };
