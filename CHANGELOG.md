# Changelog

## Unreleased

### Added（触发器）

- **schema 声明式触发链**：schema 顶层 `triggers` 声明写事件（首批 `insert` / `update`）的副作用
  步骤；Rust 核心规划期展开为 `plan.triggers`，宿主在源写同一 `runAtomic` 包络内依次执行
  （`src/crud/triggers.js`）——单源**真事务**（同事务回滚）；触及第二数据源按顺序执行并声明
  `non_atomic_write`；`store.session()` 内对跨源写 fail-closed（`NonAtomicWriteError`）。
- **回调装配**：`store.setTriggerFn(fnRef, impl)`（`impl(args, ctx, { store })`，回调内 `store.*`
  落到当前事务连接）+ `store.assertTriggerFnsCovered(defns)` 启动期校验（声明的 `fnRef` 缺实现 ⇒
  `ERR_TRIGGER_FN_MISSING`，服务不启动）。
- **判定与执行语义**：update 事件先判 `onFields 值真的变化`（结构深比较，no-op 抑制）→ 再判
  `when`（`eq/ne/gt/gte/lt/lte/in/and/or/not`）；insert 事件跳过字段级检查。占位符
  `{{root.*}}` / `{{before.*}}` / `{{now}}` 只做整值替换，内嵌拼接 ⇒ `ERR_TRIGGER_PLACEHOLDER`。
  同一次顶层调用内 `(step.name, _id)` 去重。
- **边界**：不支持级联（触发写不再触发触发器）；`updateMany` 不支持字段级触发（显式拒绝）；
  `remove` 事件与命令式步骤 `op: "upsert"` 注册期 `Err`。
- **对拍**：`scripts/parity-triggers.js` 读 `rust-store/fixtures/triggers/cases.json` 产出规划输出，
  与 py-store 对拍输出逐字节一致。

## 4.0.0 (2026-10-04)

### Breaking（落点模型外置：`namespace` 删除 → `database`(+`schema` PG)、定义零落点）

- **命令体形状改为 `{ source, database, schema, collection }`**：core 产出的每条 Command 携带
  这四项定位（`source` 缺省 `"default"`；`schema` 仅 PG 源非 null）；旧 `namespace` 字段删除。
- **定义零落点**：schema 定义文件不再声明任何定位字段（`source` / `database` / `schema` 一并
  移除，`namespace` 删除）；落点由「定义目录布局 + 连接配置」解析 —— `<defs-root>/` 下一级目录 =
  `database`，PostgreSQL 再加二级 = `schema`（Mongo / MySQL / SQLite 无此级），更深层级自由并在
  装载时打平。
- **`routeOverride` 键更名**：由 `{ source, namespace }` 改为 `{ source?, database?, schema? }`，
  仍是受信服务端参数（CWE-639 面不变）。
- **同批同名定义 ⇒ 报错、服务不启动**（原静默覆盖）；同名一律「一份主 + 若干 `replica` 从链路」，
  从链路只加 link、不重复结构，零或 ≥2 个主同为错误。跨版本同名重载版本号 +1。
- **数据标识符下沉翻译**：定义名（`collection`、字段、关系字段、计算列键、`fnRef` 值、索引名）可
  任意风格，引擎按目标风格翻译（SQL 物理 snake_case、Mongo 物理 camelCase、Node/Java/C#/Rust 代码
  camelCase、Go PascalCase、Python snake_case）；同 schema 内两个逻辑名归一后相等，或归一撞上保留
  契约键（如 `fnref`）⇒ `ERR_NAME_CONFLICT`，服务不启动（**既有与保留键同名归一的字段名，如
  `type` / `read` / `write`，将被拒绝**）。归一实现唯一在 core `core::naming`，宿主不得重写。
