# Changelog

## 6.0.1 (2026-11-10)

### Fixed（索引键点号路径物理化）

- **新增 `naming.physicalPath`，`init` 建索引改用它逐段物理化索引键**：schema 声明嵌套
  路径索引（如 `signers.userId`）时，旧实现把整串交给 `translateName`，物理化成
  `signersUserId`，与文档真实嵌套路径不符——索引能建成但永远匹配不到数据（按该字段查询
  退化为 COLLSCAN）。现按 `trKey` 的分段语义逐段映射、以 `.` 连接，保留点号结构；索引名
  同步变为 `signers.userId_1`。
- 回归：新增 `tests/index-nested-path.test.js`（真实 MongoDB），断言索引键等于文档嵌套
  路径，并以执行计划断言按该字段查询命中该索引（IXSCAN）。

## 6.0.0 (2026-11-08)

### Breaking（主干破坏性变更，升级必读）

- **`internal` 上下文收口**：`setContext(...)` 不再采信普通上下文里自带的 `internal` 标记
  （用户可控输入带 `internal: true` 即越权）。内部 / 定时任务统一改用 `runAsInternal()`。
  **迁移**：`setContext({ internal: true, ... })` → `runAsInternal(async () => ...)`。
- **`exists()` 改调带 ctx 的 `planExistsWithCtx`**：读权限统一由 core 裁决，宿主不再绕过读
  白名单。**迁移**：若业务依赖「能 `exists` 但无 `read`」，需在 schema 的 `read` 名单里显式放行。
- **`toNumber` 超安全整数出参**：超出 ±(2^53−1) 的整数值返回字符串（精确值），不再返回失真的
  number。**迁移**：读 BIGINT 超界列时按 `typeof` 分支处理（JSON 序列化仍为精确数字字面量）。
- **workflow 白名单去硬编码**：`admin` / `super_admin` 不再自动放行，必须写进 `read` / `write` /
  `run` 名单。**迁移**：把内部管理员角色显式加入对应名单。
- **依赖下限抬升（发版时生效）**：`rust-store-node` 须含 core `273bc11` 及 `registerBatch` /
  `planExistsWithCtx` / `unregister`；旧绑定缺方法时显式抛错（不静默降级）。

### Migration（6.0.0 升级步骤）

1. 升级 `rust-store-node` 到随 6.0.0 发布的版本（旧绑定缺新 core 能力会显式抛错）。
2. 内部调用从 `setContext({ internal: true })` 改为 `runAsInternal()`。
3. 需要「拒绝读」的 workflow 定义改用顶层 `denyRead: true`；`read: []` 现在按「未配置」处理
   （见下方 workflow 条目，非破坏）。
4. BIGINT 超界读取按字符串分支处理；MySQL 侧建议连接池 `supportBigNumbers: true`。
5. 升级后首次 `store.migrate` 会因 hash 规范化对既有 defn 重跑一次 diff（通常为空变更，新增一条
   版本行），数据与列型不变（见 hash 条目）。

### 维护分支（5.x，非破坏）

`maintenance/5.x` 只收**非破坏修复**，随 **5.1.4**（nodejs-store）/ **5.3.3**（py-store）维护版发布：
不改变任何既有调用方的行为与签名、无迁移步骤。内容为 workflow 空名单恢复「未配置」并在注册期
告警、`denyRead` 显式拒绝读、迁移自动补内建列 + 归属键 NULL 告警、`update` 返回值补内建列、
新增 `registerBatch` / `unregister` 门面。上文 `internal` 收口、`exists()` 带 ctx、`toNumber`
超界等破坏性项**只进 6.0.0 主干**，不进入维护分支。

### Added（feat：`text` 长文本字段类型）

- `text` → MySQL `MEDIUMTEXT`、PG / SQLite `TEXT`（对齐 py-store 5.3.0）。此前 Node 侧
  DDL 抛「类型 'text' 未知」，同一 defn 在两仓不能逐字节产出相同 DDL。

### Added（新增宿主门面：批量注册 / 注销，供插件 bootstrap 接入）

- `store.registerBatch(items)`：`items = [{defn, location?}]`，`location` 缺省时按 defn
  内落点字段推导。一步透传 core `registerBatch`，原子语义由 core 定：任一失败零副作用。
- `store.unregister(name)`：透传 core `Registry::unregister`，幂等（未知 schema 成功），
  同时清 Host 元数据镜像（含派生 `<Name>Deleted`）。当前绑定若未导出该方法，
  显式抛错（不静默、不改镜像）。
