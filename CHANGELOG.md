# Changelog

## 1.0.0 (2026-09-12)

**破坏性版本**：多数据源定位模型全面重构，消除「静默走错库」的一切可能。
对应方案：`rust-store/.trae/documents/multi-datasource-routing-plan.md`。

### Breaking Changes

1. **命令契约新增定位三元组**：core 产出的每条 Command 均携带
   `source`（连接名，缺省 `"default"`）与 `namespace`（连接内的库/schema 名，
   `null` = 连接默认）。自定义执行器的调用方需适配新字段。
2. **schema 定义新增 `namespace` 字段**（可选字符串）：MongoClient 形态下必须声明
   （= db 名）；PG/MySQL/SQLite 用于声明 schema/database/attached db。
   归档表自动继承 `(source, namespace)`。
3. **Registry 唯一性校验**：`(source, namespace, collection)` 三元组全局唯一，
   冲突注册即抛错（此前按 collection 名反查，存在串源隐患）。
4. **Mongo 连接两种形态严格校验（不猜）**：
   - db 实例：命令 `namespace` 非 null → 显式报错；
   - MongoClient：命令缺 `namespace` → 显式报错（`client.db(ns).collection(...)`）。
5. **删除 collection → source 反查**（`sourceOfCollection`）：路由只按命令自带
   `source` 精确执行。
6. **绑定层 plan 方法签名变更**：`planQuery` / `planMutation` / `planUpdate` 等全部
   新增可选 `route_override` 尾参（见下）。依赖 `rust-store-node` 的代码需同步升版。

### New Features

- **多租户动态路由（routeOverride）**：同一条 GQL / 写请求，按调用传入的
  `{ source, namespace }` override 命令定位，实现「单 schema 定义 × N 租户」，
  注册量不随租户数增长。权限与计算列仍按结构 schema 判定，override 只改定位。
- **SQL 跨 namespace 下推**：同连接跨 schema/db 的 GQL 关联生成
  `"ns_a"."t" JOIN "ns_b"."t"` 原生 SQL（零退化）；仅 Mongo 跨 db 走内存联邦。
- **introspect / syncSchema 支持 `namespace`**：回写 def 的 namespace，与手动声明
  等价；SQLite introspect 支持 attached db 过滤。

### Migration

- 单库用法（`init(db)` + schema 无 `datasource`/`namespace`）行为零变更
  （命令 `source="default"`、`namespace=null`）。
- 多库/多租户：schema 声明 `namespace`，或查询/写入时传 route override。

## 0.1.0

初始版本。