- **计算列 `fnRef` 默认复合名 + 归一匹配**：逻辑 `fnRef` 默认 `<schema.name>.<计算列键>`（自动生成，
  不必手写），宿主实现按归一 token 序列匹配（Node `orderAmountLabel` 与 Python `order_amount_label`
  绑定同一逻辑计算列）；跨 schema 复用可显式写共享名（如 `"common.moneyLabel"`），命名由必填转可选；
  声明的 `fnRef` 无实现 ⇒ `ERR_FN_MISSING`，服务不启动。
- **Python 宿主删除驼峰别名**（仅蛇形）。

### Migration

1. 把定义 / 命令中的 `namespace` 替换为 `database`（PostgreSQL 另加 `schema`）。
2. 删除 schema 定义文件里的定位字段（`source` / `database` / `schema`）。
3. 按新语义重排目录：一级目录 = `database`，PostgreSQL 再加二级 = `schema`；更深层级自由打平。
4. `routeOverride` 键改名 `{ source?, database?, schema? }`。
5. 抬高绑定依赖下限：`rust-store-node` `^4.0.0`。
6. 检查数据标识符与保留契约键的归一冲突（撞名 ⇒ `ERR_NAME_CONFLICT`，须改名）。

### Docs

- README（双语）/ `llms-full.txt` / `ask_knowledge.md` 新增三段规范（命名风格 / 落点目录约定 /
  `fnRef` 绑定），并以 `scripts/check-spec-snippets.js` 在 CI 校验各载体归一后逐段一致。
- 新增 `doc/transaction-capabilities.md` / `.zh-CN.md`（写同事务边界：单连接内跨 db / PG schema 可
  同事务，Mongo 需副本集；跨连接无跨源事务 ⇒ 显式拒绝或降级并发反馈事件，绝不静默）。

## 3.0.0 (2026-10-02)

### Breaking（RBAC 内置角色清单化，设计 §11）

- `super_admin`/`admin` 不再默认放行：豁免改为 `set_exempt_roles` 清单（默认空）；
- `guest` 不再默认拒写：拒写改为 `set_deny_write_roles` 清单（默认空）；
- `guest` 无白名单读拒在默认 Open 姿态下不再保留：未配置姿态显式化为
  `set_unconfigured_policy`（默认 `open`；`closed` = 未配置模型读写全拒）；
- RBAC enforce 模式升级为无例外 default deny（豁免清单为空时无后门）；
- 新增绑定/宿主透传：core-py/core-node/core-ffi/host/py-store/nodejs-store/go-store
  各 3 个配置方法；creator 伪角色、internal、策略 JSON、错误前缀契约不变。

## 2.7.0 (2026-10-02)

### Added

- **AI 问数（L1）**：`store.ask(question, opts)`（自然语言 → LLM 翻译 `{"gql","params"}` →
  `text2query` 档受控执行 → 失败结构化回喂重试，耗尽抛 `AskExhausted`）、
  `store.describeForAi(ctx?)` 权限过滤摘要、`llm` 插拔注册表（`registerLlm` / `getLlm` /
  `makeOpenaiCompat` 零依赖 OpenAI 兼容工厂，`LlmError` 结构化失败）——与 py-store ask 同构
  （parity）。护栏（只读、行数/深度硬限、ctx fail-secure、routeOverride 封闭）服务端硬编码。
- **RBAC 门面（6 方法）**：`store.setRbac` / `rbacEnabled` / `rbacCan` / `rbacReadableFields` /
  `rbacWritableFields` / `rbacRowCondition`——判决唯一在 Rust core，宿主零判决。
- **声明式 schema 迁移**：`store.migrate(defs)` 声明式加列 / 加索引 / 类型放宽，破坏性变更
  显式拒绝（`MIGRATION_UNSUPPORTED`），存量行缺失语义 + 归档跟随。