- 均为新增公开符号，既有 `register` / 调用路径行为不变 → 非破坏（补丁级）。

### Fixed（fix：内建列清单收口 / 类型对齐 / 迁移 diff parity / 执行路径）

- **update/updateOne 的 returns 缺省列与键序**：`writeReturns` 此前在「无计算列」时直接返回落库
  doc，导致 schema 声明默认值但落库文档缺失该列的行，returns 少列（与 py-store
  `apply_write_defaults` 分叉；`tests/parity-local.test.js` 实测 node 缺 `age: 0`）。现统一以
  core 出口的键序为准，值以落库 doc 为基（显式 null / 已有值保持，缺失列补默认值），计算列取
  core 计算结果 —— 双端 returns 逐字节一致。
- **D1/D2 迁移的内建列剔除改由 `ddl.builtinFieldNames` 单一来源判定**：此前迁移侧用
  `timestamps` 真值 + 固定两列，与 DDL 的「未声明即建」口径分叉，且从不剔除归属键；
  默认 timestamps + creator 权限的表在 SQLite 实机迁移报 `MigrationUnsupported`。
- **D3 `_alignTypes` 按内省物理族归一**：内省反推 `number` 的列改声明
  `date`/`datetime`/`bool` 不再被判「非放宽变更」。
- **P8 `diffDefs` 的 `addColumn` 键集合与 py-store 一致**（`op`/`name`/`field`）。
- **P9 索引相等判定改用 `_stableStringify`**（键序无关 + JS 数字语义），
  `JSON.stringify` 键序敏感导致的「同键不同序 → 误判新增索引」消失。
- **P4 `toNumber` 不再静默失真**：超出 IEEE-754 安全整数范围的整数值保留驱动原始
  字符串（如 `9223372036854775807`），不再变成 `9223372036854776000`。
- **A1 node datasource 补齐 MySQL 两步化 claim 的 SQL 文本占位符回填**：先取命中
  `_id` 再回填置标语句，零领取不执行置标；此前 Node 侧直接把含
  `___claimed_ids___` 的 SQL 下发驱动（`1054 Unknown column`）。同时 `_renderClaimedIds`
  不再输出外层括号（core 模板已写作 `IN (___claimed_ids___)`，否则成
  `IN (('a','b'))`，MySQL 报 1241）。
- **A3 `executeNative` 识别 `$merge`/`$out` 写管道并按写路径解析连接**（主库 / 事务）。
- **`_toCoreDefn` 剔除落点键 `database`/`schema`**：core 01 起不再解析定义内落点
  （白名单不含 `database`），旧写法注册期会被 reject（「含未知顶层键」）。落点仍由
  `_locOf` 显式注入，行为不变；定义持久化不再携带落点键。

### Fixed（迁移：老库缺内建列先自动补齐再告警，不再阻断升级）

- 迁移 ⓪ 段由「缺内建列即 `MigrationUnsupported`」改为**先自动补列、再告警**：按
  `ddl.implicitColumnDDL` 对物理表执行 `ALTER TABLE ... ADD COLUMN`，补齐
  `created_at` / `updated_at` / `created_by` / `__present` 等缺失列后继续迁移；成功后发
  `migrationAutoAddBuiltinColumns` 告警，消息含表名与全部补齐的列，可定位到具体表。
- 只有补列语句本身失败时才中断并抛 `MigrationUnsupported`（附手工补列 / 重建表指引）——
  真报错保留，不吞成静默通过。
- ⓪b 归属键为 NULL 的存量行改为发 `migrationOwnerKeyNullRows` 告警后继续（老库照常迁过去，
  不再整表阻断）。
- **非破坏**：老库升级不再因缺内建列直接失败；行为变化仅是多两条可定位告警。

### Changed（workflow 定义级白名单：空名单回归「未配置」，显式拒绝走 `denyRead`）

- `read` / `write` / `run` 的显式空名单（`[]`）按 core 口径回到「未配置」旧语义 —— 照常放行，
  避免旧定义升级即 403。注册期发 `workflowWhitelistEmptyAsUnconfigured` 告警，告警含 workflow
  名与被判空的字段，可定位到具体定义（不静默放宽）。
- 显式拒绝读统一由顶层 `denyRead: true` 表达（core 新增开关，宿主透传，口径以 core 为准）；
  `run: []` 按未配置回退 `write`（JS 空数组是 truthy，`_runWhitelist` 显式按长度判断）。
