---
name: "nodejs-store"
description: "Node.js 宿主多后端数据层（npm 包 nodejs-store）：纯 JSON schema + GQL 树查询，一份查询跑 MongoDB/MySQL/SQLite/PostgreSQL，含权限与计算列；本体是薄 Host，纯逻辑在 rust-store 的 core-node 绑定。调用场景：安装/使用 nodejs-store、写 store.query/insert/update/mutation、配置多数据源路由或权限、排查 nodejs-store 行为时。"
---

# nodejs-store —— Node.js 多后端数据层（薄 Host）

## 1. 仓库定位

- `nodejs-store` 是 **Node.js 宿主薄适配层**，把 `rust-store/core`（经 `core-node` napi-rs 绑定）产出的「Mongo 命令 JSON」执行到真实后端。
- 端到端链路：**GQL → core 解析/规划 → Command（Mongo 命令 JSON，携带 `source`/`namespace`/`collection`）→（SQL 源）core `dialectTranslate` → 后端 SQL → executor 执行 → core 后处理（默认值 / 计算列 / 权限裁剪）**。
- 它与 `py-store` 是 **同一语义的双端同构宿主**（README 明确"same schemas, same GQL, same semantics, camelCase API"），共享 `rust-store/core`；只是 API 命名 camelCase（Node）vs snake_case（Python）。
- 职责边界（源码注释强调）：`src/*.js` 只做**驱动 IO（唯一 IO 边界）、占位符替换、原生回调（`asyncFn` 两段式）**；schema/GQL/权限/计算列/命令规划/后处理全在 Rust core（`src/crud/index.js` 头部）。
- 依赖关系：`dependencies` = `mongodb`、`mysql2`、`pg`、`better-sqlite3`、`rust-store-node`（见 `package.json`）。

## 2. 安装/依赖

```bash
npm install nodejs-store
```

- 要求 Node.js **>= 18**（`package.json engines`）。
- 关键依赖 `rust-store-node`（Rust 原生核心绑定，独立仓库 `rust-store/core-node` 发布）。**仓库内开发期**该依赖尚未发布到 npm，用 `LOCAL_CORE=1` 从相邻 `rust-store/core-node/dist` 加载（`src/core.js`；`scripts/test.js` 会自动开启）。
- 本地开发依赖：`npm install`（devDeps: eslint / c8 / @eslint/js / globals）。

## 3. 快速上手（与当前 README 一致）

```js
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();
await init(client.db('mydb'));       // 幂等创建已注册 schema 的索引（仅 Mongo 源）

store.register({
  name: 'Post',
  collection: 'posts',
  idPrefix: 'PT',
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    tags: { type: 'array', default: [] },
  },
  computes: {
    statusLabel: { type: 'string', depends: ['status'], fn: (doc) => (doc.status || '').toUpperCase() },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

const doc = await store.insert('Post', { title: 'Hello' });  // 写入只存用户数据，默认值读取时补

const items = await store.query(
  'Post($condition:@c0,$sort:@s1,$limit:@l) { title, status, statusLabel }',
  { c0: { status: 'draft' }, s1: { createdAt: -1 }, l: 20 },
);
```

SQL 后端 / 多数据源：

```js
const { init, store, executors } = require('nodejs-store');

await init({ default: mongoDb, pg_a: executors.createConnection('postgres', pgPool) });
store.register({ name: 'Order', collection: 'orders', datasource: 'pg_a',
                 namespace: 'public', fields: { amount: { type: 'float' } } });
```

## 4. 核心 API 清单（逐条标注来源，均**真实存在**）

来源：`src/index.js`（`class Store` + `module.exports`）、`src/crud/index.js`、`src/executors/index.js`、`src/introspect/index.js`、`src/sync.js`。

### 4.1 顶层导出（`src/index.js module.exports`）

`init`、`store`、`Store`、`PermissionError`、`PushdownUnsupportedError`、`datasource`、`schema`、`permission`、`crud`、`executors`、`feedback`、`introspect`、`syncSchema` —— 均 ✅。

### 4.2 `store` 单例方法（`class Store`）