- **文档**：README（双语）/ llms.txt / llms-full.txt 补 `ask` / `describeForAi` / `llm` API 章节。
- **工作流编排（首批）**：`workflow.register(defn)` / `workflow.run(name, input)`（node:
  `store.registerWorkflow` / `store.runWorkflow`）——线性步骤 + 步骤级 `when` 守卫 + fail-fast。
  步骤白名单 `query` / `mutation` / `fail`，白名单外注册即 `WORKFLOW_UNSUPPORTED`；占位符
  `{{input.*}}` / `{{<as>.*}}`（前向引用）/ `{{dec:a,b}}`；dry-run（query 真实执行、写记
  `wouldRun`）；三级角色白名单（read/write/run）内嵌 defn，run 继承触发者 Context、每步过 core
  权限判定，rejected 落库可审计。

### Changed

- 依赖下限 `rust-store-node` ^2.3.0 → **^2.7.0**：2.7.0 绑定才导出 RBAC 系列、
  `readableComputes`、`clearSchemas` 与完整 `text2query` 档位判决（`ERR_TEXT2QUERY` 前缀）；
  旧绑定上这些面为空或缺判决（实测 npm 2.6.0 全量 fail 8）。
- **内建 `__workflowRun` schema 自举**：run 记录落库（status: running → succeeded | failed |
  rejected；dry-run 终态 drySucceeded | dryFailed + 步骤迹），普通 GQL 即查——可观测性零新接口。
  `write` 显式空名单（R2 拒普通角色篡改 run 审计）；模块内部写入走干净 internal 上下文
  （guest 硬拒写先于 internal 放行，不能复用保留 roles 的 run_as_internal）。
- **单源 run 跨步骤原子**（N1 实测升级）：外层 `run_atomic` 包住整个步骤循环、内层 mutation
  嵌套并入（SQL 保存点 / Mongo 并入外层）——任一步失败整体回滚；多源 / 源预扫失败按顺序执行并
  发反馈事件（`workflow_non_atomic` / `workflow_prescan_failed`，禁静默）。run 记录在业务事务外
  独立提交，业务回滚不影响失败 run 可查。
- **校验器**：注册即静态检查（纯函数）——步骤/字段白名单、占位符前向引用（含自引用与 dec 形态）、
  when 结构（exists 优先消解，is/than 参数键）、upsert 必带 match、gql 禁占位符（防注入）、
  `__` 前缀保留；错误全量收集，文案双宿主逐字节一致（parity 锚单测：
  `py-store/tests/test_workflow.py` ↔ `nodejs-store/tests/workflow.test.js`）。

### 明确不做（首批边界，与能力同权重）

循环 / 并行 / 子工作流 / 人工审批、自动补偿（Saga）/ 自动重试、步骤级宿主回调、工作流定义存库 /
热更（依赖 schema 版本化先行）、定时 / 事件触发、gql 内嵌占位符、数组下标路径——检出即
`WORKFLOW_UNSUPPORTED`，不静默降级；出口见 README「工作流编排（首批）」。

### 证据

T5 组 e2e（9 用例 × 4 后端：manager-transaction 场景，含 T5-05「succeeded run 的 error 必须为
null」正向断言与 T5-09 跨步骤原子整体回滚）双宿主全绿；报告见
`doc/test-eval/2026/10/manager-transaction-场景矩阵-*.md`；设计文档
`common-store/工作流编排设计文档.md`（§6.2 按 N1 实测结论升级为「单源 run 整体原子」）。


### Added

- **声明式 schema 迁移**：`ddl.diff_defs(old, new)`（后端无关变更列表）+
  `ddl.generate_migration(backend, old, new)`（per-dialect SQL 文本；纯函数、不连库、
  只产文本不执行）。首批白名单：加表 / 加列（主表+归档表跟随，支持标量 default）/
  类型放宽（int→long|float|double 等）/ 加索引；白名单外显式 `MIGRATION_UNSUPPORTED`
  （删列/改名/收窄/主键变更）。SQLite 支持加列/加索引/加表，类型变更显式拒绝；
  MongoDB 不做迁移（schemaless）。双宿主输出逐字节一致（parity 锚单测）。