- **非破坏**：旧定义（含空名单）照常可用，仅新增一条告警。需要拒绝语义的定义把 `read: []`
  改为 `denyRead: true` 即可。

### Changed（契约：超安全整数出参类型）

- `toNumber` 对超出安全整数范围的整数值返回字符串（精确值），不再返回失真的 number。
  读 BIGINT 超界列的调用方需知晓该类型分支（JSON 序列化仍为精确数字字面量）。

### Changed（契约：defn hash 的数值序列化改为项目规范格式）

- `_stableStringify` 的数字输出统一为**本项目的规范格式（不是 JS 语义）**，与 py-store
  逐字节一致：整值 float → 整数；有限 double 取最短往返位，按 ECMAScript 排版阈值
  （`1e-6 <= |v| < 1e21` 用普通小数，其余科学记数）；指数**无补零、无 `+`**
  （`1e21`，不再出现 `1e+21`）；`-0` → `0`；NaN / ±Infinity → `null`。
  修复此前非整数浮点跨端 hash 分叉（py `1e-07` vs node `1e-7`）导致的 migrate 幂等闸
  失效。**影响**：历史版本行的 hash 与新算不同，升级后首次 `migrate` 会重新走一次 diff
  （通常为空变更 `sqls: []`，新增一个版本行）；数据与列型不变。跨端对拍语料见
  `tests/fixtures/stable-stringify-parity.json`（两仓同内容）。

### Docs（MySQL BIGINT 精度边界）

- 明确 `mysql2` 默认 `supportBigNumbers=false` 时 BIGINT 在**驱动层**即转成 double，
  宿主 `normalizeRows` 的字符串保真路径不会生效：MySQL 下超 ±(2^53−1) 的整数会失真。
  推荐在连接池开启 `supportBigNumbers: true`（仅超范围值以字符串出参）；不建议
  `bigNumberStrings: true`（把全部 BIGINT/DECIMAL 变字符串）。README 新增「大整数精度
  （BIGINT / DECIMAL）」一节，`tests/sql-executor.test.js` 补 `normalizeRows` 回归用例。

### Docs（绑定二进制版本要求 / 本地验证手段）

- **加载优先级澄清**：`src/core.js` 未设置 `LOCAL_CORE=1`（或 `NODE_ENV=production`）时**只**从
  npm 依赖 `rust-store-node` 加载（与生产同路径）；仅在 npm 依赖加载失败时才回落相邻
  `rust-store/core-node/dist/rust-store-node.node`。`scripts/test.js` **不注入** `LOCAL_CORE`
  （此前 SKILL / CI 注释 / 多个测试文件头声称「自动开启」，已更正）。
- **发版要求**：`rust-store-node` 包内各平台 `.node` 必须构建自含 core `273bc11`
  （internal 上下文允许显式写归属键）的提交；否则任何走内建 metadef 落库的路径
  （`__schemaDef` / `__workflowDef`）会丢 `createdBy`，而现有用例不校验该列，测试仍可能全绿。
  本地把 `rust-store/core-node/dist/rust-store-node.node` 覆盖到
  `node_modules/rust-store-node/rust-store-node.win32-x64-msvc.node` **只是验证手段，不提交**
  （`node_modules` 不入库）；正式修复须由 npm 新版本承载更新后的二进制。

## 5.1.0 (2026-11-02)

### Added（feat：`accessKeys` 声明式行级权限）

- schema 新增 `accessKeys` 声明式行级权限：`read`/`write` 引用 ctx 清单，`bypassRoles` 豁免；
  单值字段成员判定、array 字段读交集 / 写子集；ctx 缺键 fail closed，空清单读空结果、写全拒。
- 方言：MySQL `JSON_OVERLAPS`、PG `&&`、SQLite `json_each`；Mongo 原生 `$in`。
- 宿主：`_mirror` 镜像 `accessKeys`（判决唯一在 core）；归档镜像不继承。
- 测试：新增 `tests/access-keys.test.js`（9 例）、`tests/access-parity.test.js` 与
  `scripts/parity_access.js`（与 py-store 逐字节对拍）。
- 依赖下限：`rust-store-node ^5.2.0`（本次能力由 core 5.2.0 提供）。

## 5.0.2 (2026-10-26)

### Changed（依赖下限：`rust-store-node` ^5.1.0）

- **`rust-store-node` 依赖下限由 `^5.0.0` 提到 `^5.1.0`**：`fields ∩ computes` 同名
  （计算列覆盖同名字段）的注册放行由 core 5.1.0 提供，Node 宿主自身不做该检测，
  故必须锁定到含本次 core 变更的绑定版本；lock 中的实际解析版本同步为 5.1.0。