| API | 签名 | 存在 | 说明 |
| --- | --- | --- | --- |
| `register` | `(defn)` | ✅ | 注册 schema，自动派生 `<Name>Deleted` 归档表 |
| `get` / `has` / `list` | `(name)` / `(name)` / `()` | ✅ | schema 管理 |
| `query` | `(gql, params, routeOverride)` | ✅ | GQL 树查询 |
| `queryOne` | `(gql, params, routeOverride)` | ✅ | 单条 |
| `queryWithCount` | `(gql, params, routeOverride)` | ✅ | `{ items, total, hasMore, page, pageSize }`，pageSize 上限 5000 |
| `queryFederated` | `(gql, params)` | ✅ | 跨源联邦（**无 routeOverride 参数**） |
| `insert` | `(schemaName, data, routeOverride)` | ✅ | 自动 `_id`/`createdAt`/`updatedAt` |
| `insertMany` | `(schemaName, docs, routeOverride)` | ✅ | |
| `update` | `(schemaName, condition, data, options, routeOverride)` | ✅ | 普通字段 → `$set`；`$`-前缀键当算子直通 |
| `updateMany` | `(schemaName, condition, data, routeOverride)` | ✅ | 空条件被拒（见坑 8.2） |
| `remove` | `(schemaName, condition, routeOverride)` | ✅ | 先归档到 `<collection>_deleted` |
| `exists` | `(schemaName, condition, routeOverride)` | ✅ | |
| `count` | `(schemaName, filter, routeOverride)` | ✅ | |
| `mutation` | `(schemaName, data, routeOverride)` | ✅ | 智能 upsert + 递归关系子文档 |
| `upsert` | `(schemaName, condition, data, options, routeOverride)` | ✅ | 显式条件 upsert，不处理关系 |
| `syncSchema` | `(opts)` | ✅ | `{backend, driver, introspectOptions, overlay, datasource, namespace, registerDefs}`；**只读结构，不回写 DDL** |
| `buildPipeline` | `(gql, params)` | ✅ | 低层解析，返回 `{tokens, ast, pipeline, projection}`；**不施加权限/计算列** |
| `setContext` / `getContext` | `(ctx)` | ✅ | `AsyncLocalStorage` 上下文 |
| `scopedRoles` | `(roles, fn)` | ✅ | 嵌套安全角色作用域 |
| `runAsInternal` | `async (fn)` | ✅ | 绕过权限（`{internal:true}`） |
| `setRequireContext` | `(needCtx = true)` | ✅ | fail-secure 开关 |
| `setFeedbackSink` | `(fn)` | ✅ | 统一反馈通道；传 `null` 恢复 stderr |
| `PermissionError` | 原型属性 | ✅ | 拒绝访问时抛（`status = 403`） |
| `aggregate` | — | ❌ | **已移除**；用户 `$pipeline` 直通亦移除并显式报错 |

### 4.3 底层模块

| API | 存在 | 来源 |
| --- | --- | --- |
| `crud`（query/queryOne/queryWithCount/queryFederated/insert/insertMany/update/updateMany/remove/exists/count/mutation/upsert/setConnections + Host 契约件 `_substitute`/`resolvePlaceholders`/`_generateId`/`_truthy`/`_newIdPool`） | ✅ | `src/crud/index.js` |
| `executors.createConnection(kind, driver, options)` → `{kind, exec}`；`executors.shapeResult` | ✅ | `src/executors/index.js`（kind ∈ mysql/postgres/sqlite） |
| `introspect.run(backend, driver, options)` | ✅ | `src/introspect/index.js` |
| `datasource.setConnections` / `hasConnection` / `isSql` / `runInTransaction` / `PushdownUnsupportedError` | ✅ | `src/datasource.js`（README Advanced API 列举） |
| `schema` / `permission` / `feedback` 模块（与 store 委托的同一批函数） | ✅ | 各模块 |
| `store.setAllowUserPipeline` | ❌ | 1.1.0 曾加入（`$pipeline` 开关），2.0.0 随 `$pipeline` 一起移除；**当前源码无此方法** |

## 5. GQL 查询语法

```text
Model($condition:@c0,$sort:@s1,$skip:@sk,$limit:@l1) {
  field1, field2, obj.subField,
  Relation($condition:@c2,$sort:@s3,$limit:@l2) { f3, Nested { f4 } }
}
```