## 2.6.0 (2026-09-30)

### Added

- **mutation 关系谓词下推**：`update` / `updateMany` / `remove` 条件键命中已声明关系时归一为
  preCommand（aggregate 取命中 `_id`）+ `_id $in`，SQL 侧下推为 `EXISTS`；新增整值条件对象
  语法糖（`{'product': {'category': 'meat'}}` ≡ `$filter` + `$exists: true`）。修复此前
  MongoDB 侧关系谓词静默 no-op（`modifiedCount=0` 无告警）。
- **`$group by` one 关系路径**：`by: ['product.category']`——Mongo 侧 `$lookup`+`$unwind`
  （preserveNullAndEmptyArrays，不扇出）、SQL 侧 `LEFT JOIN` 聚合；many 关系路径显式报错
  （扇出破坏计数语义）。
- **自增 int 主键**：`_id` 声明 `{'type': 'int', 'strategy': 'autoincrement'}`——SQL 三后端
  自增赋值并回读（PG/SQLite `INSERT…RETURNING`、MySQL lastrowid）；DDL 生成对应
  `AUTO_INCREMENT` / `SERIAL` / `INTEGER PRIMARY KEY AUTOINCREMENT`；Mongo 与 `insert_many`
  场景显式报 `AUTOINCREMENT_NOT_SUPPORTED`（禁 ObjectId 静默顶替）；非法 strategy 值注册期报错。
- **索引 DDL 落地**：`schema.indexes`（Mongo 形态）→ `ddl.generate` 产出
  `CREATE [UNIQUE] INDEX idx_<表>_<字段>`，三方言逐字节一致；同名表重复注册去重并告警
  （`ddlDuplicateTable`）。原「不建索引」铁律按用户裁决放开；「生成器只产文本不执行」边界不变。

### 证据

场景 e2e（`manager-transaction` 9 用例 × 4 后端）与 course-platform 回归（101 × 4）全绿，
报告见 `doc/test-eval/2026/09/`；功能文档见 `doc/transaction-capabilities.md` /
`doc/transaction-capabilities.zh-CN.md`。


## 2.5.0 (2026-09-29)

### Added

- **显式会话（Session / Unit of Work）**：`store.session(async (s) => { ... })`（回调式），会话内同一
  SQL 源的全部命令落到同一事务连接，退出统一提交 / 异常统一回滚；**惰性开事务**，空会话不占连接；
  会话可嵌套（内层作用域在已有事务上开 `SAVEPOINT sp_<n>`，内层失败只回滚本层）。
- **执行器显式事务原语** `openTransaction`（sqlite / postgres / mysql）：返回
  `{ exec, commit, rollback, release }`（三者幂等）；`withTransaction` 改为基于其实现。
- **会话内跨源写 fail-closed**：同一会话写 ≥2 个数据源时先全部回滚、再抛 `NonAtomicWriteError`，
  绝不提交半截。
- **跨源写 `nonAtomic` 程序化声明**：无会话的一次写调用涉及 ≥2 个数据源时，按顺序执行并发出一条
  `non_atomic_write` 反馈（`code: nonAtomic`，含涉及源）——非原子边界显式声明，绝不静默。
- **执行器保存点原语** `savepoint` / `releaseSavepoint` / `rollbackToSavepoint`
  （sqlite / postgres / mysql）：事务句柄新增三原语；`withTransaction` 的 body 追加第二参数
  （事务句柄）；JS 忽略多余实参，旧「单参 body」写法仍兼容。
- **嵌套作用域保存点**：嵌套 `transaction`、嵌套 `session` 与会话内 `transaction` 在已有事务上开
  `SAVEPOINT sp_<n>`，退出按成败 `RELEASE` / `ROLLBACK TO` + `RELEASE`——内层失败只回滚内层、
  外层可继续；句柄无原语时降级并入外层并发 `nested_savepoint_unsupported`（允许降级、禁止静默）。