- 语义（对齐 py-store / go-store）：查询期 `computes` 拥有同名键的输出所有权；
  写入期 `fields` 声明保留，`$inc` / `$set` 按同名键正常落库。
- 测试：新增 `tests/fields-computes-same-name.test.js`（注册放行 → 查询输出计算值
  3（库内原值 7）→ `$inc favoriteCount` 落库 7 → 8）。
- 无运行时代码改动。

## 5.0.0 (2026-10-25)

### Breaking（撤销：用户 `$pipeline` 直通）

- **含 `$pipeline` 的 GQL 现在一律显式报错，不再按档位放行**：撤销「双门禁分离」
  中 `standard` 档放行 `$pipeline` 的行为（随 core 撤销），统一在解析期抛
  `ERR_GQL_PARSE:$pipeline 直通已移除（原生聚合请改用 executeNative / execute_raw）`。
  `text2query` 档原有 `ERR_TEXT2QUERY` 拦截一并消失（解析层更早拦截），
  因此不再产生 `profileBlocked` 反馈。
- 撤销理由：该路径实测会静默绕过投影（只请求 `{ _id }` 时返回全字段）与字段级读权限，
  且计算列不参与 —— 无法作为可描述契约保留。
- 原生聚合逃生口全部为显式入口：`store.aggregate()`（严格 opt-in，默认禁用，
  `init(conn, { allowNativeAggregate: true })` 开启）、`executeNative()`、`executeRaw()`。
- 依赖下限：`rust-store-node` 需同步升级到含本次 core 撤销的版本（当前已发布最高为
  4.9.0，未含本变更）。
- 文档同步：`README.md` / `README.en.md` / `llms-full.txt` / `SKILL.md` 的
  `$pipeline` 与 `store.aggregate()` 表述改为与代码一致（`aggregate` 为 opt-in 别名，
  不是「已移除」）。

### Added（恢复 `store.aggregate()`，严格 opt-in）

- **`store.aggregate(schemaName, pipeline?, options?)`**：2.0.0 移除后于 5.0.0 恢复
  （4.8.0 不存在该 API）。按 schema 名解析 `(datasource, collection)` 后转调
  `executeNative`，复用 session 注入与连接复用，不另起驱动连接。
- 默认禁用：未开启时抛 `ERR_NATIVE_AGGREGATE_DISABLED`（错误信息含开启方式）；
  `init(conn, { allowNativeAggregate: true })` 显式开启后可用。未知 schema 抛
  `ERR_AGGREGATE_SCHEMA`。
- 逃生舱语义：不注入权限过滤、不做 computes 回填，管道内容不校验；仅 Mongo 源
  （SQL 源抛 `NativeCommandError` 并指引 `executeRaw`）。
- 定位：日常查询仍用 GQL `$group` / `$having` 归一聚合；`aggregate` 不是其替代品。

### Behavior notes（5.0.0 行为基线，升级前请对照）

- **字段名保留键全部解除**：随 core 4.9.0 移除 `RESERVED_KEYS`，`type` / `read` /
  `write` / `fields` / `localField` / `foreignField` 作为字段名在 5.0.0 均可用
  （4.8.0 注册即抛 `ERR_NAME_CONFLICT`；实测 9 个原失败 schema 在 5.0.0 全部注册成功）。
  字面保留名仅 `_id`（主键）与 `_score`（向量分数列）。
- **null / 缺失三态契约**：裸 `{ field: null }` 仅匹配「显式 null」；
  `{ field: { $eq: null } }` 匹配「显式 null 或字段缺失」；`{ field: { $exists: false } }`
  仅匹配缺失。三种写法有意区分，互不兜底。
- **`$group` 累积器白名单不变**：仅 `$count` / `$sum` / `$avg` / `$min` / `$max`；
  `$sum: { $cond }`、`$addToSet`、`$last` 仍不支持，请求即显式报错（不静默降级）。

### 迁移提示（4.x → 5.0）

1. **`$pipeline`**：4.8.0 仍放行，且会静默绕过投影 / 计算列 / 字段级读权限；5.0.0 改为
   解析期 `ERR_GQL_PARSE:`。改写为 `$group` / `$having`，或改用显式入口
   `executeNative()` / `executeRaw()`。
2. **`store.aggregate()`**：4.8.0 不存在；5.0.0 恢复但默认禁用。升级后需在
   `init(conn, { allowNativeAggregate: true })` 显式开启，否则每次调用抛
   `ERR_NATIVE_AGGREGATE_DISABLED`。