- 值来自 params 对象，用 `@key` 引用；关系在 schema 声明（`type: 'many' | 'one'`）自动解析——**不要手写 `$lookup`**。
- 支持的参数：根级/关系级 `$condition`、`$sort`、`$skip`、`$limit`；根级聚合 `$group`、`$having`。
- `$pipeline` 参数**显式报错**（"直通已移除"），不是静默忽略。

### 根级 `$group` / `$having`（已实现，`rust-store/core/src/pipeline/group.rs` + `dialect/select/group_agg.rs`）

```text
Course($condition:@c0, $group:@g0, $having:@h0, $sort:@s0, $skip:@sk, $limit:@l0) { ... }
```

- `$group` 规格：`{ by: ['status','meta.level'], agg: { n: { $count: '*' }, total: { $sum: 'price' } } }`。
- 算子白名单：`$count`/`$sum`/`$avg`/`$min`/`$max`（`$count:'*'` = 行数）。
- 固定序：`$condition`(WHERE) → `$group`(GROUP BY) → `$having`(HAVING) → `$sort` → `$skip/$limit` → 投影；有 `$group` 时排序/分页作用于分组结果。
- `$having` 必须与 `$group` 同用；`by` 仅标量域，`agg` 仅本表标量字段。

### 计算列

- `fn`（同步）/ `asyncFn`（异步，Host `prepareQuery` → await → `stripQuery` 两段式）/ `agg`（关系聚合，**已归一，取代旧 `lookup`**）。
- `agg` 形态：`{ $count: '<关系名>' }` 或 `{ $sum|$avg|$min|$max: '<关系>.<字段>' }`；与 `fn`/`asyncFn` 互斥；空集语义 `$count → 0`，其余 `→ null`。

## 6. 多后端 / 方言 / 多数据源

- 后端：**MongoDB / MySQL / SQLite / PostgreSQL**。GQL 树查询编译成**每后端一条原生查询**。
- ⚠️ **SQLite 用同步驱动 `better-sqlite3`，调用期间阻塞事件循环（设计选择，非缺陷）**：高并发主链路请用 MySQL/PostgreSQL/MongoDB，或把 SQLite 隔离到独立进程。
- 定位三元组 `(source, namespace, collection)` 全局唯一，冲突**注册即抛**；`source` 是 `init({...})` 的连接键（缺省 `'default'`），`namespace` 是连接内 db/schema（`null` = 连接默认）。
- Mongo 连接两形态**严格校验不猜**：db 实例 → 命令 `namespace` 必须为 `null`；MongoClient → `namespace` 必须非 `null`（`client.db(ns).collection(...)`）。
- SQL 同连接跨 namespace 关联**下推**为 `"ns_a"."t" JOIN "ns_b"."t"`；仅 Mongo 跨 db 走内存联邦。
- **多租户路由**：query/write 末参可传 `{ source, namespace }` override（权限/计算列仍按结构 schema）。
  - ⚠️ `routeOverride` 是**受信服务端参数**，禁止透传用户输入（CWE-639 越权跨租户）。
- 权限：schema 级 `read`/`write` + 字段级 `field.read`/`field.write` + 关系级 `rel.read` + 计算列级 `comp.read`；`super_admin`/`admin`/`internal` 全放行，`guest` 永不写，`creator` 伪角色（`doc.createdBy === ctx.userId`）。
- **SQL 后端不建索引**（`indexes` 仅元数据）；只有 Mongo 源在 `init` 时幂等建索引。

## 7. 测试与发布

```bash
npm test                # node scripts/test.js（自动 LOCAL_CORE=1，node --test tests/**/*.js）
npm run test:coverage   # c8 覆盖率门禁：statements/lines 90、functions 85、branches 75
npm run lint            # eslint（零告警门禁）
```

