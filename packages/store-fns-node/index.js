'use strict';

/**
 * L2 计算列实现（Node）。导出形状：扁平字典 `{ implName: impl(item, ctx) }`。
 * implName 用 camelCase（§6.1）；与 schema 声明的逻辑 fnRef（默认 `<name>.<key>`）
 * 由宿主经 core::naming 归一后匹配，故此处命名按 Node 习惯即可。
 */
module.exports = {
  // A6：schema `fnRef="Order.total"` ⇒ 此处 `orderTotal` 归一后同为 [order, total]
  orderTotal: (item) => Number(item.qty || 0) * Number(item.price || 0),
};