3. **字段名**：4.8.0 中 `type` / `read` / `write` / `fields` / `localField` /
   `foreignField` 作字段名会抛 `ERR_NAME_CONFLICT`；5.0.0 无需改名，直接注册。
4. **null 条件**：按上述三态契约逐条核对既有查询 —— 要「null 或缺失」用
   `{ $eq: null }`，要「仅显式 null」用裸 `null`，要「仅缺失」用 `{ $exists: false }`。
5. **`$group`**：白名单未扩容；依赖 `$sum: { $cond }` / `$addToSet` / `$last` 的查询
   需改写，或下沉到应用层。
6. **依赖**：`rust-store-node` 需升级到含本次 core 变更的版本（当前已发布最高 4.9.0，
   未含 `$pipeline` 撤销）。

## 4.9.0 (2026-10-25)

### Fixed（严重设计 bug：字段名保留字误伤）

- **`fields` 键空间恢复完全开放（原初设计）**：随 core 4.9.0 移除 `RESERVED_KEYS`
  保留键检查——字段名叫 `type` 的合法 schema（如 `fields: { type: { type: 'string',
  default: 'text' } }`）此前注册即抛 `ERR_NAME_CONFLICT`，现注册 / insert / GQL 查询 /
  update / remove 全链路可用。内建 `__feedback` 表的事件类别字段正名回 `type`
  （4.8.x 曾被迫改名 `eventType`，落库列名随之恢复为 `type`）。
  依赖下限：`rust-store-node ^4.9.0`。

## 4.4.1 (2026-10-10)

### Added / Fixed（NoContext 错误档）

- **`NoContextError` 归一**：core fail-secure（`require_context` / `secureMode`）下无 ctx 时统一携带
  `ERR_NO_CONTEXT:` 稳定前缀（见 core `command/mod.rs`），宿主按前缀映射为 `NoContextError`
  （与 `PermissionError` 同档 403，前缀已剥离），导出 `store.NoContextError`；`code` 与 core machine
  code 对齐（`no_context`），供协议皮按枚举判定（禁按文案匹配）。

## 4.4.0 (2026-10-10)

### Added（本地磁盘数据源 local + R2 全局单值状态 + 触发器补齐）

- **本地磁盘数据源 `local`**：新增零外部服务、零原生 DB 引擎的本地后端（`src/local/`：文件 IO
  `store.js`、Mongo 兼容手柄 `handle.js`、门面 `index.js`），datasource 接线 + 命令路由 + 索引声明
  告警 + 端到端用例；规划输出与 py-store 对拍逐字节一致。
- **R2 进程级全局单值状态**：作用域原语与派生视图入口（`src/scope.js`），宿主收口（四件套改造：
  permission / profile / secure / schema），双端作用域对拍。
- **资源表字段映射**：`configureResource` 支持 `fields` 声明，宿主字段映射 + 测试。
- **schema 触发器补齐**：`remove` 事件触发链（`src/crud/write.js`）+ 宿主定时任务插件
  （`src/scheduler/index.js`，cron）。
- **依赖**：`rust-store-node` 依赖下限抬升至 `^4.3.0`（local / cron 随引擎 4.3.0 启用）。

## 4.3.0 (2026-10-08)

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

## 4.2.1 (2026-10-08)

### Fixed（资源读取不存在错误类型化）

- **`ERR_RESOURCE_NOT_FOUND` 前缀**：resource open 遇零副本行改抛 `ERR_RESOURCE_NOT_FOUND` 前缀
  错误（原静默返回空），宿主归一为类型化错误。
- **版本声明点对齐**：修复 `CITATION.cff` / `package-lock.json` 版本漂移。

## 4.2.0 (2026-10-05)

### Added（资源插件扩展 OSS / MinIO）

- **资源插件扩展**：node 门面支持 OSS / MinIO provider + 单测。

## 4.1.0 (2026-10-05)

### Added（资源数据驱动）

- **资源数据驱动**：node 资源 provider 层（可选依赖 `@aws-sdk/client-s3`）、资源能力门面与门面接线、
  资源 schema 与 SQLite DDL、资源计算列与级联工具、资源能力单测与真库 e2e、A5/A6 副本失败反馈单测。
- **修复**：`package-lock.json` 补齐全平台子包条目（4.0.0），修 Linux 上 `npm ci` 的
  `Invalid Version`；eslint 覆盖 `packages/**`（补 node 全局）。

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
