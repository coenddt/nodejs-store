# 事务型能力

范围：数据层的写入 / 事务边界，重点说明**落点**（跨数据库，以及 PostgreSQL 跨 schema）如何影响原子性。

## 单连接内

- **SQL（MySQL / PostgreSQL / SQLite）** —— 一个连接拥有一个事务。由于一个 MySQL 数据库、
  一个 PostgreSQL 数据库（其下含多个 schema）、一个 SQLite 附加库都是经由**同一条连接**
  访问的，因此同一连接内跨多个数据库（以及 PostgreSQL 跨多个 schema）的写入落在**同一个
  事务**里：整体提交或整体回滚。PostgreSQL 的单个事务可直接访问同库多个 schema；MySQL
  以 `db.table` 访问多个数据库；SQLite 以 `db.table` 访问附加库。
- **MongoDB** —— 多文档 / 跨数据库写入仅在副本集（或分片集群）下具备事务能力。源在运行时
  被探测；standalone 部署或探测失败时操作按原样执行（非原子），并发出一条
  `mongo_transaction_unsupported`（`deployment: standalone|unknown`）反馈事件。

## 跨连接（多数据源）

**没有跨源（分布式）事务** —— 无 2PC、无 Saga。因此跨多条连接的写入：

- 在 API 本身已持有原子作用域时**显式拒绝**（例如 `session` 向 ≥2 个源写入会整体回滚并抛
  `NonAtomicWriteError`）；或
- 在普通写入、无法在不破坏向后兼容的前提下拒绝时**降级并发出反馈事件**（按数据源顺序
  逐个执行，并发出一条 `non_atomic_write` / `nonAtomic` 事件，注明涉及的源）。

无论哪种，非原子边界都被显式声明 —— **绝不静默**。

## 小结

| 写入跨越 | 原子？ | 机制 |
|---|---|---|
| 单条 SQL 连接，跨数据库 / 跨 PG schema | 是 | 该连接上的单事务 |
| 单条 MongoDB 连接（副本集 / 分片） | 是 | 会话事务（运行时探测） |
| 单条 MongoDB 连接（standalone / 探测失败） | 否 | 按原样执行 + `mongo_transaction_unsupported` 事件 |
| 多条连接 | 否 | 显式拒绝（`NonAtomicWriteError`）或降级 + `non_atomic_write` 事件 |