- 测试文件：`tests/test-nodejs-store.js`、`tests/host-contract.test.js`、`tests/guards.test.js`、`tests/multi-datasource.test.js`、`tests/require-context.test.js`、`tests/sql-executor.test.js`、`tests/index-feedback.test.js`、`tests/real-backends-e2e.test.js`、`tests/federation-e2e.test.js`。
- 压测脚本：`scripts/stress.js`。
- 发布：`.github/workflows/release-npm.yml`，推 `v*` tag；**前置：`rust-store-node` 需已发布**。CI（`.github/workflows/ci.yml`）临时摘除未发布的 `rust-store-node` 依赖并走 `LOCAL_CORE=1` 兜底，再跑 lint + 覆盖率门禁。

## 8. 常见坑

1. **`LOCAL_CORE` 环境变量**：仓库内开发必须 `LOCAL_CORE=1`（且 `NODE_ENV != 'production'`）才能从相邻 `rust-store/core-node/dist` 加载原生核心；生产只从 npm 依赖加载。`npm test` 已自动开启。
2. **R4 批量写空条件一票否决**：`updateMany` / `remove` 条件为 `{}`、`null`、空逻辑组时**显式拒绝**，绝不落全表。
3. **`__present` 是 SQL 内部哨兵列**：用于区分「显式 null」与「缺失」，由翻译层注入/消费（PostgreSQL upsert 曾因未限定表名报 `column reference "__present" is ambiguous`，已修）。Host/用户不要触碰。
4. **Mongo 命令 vs SQL 差异**：`executors.shapeResult` 把 SQL 路径的中立包络塑形为 **mongodb 驱动等价返回值**（如 `{ modifiedCount }` / `{ deletedCount }`），上层 CRUD 对两条路径透明。
5. **默认 fail-open**：未设上下文时权限检查全部放行（向后兼容）。安全敏感宿主启动时 `store.setRequireContext(true)`，此后缺 ctx 抛 `ERR_NO_CONTEXT:...`，内部任务显式 `runAsInternal`。
6. **`queryWithCount` 接受 `page`/`pageSize`（推荐）或传统 `$skip`/`$limit`**；pageSize 上限 5000。
7. **`null`/`undefined` 写入前被剥离**；`_id` 不可经 `update` 修改；`createdAt`/`updatedAt` 由框架维护（毫秒，schema `timestamps: 's'` 则为秒）。
8. **迁移注意（2.0.0 Breaking）**：计算列 `lookup` → `agg`；`store.aggregate()` / 用户 `$pipeline` / `setAllowUserPipeline` 已移除。
9. **U1~U4 全局显式报错**：数组字段直接过滤（U1）、对象深度等值过滤（U2）、对象点号路径过滤（U3）/排序（U4）在所有后端统一报错，不静默降级。
10. **SQL 下推不可翻译时显式抛错**：`PushdownUnsupportedError`（`datasource.js`），并同时走 `feedback` 通道；可捕获后改用 Mongo 源执行该段。
11. **索引创建失败不阻塞 `init`**，但会经 `feedback.emit({type:'index_create_failed', ...})` 上报——需 `store.setFeedbackSink` 接管才能接入自动闭环。

## 9. 相关 skill / 文档

- 本仓库内文档：`doc/2026-09-12-测试报告.md`、`doc/2026-09-12-压测报告.md`、`doc/test-eval/`、`doc/code-review/`、`doc/fix-plan/`。
- 设计文档位于 **`rust-store/.trae/documents/`**（本仓库 CHANGELOG 引用的多数据源路由方案）。

## 10. 文档与代码不一致（实测差异）

- **CHANGELOG 1.1.0** 记载新增 `store.setAllowUserPipeline(false)`，但 **2.0.0 段**说明随用户 `$pipeline` 一起移除，且 `src/` 中已无该方法（grep 无匹配）。以源码为准：**当前无 `setAllowUserPipeline`**。
- **README "Low-level modules"** 示例 `const { init, store, Store, PermissionError, ... } = require('nodejs-store')` 与 `src/index.js` 的 `module.exports` 一致；但示例里 `await init({ default: db, pg_a: executors.createConnection('postgres', pgPool) })` 需注意 `createConnection` 第二参是**驱动实例**（Pool/Client），非裸连接对象。
- **README 未列出 `queryFederated`**（"Query & write API" 段），但 `Store.queryFederated` 与 `crud.queryFederated` 真实存在。