- **Mongo session 事务**：单 Mongo 源在 replica set / sharded 部署下由 `store.session` / 顶层写调用
  包事务（`startSession` + `startTransaction`）；执行器新增 `openTransaction` 与原语，
  `execMongo(db, cmd, session)` 全 9 种 kind 透传 session；**运行时能力探测**（`hello` 的
  `setName` / `msg=isdbgrid`，按 client 缓存）四态判定，standalone / 探测失败降级按原样执行并声明
  `mongo_transaction_unsupported`（`deployment: standalone|unknown`）。
- **Mongo 无保存点原语的嵌套语义**：同源嵌套作用域走既有 `nested_savepoint_unsupported` 降级声明
  （Mongo 不支持 `SAVEPOINT`，不伪造）。
- **事务作用域降级声明 `transaction_not_atomic`**：`store.transaction` / 顶层原子包络落到未实现
  `withTransaction` 的 SQL 执行器时按原样执行，并发出一条 `transaction_not_atomic` 反馈
  （`code: transactionNotAtomic`）——与 `session_not_atomic` 对称，消除该路径此前的静默降级。
- **原生 SQL 逃生口 `executeRaw`**：在指定 SQL 源上执行原生 SQL，编译由 core `rawStmtCompile`
  完成——位置档（`params` 为数组/null：SQL 原样透传，占位符手写方言原生风格）与命名档
  （`params` 为对象：`:name` 编译为方言占位符，同名复用、跳过 `::` cast / 引号 / 注释边界，
  缺名 / 多余名显式报错）；`isWrite` 缺省按 SQL 首词推断（默认写是安全方向）；事务 / 会话作用域内
  落事务专用连接（支持 `SELECT ... FOR UPDATE`）；仅支持 SQL 源，Mongo 源显式报错。
- **原生 Mongo 管道逃生口 `executeNative`**：在指定 Mongo 源上执行原生聚合管道（复用
  `execMongo` IO 边界），对标 SQL 侧 `executeRaw`。

### Changed

- `update` 的「权限探针 + 写」整体纳入同一事务作用域（`runAtomic`），消除探针与写之间的并发窗口；
  调用级 `now` 仅取一次（两次规划共用）。
- node postgres 执行器移除「连接 checkout 失败静默退回 driver 本体」的兜底，改为显式上抛。
- 嵌套事务 / 嵌套会话不再「整体并入外层」：改为保存点隔离（内层失败只回滚本层）。
- 事务边界文档改为三档口径（单命令 / `transaction` / `session`）。
- **Mongo 会话/事务边界口径**：由「Mongo 一律非原子（`session_not_atomic`）」改为「按运行时部署能力
  事务化（replica set / sharded），不可事务则显式声明 `mongo_transaction_unsupported`」；
  `isSqlConnection` 判定收紧为 `kind ∈ {'mysql','postgres','sqlite'}`。

## 2.3.0 (2026-09-27)

### New Features

- **调用档位（profile）门面**：`store.setProfile('standard' | 'text2query')` / `store.getProfile()`
  （模块级别名同名）；未知档位由 core 抛错，**禁静默回落**。
- **`text2query()` 上下文**：`await store.text2query(async () => { ... })`（模块级
  `require('nodejs-store').text2query(fn)` 同构；`AsyncLocalStorage` 内设档 + 强制用户上下文，
  退出恢复原档，嵌套安全、异常亦恢复）。
- **档位违规错误 + 自动反馈**：`text2query` 档越限抛 `ProfileViolation`（`status = 400`；core
  前缀 `ERR_TEXT2QUERY:` 映射），同时产出 `profile_blocked` 反馈事件（含 `profile` / `feature` /
  `layer` / `hint`）—— 允许拦截，禁止静默。
