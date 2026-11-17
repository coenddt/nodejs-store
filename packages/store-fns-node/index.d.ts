/**
 * store-fns-node 类型声明（手写，与 index.js 的 module.exports 一一对应）。
 *
 * 口径：记录与上下文由宿主 / schema 决定形状，故 item / ctx 用 any；
 * 导出是扁平字典 `{ implName: impl }` —— implName 与 schema 的 fnRef
 * 由宿主经 core::naming 归一后匹配（§6.1）。
 */

/** L2 计算列实现：item 为记录，ctx 为宿主注入的可选上下文 */
export type ComputedImpl = (item: any, ctx?: any) => any

/** 示例实现：Order.total（schema fnRef="Order.total" 归一后匹配） */
export declare const orderTotal: ComputedImpl
