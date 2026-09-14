# nodejs-store

**面向 MongoDB、MySQL、SQLite 与 PostgreSQL 的统一数据层 —— 用纯 JSON 定义模型，用 MongoDB 风格的 GQL 树语法查询，开箱即得基于角色的访问控制、计算列与软删除。**

![npm version](https://img.shields.io/npm/v/nodejs-store)
![license](https://img.shields.io/npm/l/nodejs-store)
![node](https://img.shields.io/node/v/nodejs-store)
![backends](https://img.shields.io/badge/backends-MongoDB%20%7C%20MySQL%20%7C%20SQLite%20%7C%20PostgreSQL-blue)
![query dialect](https://img.shields.io/badge/query%20dialect-GQL%20(MongoDB--flavoured)-green)

> English docs: [README.md](README.md)

`nodejs-store` 让 Node.js 服务通过**单一 schema 定义、单一查询方言**同时对接 MongoDB（原生聚合）、MySQL、PostgreSQL 与 SQLite。嵌套关系会编译为**每个后端一条原生查询** —— 你永远不必手写 `$lookup` 或原生 SQL。

> 也在找 Python 版本？见 [`py-store`](https://github.com/coenddt/py-store)（pip 包 `storepy`）。两者都是共享 Rust 引擎 [`rust-store`](https://github.com/coenddt/rust-store) 之上的薄宿主。

---

## 目录

- [它是什么](#它是什么)
- [什么时候该用它](#什么时候该用它)
- [什么时候不该用它](#什么时候不该用它)
- [与同类方案的对比](#与同类方案的对比)
- [安装](#安装)
- [快速开始](#快速开始)
- [支持的后端](#支持的后端)
- [特性](#特性)
- [GQL 树查询](#gql-语法)
- [聚合](#聚合)
- [查询与写入 API](#查询与写入-api)
- [多数据源连接](#多数据源连接)
- [权限上下文](#权限上下文)
- [Schema 参考](#schema-参考)
- [高级 API](#高级-api)
- [事务边界](#事务边界)
- [常见问题](#常见问题)
- [相关项目](#相关项目)

---

## 它是什么

面向 Node.js 的轻量级、后端无关的数据层。你只需用纯 JSON 描述一次模型（`fields`、`relations`、`computes`、`indexes`、`read`/`write` 角色白名单）。库会据此推导出：

- **命令规划**（GQL → Mongo 命令 JSON）—— 由 Rust 核心 `rust-store-node` 执行，
- **方言翻译**（命令 JSON → 参数化 SQL），面向 MySQL / PostgreSQL / SQLite，
- **权限校验**（schema 级 + 字段级读写、属主条件注入），
- **计算列**、**软删除归档**，以及**结果还原**（扁平 JOIN 行 → 嵌套文档）。

MongoDB 是*主方言*：查询以 MongoDB 风格的 GQL 编写，三种关系型后端向它适配。这正是让同一份 schema 可同时运行在文档库与三种关系库上的原因。

### 与 py-store、rust-store 的关系

```
                 ┌──────────────────────────────┐
   Node.js  ──▶  │  nodejs-store (npm, host)    │ -┐
                 └──────────────────────────────┘  │  rust-store-node (napi-rs)
                                                   ▼
                                     ┌───────────────────────────────┐
                                     │ rust-store/core (pure logic)  │
                                     │ GQL · permissions · computes  │
                                     │ command planning · dialects   │
                                     └───────────────────────────────┘
                                                   ▲
                 ┌──────────────────────────────┐  │  rust-store-py (PyO3)
   Python   ──▶  │  py-store (pip, host)        │ -┘
                 └──────────────────────────────┘
```

**Rust 核心**负责 GQL 解析、权限校验、计算列、命令规划与 SQL 方言翻译 —— 它从不接触数据库。**宿主**（`nodejs-store`、`py-store`）负责驱动 IO、回调与占位符替换。因此 Node.js 与 Python 之间不会出现行为漂移：只有一份实现。

## 什么时候该用它

当以下任一情形符合你的处境时，就该用 `nodejs-store`：

- **一套代码，多个数据库。** 同一服务在开发环境跑 MongoDB、生产环境（或按租户）跑 PostgreSQL，而你不想维护两套数据访问层。
- **需要嵌套/关系读取，却不想写 `$lookup` 或 JOIN。** Order → items、Course → lessons、User → orders —— 都只在 schema 中声明一次，并在单条查询内解析。
- **正在构建管理后台或内部 CRUD 服务**，想要 schema 驱动的 CRUD、软删除、计算列与角色校验，而不引入完整 ORM。
- **需要行级/字段级访问控制。** 按角色的白名单、`guest` 永不写、`creator` 依据 `doc.createdBy` 校验属主，属主条件会自动注入查询。
- **正在构建 AI/自然语言数据问答层。** 本库在设计时就考虑了 AI 查询宿主：`buildPipeline()` 可在不执行的情况下暴露规划后的查询，降级/不可下推路径会发出结构化反馈事件而非静默失败。参见配套技能 [`text-to-query`](#相关项目)。
- **正在 MongoDB 与 SQL 之间迁移**，并希望在迁移期保持一套查询语法。
- **多租户 SaaS。** 一份 schema 定义，N 个租户：把 schema 绑定到 `(source, namespace, collection)`，并在执行时用 `{ source, namespace }` 覆盖把任意查询/写入重新定向到目标租户。

典型的具体场景（完整演练见 [`doc/use-cases/`](doc/use-cases/)）：

| 场景 | nodejs-store 为何合适 |
| --- | --- |
| 每租户独立 schema/数据库的多租户 SaaS | 每租户一个 `namespace` + 运行时路由覆盖，一套 schema |
| 管理后台 / 内部工具 | schema 驱动 CRUD、软删除、计算列、RBAC |
| 今天 MongoDB，明天 PostgreSQL | 同一 GQL + 同一 schema，只有数据源变化 |
| AI 数据问答 / text-to-query 智能体 | 仅规划的 `buildPipeline`、确定性的命令 JSON、反馈事件 |
| 同一产品中混用 SQL + Mongo | 跨源查询，SQL 原生下推、Mongo 走内存联邦 |
| 审计友好的 CRUD | 每个 schema 自动获得一个 `<Model>Deleted` 归档表/集合 |

## 什么时候不该用它

明确边界能为你省下时间：

- **你想要带迁移引擎的完整 ORM。** `nodejs-store` 是*数据层*，不是迁移工具。它可以**读取** SQL 后端的物理结构（`syncSchema` → introspection），但从不把 DDL 写回。请与你自选的迁移工具搭配使用。
- **你需要带类型安全、自动生成的客户端。** schema 是运行时 JSON，而非 TypeScript 类型。你获得的是灵活性与跨语言一致性（同一份 schema 在 Node 与 Python 中都可用），而不是编译期类型推断。
- **你只用一种数据库，且几乎不做关联。** 直接用裸驱动（或只针对单一数据库的 ODM/ORM）会更简单。
- **你需要原生聚合逃生舱。** `$pipeline` 透传与 `store.aggregate()` 已被有意移除。请使用 `$condition` / `$group` / `$having` / 关系；任何无法安全翻译的内容都会**显式**失败，而不会静默降级。
- **你在 SQLite 的高并发热路径上。** SQLite 执行器按设计使用同步的 `better-sqlite3` 驱动 —— 调用会阻塞事件循环。此类场景请优先使用 MySQL / PostgreSQL / MongoDB，或把 SQLite 隔离到独立进程。

## 与同类方案的对比

以下为总体定位，并非基准测试 —— 请始终以各工具当前文档为准。

| | nodejs-store | Mongoose | Prisma | TypeORM / Sequelize | Drizzle |
| --- | --- | --- | --- | --- | --- |
| 主要形态 | JSON schema + GQL 数据层 | ODM（MongoDB） | Schema DSL + 生成的客户端 | 装饰器/实体 ORM | TypeScript SQL 构建器 |
| 后端 | MongoDB、MySQL、SQLite、PostgreSQL | MongoDB | PostgreSQL、MySQL、SQLite、SQL Server、MongoDB、CockroachDB | MySQL、PostgreSQL、SQLite、MSSQL、Oracle（+ MongoDB） | PostgreSQL、MySQL、SQLite、… |
| 跨 Mongo **与** SQL 的统一查询方言 | ✅（MongoDB 风格 GQL） | ➖（仅 Mongo） | ➖（每个 provider 一个客户端） | ⚠️（Mongo 模型与 SQL 实体不同） | ➖（仅 SQL） |
| 单条查询内的嵌套关系读取 | ✅ 声明式 relations → `$lookup` / `JOIN` | ✅ `populate()` | ✅ `include` | ✅ relations | ⚠️ 手动 join |
| 内置角色 / 字段级 RBAC + 属主注入 | ✅ | ➖ | ➖（通过扩展） | ➖ | ➖ |
| 读时计算列（同步 / 异步 / 关系聚合） | ✅ | ➖（getter） | ➖ | ➖ | ➖ |
| 自动置备软删除归档表 | ✅ | ➖ | ➖ | ➖ | ➖ |
| 迁移 / DDL 引擎 | ➖（introspection 只读） | ➖ | ✅ | ✅ | ✅ |
| 静态类型生成 | ➖（运行时 JSON，跨语言一致） | ➖ | ✅ | ⚠️（装饰器 + TS） | ✅ |
| Node 与 Python 共享原生核心 | ✅（Rust `rust-store`） | ➖ | ➖ | ➖ | ➖ |

### 与具体库的差异

仅为定位说明，基于撰写时这些项目的公开文档 —— 请以你自己的需求为准进行核实。

- **vs Mongoose** —— Mongoose 仅支持 MongoDB。`nodejs-store` 使用类似的 MongoDB 风格查询语法（`$gt`、`$or`、`$set`、`$inc`），但同一条查询也能原样跑在 MySQL、SQLite 与 PostgreSQL 上。
- **vs `mongoosql-core`** —— 精神上最接近：它同样能在 MongoDB、PostgreSQL 与 MySQL 上运行 Mongoose 风格的查询。`nodejs-store` 还额外面向 SQLite，内置 schema 级权限（角色/字段白名单，外加 `creator` 属主条件注入）、读时计算列（`fn` / `asyncFn` / 关系 `agg`）、自动置备的 `<Model>Deleted` 软删除归档，并与 Python 宿主共享同一个 Rust 引擎，因此 Node.js 与 Python 不会产生漂移。
- **vs `unsql`** —— `unsql` 从普通 JavaScript 对象为 MySQL、PostgreSQL 与 SQLite 生成 SQL。它不面向 MongoDB，且只是一个查询/CRUD 辅助工具，而非带权限与计算列的 schema 驱动数据层。
- **vs Prisma** —— Prisma 是 schema DSL 加生成的客户端，配有迁移引擎与编译期类型。`nodejs-store` 是运行时 JSON schema，不承担 DDL 或迁移职责（仅通过 introspection *读取*物理结构），也不生成类型 —— 以此换取一套横跨文档库与三种关系库的查询方言。
- **vs TypeORM / Sequelize / Drizzle** —— Sequelize 与 Drizzle 仅支持 SQL；TypeORM 把 MongoDB 与其 SQL 实体分开建模。`nodejs-store` 以 MongoDB 为主方言，并把同一份 GQL 编译为其余三种后端的 SQL。

一句话：想要**编译期类型与迁移**就用 ORM；想要**一份运行时 schema + 一套横跨 MongoDB 与 SQL 的查询方言**，并内置 RBAC 与计算列，就用 `nodejs-store`。

## 安装

```bash
npm install nodejs-store
```

需要 Node.js 18+，以及一个受支持的后端（MongoDB / MySQL / SQLite / PostgreSQL）。

## 快速开始

```js
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();
await init(client.db('mydb')); // 幂等地为已注册的 schema 创建索引

// 注册 schema（纯 JSON）
store.register({
  name: 'Post',          // GQL 中使用的模型名
  collection: 'posts',   // 可选，默认等于 name
  idPrefix: 'PT',        // 字符串 _id：前缀 + base36 时间戳 + 随机串
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    tags: { type: 'array', default: [] },
  },
  computes: {
    statusLabel: {
      type: 'string',
      depends: ['status'],
      fn: (doc) => (doc.status || '').toUpperCase(),
    },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

// 写入 —— 只写用户数据；默认值在读时填充
const doc = await store.insert('Post', { title: 'Hello' });

// 查询 —— GQL 树语法，值通过 @key 从 params 引用
const items = await store.query(
  'Post($condition:@c0,$sort:@s1,$limit:@l) { title, status, statusLabel }',
  { c0: { status: 'draft' }, s1: { createdAt: -1 }, l: 20 },
);
```

同一份 schema、同一条查询可原样跑在 PostgreSQL 上 —— 只有 `init()` 的数据源不同：

```js
await init({ default: { kind: 'postgres', exec } });   // exec：你的 pg 连接池适配器
const items = await store.query('Post($condition:@c0) { title, status }', { c0: { status: 'draft' } });
```

## 支持的后端

| 后端 | 说明 |
| --- | --- |
| MongoDB | 原生聚合管道（`find`/`aggregate`/`$lookup`） |
| MySQL | 参数化 SQL，`information_schema` introspection |
| SQLite | 参数化 SQL，`sqlite_master` + `PRAGMA` introspection。**同步驱动**（`better-sqlite3`）：调用按设计阻塞事件循环 —— 高并发热路径请优先 MySQL/PostgreSQL/MongoDB，或把 SQLite 隔离到专用进程 |
| PostgreSQL | 参数化 SQL（`$n`），支持 `RETURNING` |

GQL 树查询会编译为每个后端一条原生查询 —— 再也不必手写 `$lookup` 或原生 SQL。

## 特性

- **纯 JSON schema，零代码** —— 一个模型就是一个对象：fields、relations、computes、indexes。
- **GQL 树查询 → 一条原生查询** —— 嵌套关系在单条查询中解析；再也不必手写 `$lookup`。
- **归一化聚合** —— 根级 `$group` / `$having` 与关系聚合谓词（semi/anti-join）在同一份 GQL 中，下推到全部四种后端。
- **读时默认值与计算列** —— 写入只存用户数据；读取时填充默认值并运行 `fn` / `asyncFn` / 关系 `agg` 计算列。
- **智能持久化** —— `mutation()` 依据 `_id` + 唯一索引自动识别 upsert，并递归填充关系子文档。
- **内置软删除** —— 每个 schema 自动注册一个 `<Model>Deleted` 归档集合/表；`remove()` 先归档再删除。
- **权限上下文** —— 基于 `AsyncLocalStorage` 的角色（`super_admin`/`admin`/`guest`/`creator`...）、schema/字段级读写白名单、自动属主条件注入。
- **多数据源 & 多租户** —— 通过 `(source, namespace, collection)` 定位 schema；按请求用路由覆盖重新定向。
- **异步优先，Rust 核心** —— 基于 `mongodb` Node.js 驱动与共享的 Rust 核心（含 SQL 方言）。

## GQL 语法

```text
Model($condition:@c0,$sort:@s1,$skip:@sk,$limit:@l1) {
  field1, field2, obj.subField,
  Relation($condition:@c2,$sort:@s3,$limit:@l2) { f3, Nested { f4 } }
}
```

- 值来自 params 对象：`{ c0: {...}, s1: {...} }`。
- 对象的子字段使用点号表示法；关系在 schema 中声明（`type: 'many' | 'one'`）并自动解析 —— **不要手写 `$lookup`**。
- `many` 关系返回数组（为空时为 `[]`）；`one` 关系会合并进父文档（缺失时为 `null`）。
- 关系级 `$sort`/`$skip`/`$limit` 是**按父级的 top-N**（每个父级各自取窗口；在 SQL 上翻译为窗口函数）。

> **破坏性变更**：用户 `$pipeline` 透传与 `store.aggregate()` 已移除（原生聚合逃生舱）。包含 `$pipeline` 的 GQL 现在会显式失败，而不再被静默忽略。

## 聚合

归一化聚合**内置于 GQL** —— 没有单独 API，没有原生管道。

**根级 `$group` + `$having`**（GROUP BY / HAVING）：

```js
const rows = await store.query(
  'Course($condition:@c0,$group:@g0,$having:@h0,$sort:@s0,$limit:@l0){ status, n, total }',
  {
    c0: { status: { $ne: 'deleted' } },
    g0: { by: ['status'], agg: { n: { $count: '*' }, total: { $sum: 'price' } } },
    h0: { n: { $gt: 1 } },
    s0: { total: -1 },
    l0: 20,
  },
);
```

- 白名单算子：`$count` / `$sum` / `$avg` / `$min` / `$max`。
- 固定执行顺序：`$condition`（WHERE）→ `$group`（GROUP BY）→ `$having`（HAVING）→ `$sort` → `$skip`/`$limit` → projection。
- 省略 `by`（或传 `[]`）即对全表做单一分组；空输入情况仍返回一行（`$count` → `0`，其余 → `null`）。

**关系聚合谓词（semi / anti-join）** —— 按关系的聚合过滤父级，而不会发生行扇出：

```js
await store.query('Product($condition:@c0,$sort:@s0){ _id, name }', {
  c0: {
    $and: [
      { status: 'onSale' },
      { orders: { $count: { $gt: 3 } } },                                  // 订单数 > 3
      { $not: { orders: { $sum: { $of: 'amount', $gt: 10000 } } } },       // 不是大客户
    ],
  },
  s0: { name: 1 },
});
```

在 SQL 上翻译为 `EXISTS` / `NOT EXISTS`，在 MongoDB 上翻译为 `$lookup` + `$match`。

**关系滚动计算列** —— 在 schema 中声明一次，按名称请求：

```js
computes: {
  itemCount: { type: 'int', agg: { $count: 'items' } },       // 关系为空时为 0
  itemsTotal: { type: 'float', agg: { $sum: 'items.qty' } },  // 关系为空时为 null
}
```

## 查询与写入 API

```js
const items  = await store.query(gql, params);            // Array
const one    = await store.queryOne(gql, params);         // object | null
const page   = await store.queryWithCount(gql, params);   // { items, total, hasMore, page, pageSize }（pageSize 上限 5000）
const exists = await store.exists('Post', { _id: pid });
const n      = await store.count('Post', { status: 'active' });

const doc    = await store.insert('Post', { ... });       // 自动 _id / createdAt / updatedAt
const docs   = await store.insertMany('Post', [{ ... }, ...]);
await store.update('Post', { _id: pid }, { status: 'live' });      // 普通字段 → $set
await store.update('Post', { _id: pid }, { $inc: { views: 1 } });  // 以 '$' 开头的键作为操作符透传
await store.updateMany('Post', { type: t }, { status: 'live' });
const r      = await store.remove('Post', { _id: pid });  // 先归档到 <collection>_deleted
await store.mutation('Post', { ... });                    // 智能 upsert + 递归关系子文档
await store.upsert('Post', { code: 'A1' }, { ... });      // 显式条件的 upsert（不做关系处理）
```

注意：

- `null`/`undefined` 值在持久化前会被剔除；`_id` 无法通过 `update` 修改。
- `createdAt`/`updatedAt`（毫秒）由框架维护 —— 不要手动设置。
- `queryWithCount` 接受 `page`/`pageSize`（推荐）或传统的 `$skip`/`$limit` 参数。
- 带**空条件**（`{}`、`null`、`{ "$and": [] }`）的 `updateMany` / `remove` 会被直接拒绝 —— 它绝不会退化为全表写入。

## 多数据源连接

每个 schema 由三元组 `(source, namespace, collection)` 定位 —— 该三元组在 registry 内必须
全局唯一（重复注册会抛错，而不是静默错路由）。

- `source` —— `init({...})` 中的连接键（默认 `"default"`）。
- `namespace` —— 连接内的数据库/schema：Mongo 库名、PG schema、
  MySQL database、SQLite 附加库。可选；`null` = 连接默认。
- `collection` —— 表/集合名。

```js
// 多个 Mongo 服务器：每个连接一个 source
await init({ mongo_main: db, pg_a: { kind: 'postgres', exec } });

// 同一个 MongoClient 服务多个数据库：声明 namespace（库名）
await init({ cluster: client });
store.register({ name: 'User', collection: 'users', datasource: 'cluster', namespace: 'tenant_42', ... });

// SQL 跨 namespace 的 join 会原生下推（"ns_a"."t" JOIN "ns_b"."t"）；
// 只有 Mongo 的跨库关系会退回内存联邦。
```

**多租户路由覆盖** —— 一份 schema 定义，N 个租户。任意查询/写入都接受
一个 `{ source, namespace }` 覆盖参数，在**执行时**把命令重新定向（权限
与计算列仍按结构 schema 判定）：

```js
await store.query('User($condition:@c0){...}', params, { namespace: 'tenant_42' });
await store.insert('Order', data, { source: 'pg_cluster', namespace: 'tenant_7' });
```

**`routeOverride` 是受信的服务端参数** —— 它不做来源校验，因此把用户可控输入
透传进来，会让调用者把命令重定向到其他租户的 `source`/`namespace`（CWE-639
授权绕过面）。绝不要把原始请求数据传到这里。

传统的单库用法（`init(db)` + 不含 `datasource`/`namespace` 的 schema）保持不变：
命令携带 `source: 'default'`、`namespace: null`。

## 权限上下文

```js
// 每个请求设置一次（在中间件/路由层）
store.setContext({ userId: uid, roles: ['editor'] });

// 嵌套安全的作用域角色
store.scopedRoles(['viewer'], () => store.query(gql, params));

// 内部/定时任务 —— 绕过权限校验
await store.runAsInternal(() => store.remove('Post', { _id: pid }));
```

- `super_admin`/`admin`/`internal` 角色放行一切；其他角色按 schema 级与字段级 `read`/`write` 白名单校验；`guest` 永不写。
- `creator` 是一个伪角色，依据 `doc.createdBy === ctx.userId` 解析；授予它的 schema 会自动在查询上注入属主条件，并在 update/remove 时做属主校验。
- 未设置上下文 → 权限校验关闭（向后兼容）。
- 拒绝访问时抛出 `store.PermissionError`（`status = 403`）。

### 失败即安全模式（可选开启）

"无上下文"既可能表示*系统调用*，也可能表示*调用方忘记设置上下文* —— 默认情况下
后者会静默通过所有校验（fail-open，为向后兼容而保留）。对安全性敏感的宿主，
可在启动时一次性开启上下文强制要求：

```js
store.setRequireContext(true);
// 此后每个没有上下文的查询/写入都会抛出 `ERR_NO_CONTEXT:...`
// 内部任务必须显式声明：
await store.runAsInternal(() => store.remove('Post', { _id: pid }));
```

`runAsInternal` 会把该次调用标记为 `{ internal: true }`，其语义与"缺失上下文"
不同，且总是放行。`setRequireContext(false)` 恢复默认行为。

## Schema 参考

```js
{
  name: 'Order',
  collection: 'orders',
  idPrefix: 'OD',
  timestamps: true,                  // 默认：自动维护 createdAt/updatedAt（毫秒）
  fields: {
    _id: 'string',                                        // 简写
    title: { type: 'string', default: '' },
    meta: { type: 'object', default: {}, fields: { ... } },  // 嵌套对象字段
  },
  relations: {
    items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' },
  },
  computes: {
    total: { type: 'float', depends: ['amount'], fn: (d) => d.amount * 1.1 },
    itemCount: { type: 'int', agg: { $count: 'items' } },
  },
  indexes: [
    { keys: { status: 1 } },
    { keys: { code: 1 }, options: { unique: true } },
  ],
  read: ['editor', 'viewer'],        // 可选的 schema 级角色白名单
  write: ['editor'],
}
```

类型：`string | int | long | float | double | boolean | array | object | date | any`。

几条需要提前知道的边界规则（全部**显式失败**，绝不静默降级）：

- 直接对数组字段、整个对象字段或对象点路径做过滤，在任何后端都会被拒绝 —— 请改用 `relations` 建模跨实体语义。
- 关系谓词仅支持**一层**关系；形如 `orders.items.price` 的路径会被拒绝。
- 不可读的关系是错误，而不是静默的 `false`。

## 高级 API

以下所有内容都可从导出的 `store` 单例或其重导出的模块访问。以 `?` 为前缀的选项
是可选的。

### `store.buildPipeline(gql, params?)`

底层解析 —— 将 GQL 编译为命令计划而**不执行它**，返回
`{ tokens, ast, pipeline, projection }`。适用于调试查询形状、断言下推行为，
或构建自定义工具（例如必须在运行前展示并校验计划的 AI 查询智能体）。
此处**不会**应用权限 / 计算列。

```js
const plan = store.buildPipeline('Post($condition:@c0){ title }', { c0: { status: 'draft' } });
console.log(plan.pipeline);
```

### `store.syncSchema(opts)`

把一个 SQL 后端的物理结构拉取进 registry
（`introspect → schemaFromRows → mergeSchema(overlay) → register`）。它只**读取**
结构 —— 从不把 DDL 写回数据库。

| 选项 | 类型 | 含义 |
| --- | --- | --- |
| `backend` | `'mysql' \| 'postgres' \| 'sqlite'` | 必填 |
| `driver` | object | 必填；建议使用只读账号 |
| `introspectOptions` | object | 透传给 introspection（例如 PG 的 `schema`） |
| `overlay` | `Array` | 叠加合并的本地 schemaJSON（权限 / 计算列 / 覆盖） |
| `datasource` | string | 把所有合并后的 def 绑定到该 source |
| `namespace` | string | 把所有合并后的 def 绑定到该 namespace |
| `registerDefs` | boolean（默认 `true`） | `false` = 返回 defs 但不注册 |

返回合并后的 `schemaJSON[]`。

```js
const defs = await store.syncSchema({
  backend: 'postgres', driver: pgPool, overlay: [Post], datasource: 'pg_a',
});
```

### `store.setFeedbackSink(fn)`

接管用于兜底 / 降级 / 拦截事件的统一反馈通道。sink 接收一个事件对象；传入
`null`（或非函数）则回退到默认的 stderr 打印器。

```js
store.setFeedbackSink((e) => logger.warn({ code: e.code }, e.hint));
// 事件形状：{ type, code, layer, message, hint, ... }
//   type   federation_degraded | sql_pushdown_unsupported | ...
//   code   crossSourceSort | pushdownUnsupported | ...
//   layer  federation | dialect | ...
```

不可下推的命令还会抛出 `PushdownUnsupportedError` —— 捕获它即可把该片段
改投到某个 Mongo 源重跑。

### 底层模块

该包会重导出其构建模块，供高级宿主使用：

```js
const {
  init, store, Store,
  PermissionError,              // 拒绝访问时抛出（status = 403）
  PushdownUnsupportedError,     // 命令无法安全下推时抛出
  datasource, schema, permission, crud, executors, feedback, introspect,
  syncSchema,                   // 与 store.syncSchema 是同一函数
} = require('nodejs-store');

// introspect.run(backend, driver, options) → 归一化结构行
const rows = await introspect.run('mysql', pool, {});

// executors.createConnection(kind, driver, options) → SQL 数据源描述符 { kind, exec }
await init({ default: db, pg_a: executors.createConnection('postgres', pgPool) });
```

- `schema` / `permission` / `feedback` / `datasource` 暴露的是 `store`
  单例所委托的同一批函数（例如 `datasource.setConnections`、`datasource.hasConnection`、
  `datasource.isSql`、`datasource.runInTransaction`）。
- **多租户路由覆盖** —— 把 `{ source, namespace }` 作为任意
  查询/写入的最后一个参数传入，见 [多数据源连接](#多数据源连接)。

## 事务边界

- **单一 SQL 源**：`mutation` 的父子步骤序列与 `remove`（归档 + 删除）在一个已检出的连接上的单个驱动事务内执行 —— 任一步失败会回滚整个序列。
- **每条 SQL 写入命令**本身即原子：多语句计划（例如 MySQL 的写入 + 回读）在执行器内被事务包裹。
- **Mongo 源**：单文档写入是原子的；多步 `mutation` 与 `remove` 顺序执行，跨步骤**不**原子（Mongo 事务需要副本集）。若你的跨步骤一致性要求发生在 Mongo 上，请为这些模型改用 SQL 源，或补充应用层补偿。
- **归档幂等**：`remove` 的归档采用按 `_id` upsert 的语义，因此部分失败后的重试不会再因 `_id` 重复而失败。
- **跨源步骤**（父与子绑定到不同数据源）无法原子 —— 按设计顺序执行。

## 常见问题

**如何在 Node.js 中让一份 schema 同时用于 MongoDB 和 PostgreSQL？**
把 schema 用 JSON 定义一次，用你的数据源调用 `init()`，然后对两者运行同一份 GQL。MongoDB 使用原生聚合；MySQL/PostgreSQL/SQLite 得到参数化 SQL。见[快速开始](#快速开始)。

**如何在不写 `$lookup` 或 JOIN 的情况下查询嵌套/关系数据？**
在 `relations` 中声明关系（`{ model, type: 'many' | 'one', localField, foreignField }`），并在 GQL 选择集里引用关系名。它在 Mongo 上变成 `$lookup`，在 SQL 上变成 `JOIN`，以嵌套文档返回。

**支持 GROUP BY / COUNT / SUM / AVG 吗？**
支持 —— 归一化聚合是 GQL 的一部分：根级 `$group` / `$having` 与关系聚合谓词。见[聚合](#聚合)。

**能否按其子文档的聚合过滤父级（"订单数大于 3 的商品"）？**
可以 —— 关系聚合谓词实现 semi/anti-join 而不扇出；SQL 使用 `EXISTS`/`NOT EXISTS`。

**如何实现行级权限？**
使用 `store.setContext({ userId, roles })` 加上 schema 级的 `read`/`write` 白名单。`creator` 伪角色会自动加入属主校验与属主条件注入。`guest` 永不写。开启 `setRequireContext(true)` 可获得失败即安全的行为。

**如何做软删除？**
每个已注册的模型都会自动获得一个 `<Model>Deleted` 归档集合/表。`store.remove()` 先归档文档，再删除它；重新创建同一个 `_id` 不会冲突，因为归档写入是按 `_id` upsert。

**能用于多租户应用吗？**
可以。把 schema 绑定到 `(source, namespace, collection)`，并按请求传入 `{ source, namespace }` 路由覆盖。仅把 `routeOverride` 当作受信的服务端输入。

**它会执行迁移吗？**
不会。`syncSchema()` 只通过 introspection *读取*物理结构（introspect → 合并 overlay → 注册）。schema 变更 / DDL 是你所用迁移工具的职责。

**能否在不运行的情况下查看生成的查询？**
可以 —— `store.buildPipeline(gql, params)` 返回编译后的计划（`{ tokens, ast, pipeline, projection }`），不执行，也不应用权限/计算列。

**SQL 下推不可行时会发生什么？**
命令会抛出 `PushdownUnsupportedError`，**并且**通过 `setFeedbackSink` 发出一个结构化反馈事件（`sql_pushdown_unsupported`）。跨源分页/排序的降级会发出 `federation_degraded` 事件。不会有任何静默失败。

**它与 py-store 和 rust-store 是什么关系？**
`rust-store` 是共享的 Rust 引擎（GQL 解析、权限、计算列、命令规划、SQL 方言翻译 —— 纯逻辑，无 IO）。`nodejs-store`（npm）与 [`py-store`](https://github.com/coenddt/py-store)（pip `storepy`）是它前面的薄宿主：它们负责驱动 IO、回调与占位符替换。Node 与 Python 共享相同的 schema、相同的 GQL、相同的语义。

## 相关项目

- [`py-store`](https://github.com/coenddt/py-store) —— Python asyncio 孪生版（pip `storepy`，`from py_store import init, store`）。
- [`rust-store`](https://github.com/coenddt/rust-store) —— 共享的 Rust 核心及其 `rust-store-node` / `rust-store-py` 绑定。
- `text-to-query` —— 配套技能：把自然语言问题转换为该数据层所需 GQL + params。

## 许可证

[MIT](LICENSE)