- **`routeOverride` 受信来源门禁（Host 兜底）**：`text2query` 档传非空 `routeOverride` 即
  `ProfileViolation` + emit（core 已判，Host 再兜一层）；`standard` 档保持受信可用（CWE-639）。

### Breaking Changes

- **`object` / `array` 列改落 JSON 列**：DDL 生成器由「跳过 object/array 字段」改为建 JSON 列
  （MySQL `JSON` / PG `jsonb` / SQLite `TEXT`），`course-platform` 示例 DDL（sqlite/mysql/postgres）同步。
- **U1~U4 分档**：数组字段过滤（U1）、对象整值过滤（U2）、对象点号路径过滤（U3）/排序（U4）——
  `standard` 档放行（四库可下推；U2 对象键序差异**告警**），`text2query` 档显式抛错；
  数组索引路径（`tags.0`）两档一律抛错。
- **超深关系嵌套不再静默降级**：深度 / 分页深度超限由「静默返回残缺数据」改为**显式抛错**（两档一致）。
- **根级 `$pipeline` 按档分流**：`standard` 档放行（Mongo 源可用；SQL 源逐阶段翻译、无法映射即
  `PushdownUnsupportedError`），`text2query` 档 `ProfileViolation`；`$out` / `$merge` 写副作用阶段两档均拒。

### Tooling

- 新增 `tests/host-paths.test.js`：两阶段读路径（取 ID → 回表 → 还原排序）、联邦降级告警、
  `init` 入参校验等 Host 执行路径补测。
- 新增 `tests/coverage-margin.test.js`：原生核心加载守卫（生产禁从相邻仓库兜底）、执行器事务
  提交回滚、DDL 边界与 introspection 后端分发等此前未覆盖分支。双文件对标 `py-store` 同名用例。

## 2.0.0 (2026-09-14)

### Breaking Changes

- **计算列 `lookup` 形态归一为 `agg` 算子（多后端归一化 P4）**：schema `computes`
  的 `lookup`（Mongo 专用）形态移除，改用归一 `agg` 白名单算子 `$count`/`$sum`/`$avg`/
  `$min`/`$max`：`{"$count": "orders"}`（关系整名计数）、`{"$sum": "orders.amount"}`
  （必须带单级「关系.字段」）。`$count` 只取关系整名，`$sum/$avg/$min/$max` 必须带字段，
  二级路径首批不支持，且与 `fn`/`asyncFn` 互斥。空集语义（§9.7）：`$count` → `0`；
  `$sum/$avg/$min/$max` → `null`。执行按后端下推：SQL 走派生表
  `LEFT JOIN (… GROUP BY fk)`，Mongo 走 `$lookup` + `$addFields`。
- **删除用户 `$pipeline` 直通与 `store.aggregate()`**：多后端归一化执行计划 P3
  砍掉「直通聚合」逃生舱（对齐 D3 / D18）。GQL 中的 `$pipeline` 参数**显式报错**
  （不再静默忽略）；`store.aggregate(...)`、`store.setAllowUserPipeline(...)` 一并移除。
  归一聚合（`$group`/`$sum`）将按统一 GQL 语法（固定阶段序，下推优先 + 内存兜底）
  重新设计后回归。
- **读路径关系权限收口（R0-1）**：GQL 显式请求的关系，若 `relation.read` 不可读、
  或目标 model 的 `schema.read` 不可读，规划期**直接抛错** `ERR_PERMISSION`
  （错误码稳定前缀 `ERR_PERMISSION:`，Host 映射为 403）。此前是「静默裁剪该关系字段、
  查询照样成功」，现在改为直接失败。`ctx = null`（未设置上下文）维持 fail-open 放行，未变。
- **SQL 后端 `object` / `array` 字段不再静默丢弃**：
  - 读：显式投影 schema 声明为 `object` / `array` 的字段（SQL 侧无对应列）→ **显式抛错**
    （此前静默把这列从 SELECT 里丢掉、返回残缺行）；
  - 写：`$set` / `$inc` 目标是 `object` / `array` 字段 → **显式抛错**
    （此前静默跳过、数据悄悄不落库）。`$unset` 维持跳过语义不变。

### New Features

- **归一化 P5：根级聚合与关系聚合谓词**：新增根级 `$group` / `$having` 聚合；新增 §9.6
  关系聚合谓词（`$condition` 中以关系名作键的 semi/anti-join 谓词，主形式
  `filter` / `agg` / `having`，简写 `$exists` / `$count` / `$sum`… + `$of`）。
  宿主无需改动，纯 API 能力增强。

### Migration

- 计算列原 `lookup` 声明改写为 `agg`：关系计数 `{"$count": "<关系名>"}`、关系字段聚合
  `{"$sum"|"$avg"|"$min"|"$max": "<关系>.<字段>"}`；结果语义不变，且 SQL 后端自此同语法可用。
- 关系/计算列查询不受影响（`$condition`/`$sort`/`$skip`/`$limit` + 关系字段照常）。
- 原先依赖 `store.aggregate(schema, pipeline)` 的调用方：等待归一聚合语法上线后改写。
- **受影响调用要捕获权限错误**：显式请求不可读关系现在会直接抛 `ERR_PERMISSION`
  （Host 侧 403），不要再假设「查询成功 + 关系被裁剪」了，按需自己 try/catch。
- **别依赖 `object` / `array` 字段在 SQL 后端被静默忽略 / 静默不落库**：这些字段在 SQL 后端
  仍**不支持读写**（DDL 不建列），只是失败方式由「静默」变成「显式抛错」，跨后端代码要按
  「可能抛错」处理。

### Bug Fixes

- **`store.count()` 漏传调用上下文**：`planCount` 少传 `ctx`，导致 `routeOverride`
  （多租户路由）与 owner 范围条件（R1/E-08）未生效 —— 与 py-store 同构对齐。
- **PostgreSQL upsert 的 `__present` 歧义**：`ON CONFLICT … DO UPDATE` 中哨兵列现值
  引用改为限定目标表（core 方言修复），否则 PG 报 `column reference "__present" is ambiguous`。
- **SQL 布尔列回读归一**：MySQL `TINYINT(1)` / SQLite `INTEGER` 的布尔列此前回读为
  `1`/`0`，现由 core 按 schema 声明类型归一为 `true`/`false`（PG 原生 `BOOLEAN` no-op），
  与 Mongo 一致。
- **PostgreSQL 浮点过滤报错**：整数列与浮点值比较（如 `{"$gt": 2.5}`）此前被 PG 推断为
  `integer` 而报 `invalid input syntax for type integer`，现由 core 显式 `CAST` 修复。

## 1.1.0 (2026-09-12)

宿主接入守卫（对齐 py-store `c44001e` / rust-store `ab643f4`，依赖 `rust-store-node`>=1.0.0）。

### New Features

- **时间戳单位感知**：schema `timestamps` 支持 `'s'`（秒级）——镜像记录
  `timestampUnit`（`'s'/'ms'/null`），写路径按单位注入秒/毫秒时间戳；
  非法值注册即报错（core 校验，行为收紧：原先任意非 false 值放行）。
- **用户 $pipeline 禁用开关**：`store.setAllowUserPipeline(false)` 透传 core
  Registry 开关（AI 问数宿主建议关闭作纵深防御），关闭后用户 `$pipeline`
  显式报错。
- **统一反馈事件通道**：新增 `feedback` 模块（`setFeedbackSink(fn)` + emit，
  无 sink 时打 stderr 向后兼容）——联邦 degraded 事件（含 core 新增的
  `layer`/`hint` 字段）与 SQL 下推拒绝（结构化 `PushdownUnsupportedError`，
  实例 `feedback()` 可转事件）统一接入自动反馈闭环。

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
