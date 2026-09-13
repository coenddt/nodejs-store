# 代码评审评测报告：nodejs-store Host 适配层

> 评测轮次：第 1 轮
> 评测时间：2026-09-12
> 评测对象：项目评审（nodejs-store 全部 21 个 .js 源文件约 1,480 行 + 8 个测试文件）
> 技术栈：Node.js ≥18（CommonJS）、mongodb / mysql2 / pg / better-sqlite3 四驱动、rust-store-node 原生绑定
> 评测口径：默认权重（数据层库，薄 Host 架构——纯逻辑在 Rust core，本层只做 IO）
> 脚本证据：`npm test`（node --test，76/76 通过，6 套件，1.1s）

## 一、总评

| 总分 | 等级 | 结论 |
|------|------|------|
| **93** / 100 | **S 卓越** | 薄 Host 层职责纯度与工程纪律标杆：文件全部 <210 行、唯一 IO 边界、跨语言契约测试兜底；1 个 Major（批量 ID 碰撞）建议尽快修复 |

**BLOCKED**：无（未命中一票否决清单；无 Blocker/Critical 级问题）

## 二、评分卡

| # | 维度 | 满分 | 得分 | 得分率 | 等级 |
|---|------|------|------|--------|------|
| 1 | 功能正确性 | 15 | 12.5 | 83.3% | 良 |
| 2 | 可靠性 | 10 | 7.0 | 70% | 中 |
| 3 | 安全性 | 15 | 14.8 | 98.7% | 优 |
| 4 | 性能效率 | 10 | 7.5 | 75% | 中 |
| 5 | 可维护性 | 15 | 14.5 | 96.7% | 优 |
| 6 | 可读性与规范 | 10 | 9.5 | 95% | 优 |
| 7 | 测试质量 | 10 | 9.4 | 94% | 优 |
| 8 | 文档与可理解性 | 5 | 4.5 | 90% | 优 |
| 9 | 架构与设计 | 10 | 10.0 | 100% | 优 |
| — | 小计 | 100 | 89.7 | | |
| + | 亮点加分 | +5 | +3.5 | | |
| — | **总分** | | **93.2 → 93** | | |

## 三、问题清单（按严重度）

### B Blocker / C Critical

无。

### M Major

| 编号 | 定位 | 问题 | 标准出处 | 修复建议 | 状态 |
|------|------|------|----------|----------|------|
| M-1 | src/crud/id.js:14-21 | **ID 生成用 `Math.random()` 仅 4 位随机**（36⁴ ≈ 168 万组合）+ 毫秒时间戳：`insertMany` 单次事件循环内批量生成时各 doc 时间戳几乎同毫秒，1,000 docs 碰撞概率约 26%（生日问题 1−exp(−n²/2d)），批量插入将以主键冲突失败（Mongo `_id` 唯一索引 / SQL PK）；同时 ID 可预测可枚举（时间戳 + 弱随机）。ID 虽非安全令牌，但主键唯一性是正确性根基 | CWE-338（弱随机）/ CWE-708（资源唯一性） | 4 位 `Math.random()` 改 `crypto.randomBytes`/`crypto.randomInt`（≥8 字符熵），或尾部接 `crypto.randomUUID()` 切片；`_newIdPool` 与 core `needs_new_id` 契约不变 | ✅ 已修复（第 2 轮） |
| M-2 | src/crud/mutation.js:19-24、src/crud/write.js:72-88 | **多步写入无事务/补偿**：mutation 父子步骤逐条执行（步骤 2 失败时步骤 1 已落库，残留中间状态）；remove 的「归档 → 物理删除」两命令同样非原子（归档成功、删除失败后重试将重复归档行）。SQL 后端完全可包 transaction，Mongo 4.0+ 支持 session 事务，当前对部分失败零防护 | ISO 25010 可靠性（容错性）；CWE-460（不一致清理） | 至少 SQL 路径用驱动事务包住 `plan.stmts` 序列；无法事务化的后端在文档显式声明「mutation 非原子」信任边界，并让 `remove` 归档采用 upsert-by-`_id` 语义消除重复归档 | ✅ 已修复（第 3 轮） |
| M-3 | src/crud/query.js:53-56 | **queryOne 未下推 `limit 1`**：直接复用 `query` 全量取回后取 `[0]`，用户 GQL 未写 `$limit` 时大集合全量拉取再丢弃，内存/带宽浪费与 MongoDB 驱动 `findOne`（limit 1）语义不符；`queryWithCount` 有分页上限而 queryOne 无任何行数约束，两者防线不对称 | CISQ 性能（资源利用） | `queryOne` 走独立 plan 入口或注入 `$limit: 1`（core `planQuery` 支持 params 覆盖时优先），Host 侧兜底 `items.length > 1` 告警 | ✅ 已修复（第 2 轮） |

### m Minor

| 编号 | 定位 | 问题 | 标准出处 | 修复建议 | 状态 |
|------|------|------|----------|----------|------|
| m-1 | src/crud/exec.js:23,43 | `_PERMISSION_MSGS` 以中文文案字符串 Set 匹配 core 权限错误——core 文案一旦变更映射即静默失效（注释自认「消息与 core 常量保持一致」）。失效方向是权限错误降级为普通 Error（上游按 status 403 分类时变 500），不放行但错误分类丢失，且无任何失效信号 | DRY / 脆弱契约（SonarQube bug 规则） | core 侧错误结构化（错误码字段）或 Host 侧改前缀匹配（`ERR_PERMISSION` 哨兵常量）；与 rust-store m-3（CoreError 枚举）联动修复 | ✅ 已整改（第 2 轮，前缀方案） |
| m-2 | src/index.js:172-177 | `_createIndexesIfNeeded` 对 `dbOfSchema` 的 `catch (e) { continue }` 过宽：不仅吞「source 未配置」（注释声明的设计意图），也吞 namespace 校验错误（MongoClient 缺 namespace 等 fail-fast 错误），索引静默缺失且无反馈事件（对比：索引创建失败走 console.error） | fail-fast 一致性（Clean Code 错误处理） | 只捕获「数据源未配置」一类（按错误消息/类型判定），其余 rethrow；或统一走 `feedback.emit` | ✅ 已整改（第 2 轮） |
| m-3 | src/crud/query.js:95-97 | 联邦查询逐源**串行**取数（for-await），`plan.sources` 各单元相互独立，可 `Promise.all` 并行，源多时延迟线性叠加 | CISQ 性能 | 各源独立执行改并行（merge 阶段仍同步）；注意保持错误聚合语义（任一源失败整体失败） | ✅ 已整改（第 2 轮） |
| m-4 | src/datasource.js:27 | 模块级可变单例 `_connections`：全局状态，`setConnections` 整体替换，多租户/测试隔离靠调用方自觉（测试侧已用 freshStore 模式自救） | Clean Architecture（状态管理） | 保持现状可接受（与 py-store 对齐）；建议 `setConnections` 返回 unsubscribe 或提供 `scopedConnections`（ALS 变体）供测试与多租户 | 已评估（第 6 轮）：与 py-store m-7 同源、两端对齐的**模块级单例**是既定设计；改 ALS 作用域属架构级重构且无实际痛点驱动——**维持现状**（测试隔离已有 freshStore 模式） |
| m-5 | 仓库根 | 无 eslint / prettier 配置：21 个文件风格高度一致全靠人工纪律（当前实测一致性很好），无自动化守护，后续贡献者易漂移 | Google Style Guides / 工程基线 | 加 `eslint`（flat config）+ `prettier` + `lint-staged`，规则从现有风格反推 | ✅ 已整改（第 4 轮：`eslint@9` flat config（eslint.config.mjs），recommended 底线 + 风格规则（2 空格/单引号/分号/`_` 前缀未用形参豁免）从现有风格反推，实测 0 违规；附 mock 未用形参改名与 2 处引号自动修复；刻意不引 prettier/lint-staged 避免历史代码大规模重排；新增 `.github/workflows/ci.yml` lint 门禁。注：`npm install` 前需临时摘除未发布的 `rust-store-node`（CI 已按此编排） |
| m-6 | 仓库根 | 无覆盖率度量（无 c8/nyc 脚本）：76 个测试质量高但覆盖率不可知，无法设质量门禁 | ISTQB 度量 / SonarQube coverage | `node --test --experimental-test-coverage` 或 c8 接入 `scripts/test.js`，README 徽章 | ✅ 已整改（第 4 轮：c8 `--all` 口径（src/** 全量，含未被加载文件）+ 排除本地 rust 兜底产物；实测 stmts/lines 92.69、funcs 87.8、branches 77.3；门禁设 statements/lines 90、functions 85、branches 75，`npm run test:coverage` 出 text+html 报告（coverage/ 已 gitignore）并作 CI 门禁（ci.yml） |
| m-7 | 仓库根 | 缺独立 API 参考文档：README 快速开始优秀，但 `routeOverride`/`syncSchema`/`introspect`/`setFeedbackSink` 等进阶 API 只有源码 JSDoc，无集中参考 | ISO 25010 可理解性 | README 增加「进阶 API」章节或 docs/api.md（可由 JSDoc 生成） | ✅ 已整改（第 5 轮：README 新增「Advanced API」章节——`buildPipeline`/`syncSchema`（含 opts 表）/`setAllowUserPipeline`/`setFeedbackSink`（含事件形状）/底层模块再导出（`introspect.run`/`executors.createConnection`/`aggregate`/错误类），并回链 `routeOverride` 与 fail-secure） |

### I Info

| 编号 | 定位 | 问题 | 标准出处 | 修复建议 | 状态 |
|------|------|------|----------|----------|------|
| I-1 | src/schema.js:104-106 | `setAllowUserPipeline` 默认放行用户 `$pipeline`：开关存在但默认值为「允许」，纵深防御需宿主主动关闭（JSDoc 已提示 AI 问数宿主关闭）。默认方向与 fail-secure 相反 | OWASP ASVS 访问控制 | 评估是否默认关闭、宿主显式 opt-in；至少在 init 时若检测到 GQL 含 `$pipeline` 且未显式设置过开关则反馈一次 | 已评估（第 6 轮）：默认放行是三端一致（rust/py/node）的**向后兼容既定语义**，改默认值属 breaking change 并破坏 parity——**维持现状**，由宿主显式 `setAllowUserPipeline(false)` 关闭 |
| I-2 | src/crud/*.js（routeOverride 贯穿） | `routeOverride` 允许覆盖 source/namespace 定位，无来源校验——宿主把用户输入透传进该参数即可跨源路由。属宿主职责且 JSDoc 已注明「权限/计算列仍按结构 schema 判定」，但未文档化「不要透传用户输入」红线 | CWE-639 类（授权绕过面） | JSDoc 与 README 显式声明 `routeOverride` 为受信服务端参数，禁止透传用户输入 | ✅ 已整改（第 6 轮：README「Multi-tenant route override」与 `store.query` JSDoc 补**受信服务端参数、禁止透传用户输入**红线（CWE-639）；不加校验代码——跨源路由是合法能力，校验属宿主职责） |
| I-3 | tests/guards.test.js:62-69 | mock 的 `findOneAndUpdate` 用 `Object.assign` 合并所有操作符（`$set`/`$inc` 同等对待），与真实驱动语义有偏差，可能掩盖写路径缺陷 | 测试替身保真度（ISTQB） | mock 至少特判 `$set`/`$inc`/`$unset` 三类常见操作符 | 已评估（第 6 轮）：真实后端 e2e（real-backends-e2e）已兜底写路径语义，提升 mock 保真度收益低于其成本——**维持现状** |
| I-4 | src/schema.js:26-34 | `_toCoreDefn` 经 `JSON.stringify` 深拷贝：`Date`→ISO 字符串、`undefined` 值丢弃、循环引用抛错——非法 schema 定义被静默变形而非报错 | CWE-20（输入验证，弱） | register 入口对 fields/computes 做一次显式类型校验（或依赖 core.register 校验并补 Date 场景报错） | 已评估（第 6 轮）：`core.register` 已做 schema 校验，Host 再加类型校验属**重复防线**、且会重复 core 语义——**维持现状** |

### 范围外发现

无（GQL 解析 / 权限 / 计算列 / SQL 生成等纯逻辑问题归 rust-store 评测范围，已在该仓库报告中记录）。

## 四、亮点（+3.5）

1. **+1.5 跨语言同构契约测试**（tests/host-contract.test.js）：与 py-store 共享 `rust-store/fixtures/host/*.json` fixture 对拍 `resolvePlaceholders`/`_truthy`/`_newIdPool`/回调桥四个契约件，断言两侧深比较相等——「三端语义一致」不是口号而是可执行测试，是本仓库最硬的质量资产。
2. **+1.0 fail-fast 下推拦截 + 统一反馈通道**（datasource.js:150-172、feedback.js）：core 标记 `unsupported` 时显式抛 `PushdownUnsupportedError`（绝不执行「缺段」SQL 静默返回错误结果），联邦 degraded 与下推拒绝统一走 `feedback.emit`（无 sink 打 stderr，可接管），全链路「允许拦截，禁止静默失守」。
3. **+0.5 原生模块生产加载防护**（core.js）：生产只从 npm 依赖 `rust-store-node` 加载；开发兜底需 `LOCAL_CORE=1` **且** `NODE_ENV !== 'production'` 双开关——把「从相邻目录加载任意原生模块」的路径操纵面（CWE-427）在生产环境封死，且加载失败时给出可操作的修复指引。
4. **+0.5 防拖库与安全测试**：`queryWithCount` pageSize 硬上限 5000；identifier safety 测试覆盖「恶意字段名加引号后安全」「未注册 collection 直接报错不拼接用户输入」两条注入路径——安全设计配有安全测试证明。

## 五、需运行验证项

| 项 | 验证步骤 | 验证结果（复评时填） |
|----|----------|---------------------|
| M-1 碰撞复现 | `insertMany` 单次传入 1,000+ 无 `_id` 文档（同毫秒），观察主键冲突报错概率 | 待验证 |
| update 原生操作符白名单 | 对未注册字段调 `update(schema, cond, { $set: { hacker: 1 } })`，确认 core 侧 `filter_writable_data` 是否拦截 `$set` 内新键 | 待验证 |
| 行/分支覆盖率 | `c8 --all node --test tests/**/*.js`（core 覆盖率归 rust-store） | 待验证 |
| real-backends-e2e | tests/real-backends-e2e.test.js 需真实 MySQL/PG/Mongo 实例（本轮仅 SQLite 真实驱动路径已跑通） | 待验证 |
| CI 测试流水线 | .github/workflows 仅 release-npm.yml，无 test workflow——建议补 PR 触发的 `npm test`（需 core-node 产物，可复用 rust-store CI 产物） | 待验证 |

## 六、改进建议（按优先级排序）

1. **本次必须**（下一发版前）：
   - M-1 ID 随机源换 `crypto`（批量导入正确性 + 可预测性）
   - M-3 queryOne 下推 limit 1（一行级改动，收益大）
   - m-1 权限错误映射结构化（与 rust-store CoreError 联动）
2. **短期跟进**（1-2 迭代）：
   - M-2 SQL 路径事务包裹 + 「mutation 非原子」信任边界文档化
   - m-2 索引初始化 catch 收窄；m-3 联邦并行取数
   - m-5/m-6 eslint + c8 接入，CI 补 test workflow
3. **长期**：
   - m-7 进阶 API 参考文档；I-1 `$pipeline` 默认值策略评估；m-4 `scopedConnections`（ALS 变体）评估

## 七、复评记录（第 2 轮 · 定向）

> 复评时间：2026-09-12（第 1 轮「本次必须」+ 短期跟进部分项闭环后）
> 复评方式：**定向复评** —— 仅回补已闭环项扣分，未做全量重扫；回归由 `npm test`（76/76 通过，6 套件，含 MySQL/PG/Mongo 真实库 e2e + sqlite）兜底
> 本轮闭环：M-1 / M-3 / m-1 / m-2 / m-3

### 闭环项验证

| 编号 | 修复内容 | 验证证据 |
|------|----------|----------|
| M-1 | id.js 随机源 `Math.random()`(4位) → `crypto.randomInt`(8位 base36，约 41 bit 熵，拒绝采样无取模偏差)，消除同毫秒批量碰撞与可预测性 | npm test 76/76（insert/insertMany 填充 ID 用例） |
| M-3 | queryOne 走 core `planQueryOne`：未显式 `$limit` 时下推 `$limit(1)`，对齐驱动 `findOne` 语义 | npm test（crud.queryOne 用例）+ core 对拍 |
| m-1 | 权限错误映射改按 `ERR_PERMISSION:` 稳定前缀识别（core 侧新增哨兵前缀，联动 rust-store m-3 部分缓解），core 文案变更不再静默失效 | npm test（权限用例） |
| m-2 | 索引初始化 catch 收窄：`hasConnection` 先行软跳过未配置源（fail-fast 错误不再被吞），`listIndexes` 仅吞 `MongoServerError`（集合不存在的合法路径），其余上抛 | npm test（datasource 索引策略用例） |
| m-3 | 联邦查询逐源串行 for-await → `Promise.all` 并行（merge 阶段仍同步，任一源失败整体失败语义不变） | npm test（跨库联邦 A5/A6 用例） |

### 回补后评分

| # | 维度 | 第 1 轮 | 第 2 轮 | 回补依据 |
|---|------|--------|--------|----------|
| 1 | 功能正确性 | 12.5 | **14.5** | M-1 +1.5（批量主键冲突根因消除）、M-3 +0.5 |
| 2 | 可靠性 | 7.0 | **7.5** | m-2 +0.5（M-2 无事务未闭环，主扣分保留） |
| 3 | 安全性 | 14.8 | **15.0** | M-1 +0.2（ID 可预测性回补） |
| 4 | 性能效率 | 7.5 | **9.0** | M-3 +1.0（limit 下推）、m-3 +0.5（联邦并行） |
| 5 | 可维护性 | 14.5 | **15.0** | m-1 +0.5（前缀匹配） |
| 6 | 可读性与规范 | 9.5 | 9.5 | 不变 |
| 7 | 测试质量 | 9.4 | 9.4 | 不变 |
| 8 | 文档与可理解性 | 4.5 | 4.5 | 不变 |
| 9 | 架构与设计 | 10.0 | 10.0 | 不变 |
| — | 小计 | 89.7 | **94.4** | |
| + | 亮点加分 | +3.5 | +3.5 | |
| — | **总分** | **93** | **98（S 卓越）** | 定向复评口径 |

### 遗留项（第 3 轮候选）

- M-2 多步写入事务/补偿（SQL 路径事务包裹 + 「mutation 非原子」信任边界文档化）—— 首位
- m-5 eslint + m-6 覆盖率门禁 + CI test workflow；m-7 进阶 API 参考文档
- I 级备查项：I-1 `$pipeline` 默认值策略、I-2 `routeOverride` 红线文档化、m-4 `scopedConnections`（ALS 变体）

### 第 3 轮 · 定向复评（2026-09-12）

> 闭环：**M-2 多步写入事务化**（与 py-store 同方案、同语义对齐）
>
> - 执行器事务化：mysql（池 `getConnection` 专用连接 + `beginTransaction/commit/rollback`）、
>   postgres（`BEGIN/COMMIT/ROLLBACK`，池自动 checkout/归还 client）、sqlite（显式 BEGIN/COMMIT）；
>   多语句 plan（如 MySQL 写后回读）本身即事务原子；
> - 步骤序列事务化：datasource 新增 `runInTransaction(source, fn)`（AsyncLocalStorage 作用域连接覆盖），
>   mutation 父子步骤、remove 归档+删除在**单一 SQL 源**时整体落同连接同事务，任一步失败整体回滚；
>   Mongo 源 / 跨源步骤按原样顺序执行（README 新增「Transaction boundary」显式声明非原子信任边界，绝不静默假装已事务化）；
> - 归档幂等：remove 归档命令携带 `upsertById`（core 侧产出，fixture 对拍同步），Mongo 逐条 `replaceOne(upsert)`，
>   SQL 由 dialect `ON CONFLICT/ON DUPLICATE/INSERT OR REPLACE` 承接 —— 「归档成功但删除失败」的重试不再整批失败。
>
> 验证：`npm test` 76/76 全绿（含 MySQL/PG/Mongo 真实库 e2e + sqlite，事务路径实测）。
> 评分影响：维度 2 可靠性 +2.0（7.5 → 9.5，主扣分 M-2 关闭）——
> 小计 96.4 + 亮点 3.5 = **99（S 卓越，定向复评口径）**；m-5/m-6/m-7 保留扣分不变。

### 第 4 / 5 轮 · 定向复评（2026-09-12）

> 第 4 轮闭环：**m-5 eslint 门禁 + m-6 覆盖率度量/CI test workflow**（详见 m-5/m-6 行状态）。
>
> 第 5 轮闭环：**m-7 进阶 API 集中参考**。
>
> - README 新增「Advanced API」章节（置于 Schema reference 与 Transaction boundary 之间），
>   覆盖此前仅有源码 JSDoc 的进阶面：
>   - `store.buildPipeline(gql, params?)` —— 只编译不执行的命令计划（`{ tokens, ast, pipeline, projection }`）；
>   - `store.syncSchema(opts)` —— SQL 结构同步编排，附完整 opts 表
>     （`backend`/`driver`/`introspectOptions`/`overlay`/`datasource`/`namespace`/`registerDefs`）
>     与「只读结构、绝不回写 DDL」的边界说明；
>   - `store.setAllowUserPipeline(allow)`、`store.setFeedbackSink(fn)`
>     （含事件形状 `{ type, code, layer, message, hint }` 与典型取值）；
>   - 底层模块再导出清单（`introspect.run` / `executors.createConnection` / standalone `aggregate` /
>     `PermissionError` / `PushdownUnsupportedError` / `datasource` 等）；
>   - 回链既有章节：`routeOverride` → Multi-datasource connections、`setRequireContext` → Fail-secure mode。
>
> 验证：纯文档变更，`npm run lint` 与既有 `npm test` 不受影响（README 不参与 lint/覆盖率口径）。
> 评分影响：维度 8 文档与可理解性 +0.5（4.5 → 5.0 封顶，m-7 关闭）——
> 小计 96.9 + 亮点 3.5 = **100（S 卓越，定向复评口径）**。

### 第 6 轮 · 收尾评估（2026-09-12）

> 结论：**剩余 Info / 备查项不做「为消分而改」**，仅落地零风险文档项后收尾。
>
> - 已落地（I-2）：`routeOverride` 受信参数红线补入 README「Multi-tenant route override」
>   与 `store.query` JSDoc（禁止透传用户输入，CWE-639）；**不加校验代码**——跨源路由是合法能力，
>   校验属宿主职责，加代码反而越界。
> - 已评估维持现状：I-1（默认放行是三端 parity 的既定语义，改默认值属 breaking change）、
>   I-3（真实后端 e2e 已兜底）、I-4（与 `core.register` 校验重复，属重复防线）、
>   m-4（模块级单例为与 py-store 对齐的既定设计）。
> - 判定原则：属「既定设计取舍」或「重复防线」的项不做变更，避免引入回归风险。
>
> 验证：`npm run lint` 0 违规（纯文档/JSDoc 变更，运行路径与既有 81/81 测试不变）。
> 评分影响：无（I 级不在扣分口径内；问题清单仅余 I-1/I-3/I-4 与 m-4，均为「已评估维持现状」）。

### 收尾结论

- **Blocker / Critical / Major：全部清零。**
- **Minor：m-1~m-3 / m-5~m-7 已整改；m-4 已评估维持现状（含成文理由）。**
- **Info：仅余 I-1 / I-3 / I-4，均已评估并维持现状。**
- 无剩余需修复的动作项。

---

### 第 7 轮 · 最终全量评测（2026-09-12）

**评测口径（与本报告前几轮的关键区别）**

- 本轮为**项目评审 · 全量口径**：对 `nodejs-store` 仓库**当前状态**重新逐维度打分，
  **不沿用任何前轮分数**；逐文件复核 `src/` 全部 21 个 JS 文件与 `tests/` 全部 8 个测试文件，
  并实跑 `npm run lint` / `npm test` / `npm run test:coverage` 取证。
- 第 2~6 轮为**定向复评口径**：只回补「已闭环项在**原问题清单上的扣分**」，未做全量重扫，
  故其分数变化只能反映被整改项，无法发现清单之外的新问题。
- 排除范围：`node_modules/`、`coverage/`、原生构建产物（`*.node`）。
- 上下文权重：**生产系统口径**（默认权重，不做降权）。

#### 一、实测证据

| 项 | 命令 | 实测结果 |
|---|---|---|
| Lint | `npm run lint`（eslint 9 flat config） | **exit 0；0 违规 / 0 告警** |
| 测试 | `npm test`（`node --test tests/**/*.js`, `LOCAL_CORE=1`） | 81 tests / 6 suites；**首跑 80 pass / 1 fail**；重复运行约 47 次中 **3 次失败（≈6%）** |
| 覆盖率 | `npm run test:coverage`（c8 --all） | statements **92.69%** / branches **77.30%** / functions **87.80%** / lines **92.69%**；门禁（90 / 90 / 85 / 75）**通过** |

附加指标：

| 指标 | 值 |
|---|---|
| `src/` JS 文件数 / 总行数 | 21 / 1,789 |
| `tests/` JS 文件数 / 总行数 | 8 / 1,632 |
| 测试用例数 | 81（6 套件） |
| 单文件最大行数 | 229（`src/datasource.js`，参考阈值 400） |
| 动态 `eval` / `new Function` | **0 处**（全仓库，排除 node_modules） |
| `any` 用法 | **N/A**（纯 JavaScript，无 TypeScript） |
| `==` 松等 / `var`（src） | **0 处** |
| `catch` 站点 | **9 处**：3 处 rollback 兜底 + 1 处 PG checkout 兜底（均「失败不掩盖原始错误」）、2 处 core 原生加载兜底、1 处 `ERR_PERMISSION:` 前缀映射、1 处 `MongoServerError` 收窄后重抛、**1 处仅落日志后继续执行**（见 R7-m1） |

#### 二、本轮最关键的新发现：全量测试套件不可复现（flaky / 非独立）

前几轮各章节均以「`npm test` 81/81 全绿」作为验证依据。**本轮实测推翻该结论**：

1. 全量套件**首跑即 80/81**：`tests/federation-e2e.test.js:146` `assert.equal(items.length, 2)` → `4 !== 2`；
2. 重复运行全量套件约 47 次，**3 次失败（≈6%）**；最后一次失败变为
   `tests/real-backends-e2e.test.js:154` → `Error: Table 'mongo_store_e2e.my_posts_deleted' doesn't exist`（`ER_NO_SUCH_TABLE`, errno 1146）；
3. **并发隔离实验**：同时启动 6 个进程跑同一 `tests/federation-e2e.test.js` → **5/6 失败**（`pass 1 fail 1` ×2、`pass 0 fail 2` ×3、`pass 2 fail 0` ×1）；单独运行该文件则 2/2 通过。

**根因**：`tests/federation-e2e.test.js:31-41,71` 与 `tests/real-backends-e2e.test.js:37-70,149-155,202-211`
**共用同一真实 MySQL / Mongo 库**（`mongo_store_e2e`；Mongo 默认 `mongodb://127.0.0.1:27017/mongo_store_e2e`），
并在 `before` / `reset()` 中执行**破坏性 DDL/DML**（`DROP TABLE IF EXISTS ... fed_orders / my_posts / my_posts_deleted`、
`CREATE TABLE`、`DELETE FROM`）。当文件或进程重叠时，一方重建表即清掉另一方正在使用的 fixture（`my_posts_deleted` 被删后 `reset()` 直接 `ER_NO_SUCH_TABLE`）。

该缺陷同时违反 ISTQB **F.I.R.S.T** 的 *Independent* 与 *Repeatable*，并使本报告前几轮「81/81 全绿」的可复现性主张失效。

#### 三、九维评分表

> 维度 4 的分值重分配：本仓库为**纯后端**（无前端资源），按 `dimension-4-performance.md` 规则，
> 原 4.4（前端 2 分）并入 4.1~4.3，按 **3 / 3 / 4** 重新分配。

| # | 维度 | 满分 | 得分 | 得分率 | 主要依据 |
|---|---|---|---|---|---|
| 1 | 功能正确性 Correctness | 15 | **15.0** | 100% | 契约（`source`/`namespace`/`collection` 三元组、占位符、`shapeResult`）实现完整且与 README/CHANGELOG 一致；`_truthy` / `_newIdPool` 与 core 对齐并有跨语言 fixture 对拍；无 `==`/`var`/动态执行；`crypto.randomInt` 拒绝采样无模偏（CWE-338 已闭环）；归档幂等 + 事务作用域状态恢复 |
| 2 | 可靠性 Reliability | 10 | **9.5** | 95% | 2.1 异常处理 −0.5（R7-m1：索引创建失败仅 `console.error`，未接入统一反馈通道）；2.2 降级/2.3 可恢复/2.4 防御性满分（联邦 degraded 不阻断、下推 unsupported 显式抛错、rollback/release 兜底、Mongo 双形态严格校验、未配置源显式报错） |
| 3 | 安全性 Security | 15 | **15.0** | 100% | SQL 全参数化 + 标识符由 core 转义（有注入用例实证 `""` 转义后 `users` 表未被删除）；权限下沉 core 且按 `ERR_PERMISSION:` 前缀稳定映射；`routeOverride` 已按受信参数红线成文（CWE-639）；原生模块加载有「`LOCAL_CORE=1` 且 `NODE_ENV !== 'production'`」双开关防生产越权加载；无硬编码凭据 |
| 4 | 性能效率 Performance | 10 | **9.5** | 95% | 4.1 算法 3/3、4.2 数据访问 3/3（单条原生查询、SQL 下推、two-phase 下推 `limit 1`、索引幂等创建）；4.3 资源利用 3.5/4 −0.5（R7-m2：SQLite 执行器同步 API 在 async 契约内阻塞事件循环） |
| 5 | 可维护性 Maintainability | 15 | **14.5** | 96.7% | 5.1 模块化/5.3 复杂度/5.4 可分析性/5.5 依赖健康满分（分层清晰、单文件 ≤229 行、无超阈值函数、注释解释「为什么」、依赖精简）；5.2 重复 −0.5（R7-m4：`_groupIndexes` 在 mysql/postgres introspect 重复实现） |
| 6 | 可读性与编码规范 Conventions | 10 | **9.5** | 95% | 6.2 格式/6.3 注释/6.4 惯用法/6.5 一致性满分（eslint 0 告警；`'use strict'`；async 均 await；可选链/空值合并得当）；6.1 命名 −0.5（R7-m3：`setRequireContext(require = true)` 形参遮蔽 CJS `require`） |
| 7 | 测试质量 Testing | 10 | **8.0** | 80% | 7.1 覆盖 3/3（c8 全部门禁达标）；7.2 有效性 3/3（断言具体、含负向/越权/注入用例、跨语言 host 契约 fixture 对拍）；7.4 组织 2/2；**7.3 工程质量 0/2 −2**（R7-M1：flaky / 非独立，共享真实库 + `before` 破坏性 DDL） |
| 8 | 文档与可理解性 Documentation | 5 | **5.0** | 100% | README 覆盖快速开始/多源定位/GQL/权限/fail-secure/高级 API/事务边界与信任边界；CHANGELOG 按 Keep a Changelog 含 Breaking Changes 与 Migration；另有独立测试报告与压测报告；模块头注释含契约约定 |
| 9 | 架构与设计 Architecture | 10 | **10.0** | 100% | Rust 单核心 + 薄 Host（唯一 IO 边界 `src/crud/exec.js`）；契约先行（Command JSON + 三元组 + 跨语言 host fixture）；开闭（新增后端仅需 +executor/+introspect）；SOLID 与分层边界清晰（模块级可变单例为前轮 m-4 已评估维持项，不重复扣分） |

#### 四、总分与等级

- Σ 维度分 = 15.0 + 9.5 + 15.0 + 9.5 + 14.5 + 9.5 + 8.0 + 5.0 + 10.0 = **96.0**
- 亮点加分 = **+3.5**（明细见 §六，累计 ≤5）
- **总分 = 99.5 / 100**（96.0 + 3.5，未触发封顶）→ **等级 S 卓越（≥90）**
- ⚠️ **不满足定稿条件**：存在 **1 项未清零 Major（R7-M1）**，与第 8 条复评规则「连续两轮同级且问题收敛（无新增 C 及以上）」不符。
  S 级反映的是九维总体水位，与「R7-M1 未闭环」并不矛盾（单项 Major 仅在其所属维度扣 2 分）。

#### 五、分级问题清单

| 编号 | 严重度 | 位置 | 扣分 | 状态 |
|---|---|---|---|---|
| R7-M1 | **M Major** | `tests/federation-e2e.test.js:31-41,71`；`tests/real-backends-e2e.test.js:37-70,149-155,202-211` | −2 | ✅ 已整改（第 8 轮：两 e2e 文件改用各自独立库 `mongo_store_e2e_fed` / `mongo_store_e2e_real`，DROP/CREATE 只碰本库，连接串可环境变量覆盖） |
| R7-m1 | m Minor | `src/index.js:216-218` | −0.5 | ✅ 已整改（第 8 轮：改为 `feedback.emit({type:'index_create_failed', code:'indexCreateFailed', layer:'host', ...})` 统一反馈通道，无 sink 时由通道默认 stderr 承担，不双份打印） |
| R7-m2 | m Minor | `src/executors/sqlite.js:30-45` | −0.5 | ✅ 已整改（第 8 轮，**文档级**：按第 7 轮建议的短期方案执行——sqlite 执行器与 executors 导出处补中文「同步驱动阻塞事件循环」说明，README backend 对比表补替代建议；不改造成 worker） |
| R7-m3 | m Minor | `src/schema.js:114` | −0.5 | ✅ 已整改（第 8 轮：形参 `require` → `needCtx`，并同批修掉 `src/index.js:137` Store 方法的同类遮蔽点，调用点均为位置传参零变更） |
| R7-m4 | m Minor | `src/introspect/mysql.js:46-58`；`src/introspect/postgres.js:67-79` | −0.5 | ✅ 已整改（第 8 轮：逐行比对语义一致后抽 `introspect/_shared.js#groupIndexes(rows, uniqueOf)` 单份实现，唯一性判定差异参数化，行为零变更） |
| R7-I1 | I Info | `src/feedback.js:33-36` | （不计分） | 已评估 |
| R7-I2 | I Info | `src/crud/exec.js:80-82` | （不计分） | 已评估 |
| R7-I3 | I Info | `src/executors/index.js:29-34` | （不计分） | 已评估 |
| R7-I4 | I Info | `src/datasource.js:28`；`src/schema.js:20,23` | （不计分） | 维持（前轮 m-4） |

> Info 共 4 条（<10），按 `scoring-rules.md` §2「不足 10 个时可忽略不计」，不计入扣分。

**R7-M1（Major，维度 7.3，−2）— 测试套件非独立 → flaky**

- **问题**：两个 E2E 文件共用同一真实 MySQL/Mongo 库 `mongo_store_e2e`，且各自在 `before`/`reset` 中对同名表执行
  `DROP TABLE IF EXISTS` / `CREATE TABLE` / `DELETE FROM`（`fed_orders*`、`my_posts*`）。文件或进程重叠时互相清空 fixture：
  实测全量套件 ≈6% 失败率，6 进程并发同文件 5/6 失败；失败表现为 `4 !== 2`（联邦结果被污染）与
  `Table 'mongo_store_e2e.my_posts_deleted' doesn't exist`（表被他方 DROP）。
- **标准出处**：ISTQB F.I.R.S.T（Independent / Repeatable）；ISO/IEC 25010 可靠性-成熟性；
  `dimension-7-testing.md`「顺序依赖 / flaky：−2/处 Major」。
- **修复建议**：① 每文件使用**私有命名空间**（`<file>_<pid>_<rand>` 后缀的库/表名）或改用 `:memory:` / 容器化实例；
  ② `before` 中的 `DROP/CREATE` 仅作用于本文件私有表，禁止触达共享表；③ CI 加 `--test-concurrency=1` 仅作缓解，不能替代数据隔离；
  ④ 增补「并发运行同文件必须稳定通过」的隔离守卫用例，防止回归。
- **跨维度归属**：同问题在维度 7.4（组织）亦有体现，按规则仅在最相关主维度 7.3 全额扣分，不重复计。

**R7-m1（Minor，维度 2.1，−0.5）— 索引创建失败未接入统一反馈通道**

- **位置**：`src/index.js:216-218`。
- **问题**：`catch` 后仅 `console.error('[MongoStore] 创建索引失败 ...')` 便继续执行，无 `code`/`hint`，
  宿主无法通过 `setFeedbackSink` 接管——与本项目 v1.1.0 确立的「统一反馈事件通道（允许拦截，禁止静默失守）」原则不一致
  （对照 `feedback.js:27-37`、`datasource.js:229`、`query.js:92` 均已接入）。
- **标准出处**：项目自身规范（feedback 通道统一）；ISO/IEC 25010 可维护性-可分析性；`dimension-2-reliability.md` 2.1。
- **修复建议**：改为先 `feedback.emit({ type:'index_create_failed', code:'indexCreateFailed', layer:'init', message, hint })`，
  由通道决定落 stderr 还是宿主 sink；保留原日志作无 sink 时的兜底。

**R7-m2（Minor，维度 4.3，−0.5）— SQLite 执行器同步 API 在 async 契约内阻塞事件循环**

- **位置**：`src/executors/sqlite.js:30-45`（`db.prepare(...).all()/run()` 同步调用，外层却为 `async exec` / `async withTransaction`）。
- **问题**：`better-sqlite3` 为同步驱动，在 async 契约内会阻塞事件循环，并发下放大尾延迟；
  项目自己的压测报告已实测 p95 33 ms / max 140 ms，并明确「SQLite 写路径改 worker 线程」为待办。
- **标准出处**：ISO/IEC 25010 性能效率-时间行为 / 资源利用；`dimension-4-performance.md` 4.3；Node 官方「不要阻塞事件循环」。
- **修复建议**：将 SQLite 同步调用移入 `worker_threads`（或改用异步 SQLite 驱动）以释放事件循环；
  短期至少在执行器头部显式标注「同步阻塞，勿用于高并发主链路」并给出替代建议。
- **说明**：属已选型驱动的固有约束且项目已自认，故记 Minor 而非 Major。

**R7-m3（Minor，维度 6.1，−0.5）— 形参 `require` 遮蔽 CommonJS `require`**

- **位置**：`src/schema.js:114` `function setRequireContext(require = true)`。
- **问题**：形参名 `require` 遮蔽模块级 CommonJS `require`（当前函数体内恰好未调用 `require`，故无功能缺陷），
  属命名欠佳与潜在陷阱：后续若在该函数内新增 `require(...)` 会直接抛 `TypeError`。
- **标准出处**：SonarQube S2137（Built-in name shadowing）；Clean Code 命名；`dimension-6-conventions.md` 6.1。
- **修复建议**：形参改名为 `flag` / `enabled`（`store.setRequireContext(enabled)` 调用点无需变更）。

**R7-m4（Minor，维度 5.2，−0.5）— introspect 层 `_groupIndexes` 重复实现**

- **位置**：`src/introspect/mysql.js:46-58` 与 `src/introspect/postgres.js:67-79`。
- **问题**：两个 ~12 行的索引归并函数逻辑近乎逐行相同，唯一差异是唯一性判定入参（`nonUnique` 取反 vs `unique` 直取），
  属复制粘贴式轻微重复（重复率 <3%，故记 Minor 而非更高）。
- **标准出处**：DRY / Clean Code；`dimension-5-maintainability.md` 5.2；`scoring-rules.md` §5 重复率。
- **修复建议**：抽 `src/introspect/_shared.js#groupIndexes(rows, uniqueOf)` 供两处共用；
  executors 三后端的 `runStmts` 因驱动 API（`execute` / `query` / `prepare`）差异属必要分化，**不建议强抽**。

**Info 备查（不计分）**

- **R7-I1** `src/feedback.js:33-36`：默认 stderr 输出未中和换行/控制字符（CWE-117 日志注入模式）；
  但当前入参均来自框架内部（dialect code / 联邦 degraded 描述），**无外部直接可达路径**，故仅记 Info。
  建议改为对 `message`/`hint` 做单行化（替换 `\r?\n`）。
- **R7-I2** `src/crud/exec.js:80-82`：Mongo 归档 `upsertById` 逐条 `replaceOne` 串行往返，批量归档时可改 `bulkWrite` 降 RTT。
- **R7-I3** `src/executors/index.js:29-34`：`_scalar` 取 `Object.values(row)[0]`，依赖「聚合结果单列」假设；
  当前仅 `countDocuments` 使用且 dialect 输出固定单列，安全，建议加断言注释。
- **R7-I4** `src/datasource.js:28`、`src/schema.js:20,23`：模块级可变单例（`_connections` / `_schemas` / `_asyncFns`）——
  与前轮 m-4 同一项，属「与 py-store 对齐的既定设计」；本轮复核仍维持现状，**不重复扣分**。
  需注意：该单例也是 R7-M1 中「同进程内多测试文件互相覆盖连接」的放大器，修 R7-M1 时宜一并考虑。

#### 六、亮点（+3.5）

| # | 亮点 | 证据 | 加分 |
|---|---|---|---|
| 1 | **架构：Rust 单核心 + 双薄 Host**，Host 只做「驱动 IO + 回调 + 占位符替换」，全仓库 `src/` 仅 1,789 行且单一 IO 边界（`crud/exec.js`），业务逻辑零重复 | `src/index.js:3-12` 模块契约；`src/crud/index.js:3-20` 分工声明；单文件最大 229 行 | +1.0 |
| 2 | **容错/防御超出要求**：归档幂等（`upsertById` → `replaceOne(upsert)` / SQL `ON CONFLICT`）、单一 SQL 源步骤序列整体事务化、下推 unsupported 结构化拒绝而非静默返回错结果、统一反馈通道「允许拦截、禁止静默失守」、原生加载生产安全双开关 | `src/datasource.js:133-152,212-234`；`src/crud/exec.js:77-84`；`src/core.js:16-34,36-42` | +1.0 |
| 3 | **文档/契约质量突出**：README 覆盖多源定位三元组、fail-secure、高级 API、事务边界与信任边界；CHANGELOG 含 Breaking Changes + Migration；另有独立测试报告与压测报告（含与 py-store 的量化对比） | `README.md`、`CHANGELOG.md`、`doc/2026-09-12-*.md` | +1.0 |
| 4 | **跨语言同构 Host 契约对拍**：JS 与 Python 两侧 Host 共用 `rust-store/fixtures/host/*.json`（占位符 / truthy / ID 池 / 回调桥）逐条深比较，把「双宿主语义漂移」变成可执行断言 | `tests/host-contract.test.js:28-141`（含 `py-store/tests/test_host_contract.py` 对拍说明） | +0.5 |

合计 **+3.5**（≤5）。

#### 七、与前轮（100 分定向复评口径）对比

| 项 | 第 4/5 轮（定向复评） | 第 7 轮（全量） | 变化 |
|---|---|---|---|
| 口径 | 只回补原清单已闭环项扣分，不全量重扫 | 全量重扫 21 src + 8 test 文件并实跑取证 | — |
| 维度 7 测试 | 10.0 | **8.0** | **−2.0**（R7-M1 flaky） |
| 维度 6 规范 | 10.0 | **9.5** | −0.5（R7-m3） |
| 维度 5 可维护性 | 15.0 | **14.5** | −0.5（R7-m4） |
| 维度 2 可靠性 | 10.0 | **9.5** | −0.5（R7-m1） |
| 维度 4 性能 | 10.0 | **9.5** | −0.5（R7-m2） |
| 维度 1 / 3 / 8 / 9 | 15 / 15 / 5 / 10 | 15 / 15 / 5 / 10 | 持平 |
| Σ 维度分 | 100.0（封顶） | **96.0** | −4.0 |
| 亮点加分 | +3.5 | +3.5 | 持平 |
| **总分** | **100（S）** | **99.5（S）** | **−0.5** |
| 前轮结论校核 | 「`npm test` 81/81 全绿」 | **该主张不可复现**：全量套件 ≈6% 失败率、并发 5/6 失败 | **结论被推翻** |

**对比说明**

1. 前几轮的 100 分是**定向复评口径**的结果——只把已闭环项的扣分补回，未对清单之外重新扫描，
   因而无法反映 R7-M1~m4 这类**清单外问题**。本轮全量口径下 Σ 维度分实为 96.0。
2. 总分仅回落 0.5 分（100 → 99.5）具有误导性：分值口径是「逐维度扣分」，
   单项 Major 只在其所属维度扣 2 分；**维度级 7 从 10.0 → 8.0 才是真实回归幅度**。
3. 前轮「81/81 全绿」的验证主张**不成立**（第 3 轮、第 6 轮均以此为据）；
   建议后续所有「测试通过」结论一律注明是**单文件串行运行**还是**全量/并发运行**。
4. 前轮维持项（m-4 模块级单例、I-1 `$pipeline` 默认放行、I-3 mock 保真度、I-4 `_toCoreDefn` 深拷贝）
   本轮复核**结论不变**：均为既定设计取舍或重复防线，维持现状且不重复扣分。
5. 除上述 5 条外，维度 1 / 3 / 8 / 9 **未发现新问题**，故不扣分：
   维度 1 复核了契约完整性、占位符未命中保留语义、`_truthy`/`_newIdPool` 与 core 对齐、时间戳单位注入、SQL/Mongo 返回值塑形等价性；
   维度 3 复核了 SQL 参数化与标识符转义（有注入用例实证）、权限错误前缀映射、`routeOverride` 受信红线、原生加载双开关、凭据外置；
   维度 8 复核了 README/CHANGELOG/模块注释与文档-代码一致性；维度 9 复核了分层边界、依赖方向、可插拔后端与契约先行。

#### 八、结论

1. **Blocker / Critical：清零。** 未命中一票否决清单任一条（无 RCE/SQL 注入可利用/硬编码生产凭据/越权可利用/无事务破坏性批量写/认证绕过/恶意代码）。
2. **Major：未清零 —— 1 条（R7-M1 测试套件 flaky / 非独立）。** 该项为本轮新增发现，且**推翻**前几轮「81/81 全绿」的验证主张。
3. **Minor：4 条（R7-m1~m4）全部新增、未修复**；Info 4 条（<10，不计分）。
4. **总分 99.5 / 100，等级 S（≥90）**，但**不满足定稿条件**（存在未清零 Major + 新增问题），
   故本轮**不标注为「已完成」**，建议：先修复 R7-M1（测试数据隔离）→ 复跑全量套件 ≥10 次确认稳定 → 再复评定稿。
5. R7-m1~m4 为低风险改进项，可随下一次迭代批量处理，无阻塞。

---

### 第 8 轮 · 整改与复评（2026-09-13）

> 闭环：第 7 轮全部问题（**R7-M1 + R7-m1~m4**），Major 清零。
> 复评口径：与第 7 轮同（全量口径重算），回归取证为 `npm run lint` / `npm test`（全量，LOCAL_CORE=1）/ `npm run test:coverage`（门禁）。

#### 一、逐项整改说明

| 编号 | 整改方式 | 涉及文件 |
|---|---|---|
| R7-M1 | 两个 e2e 文件改用**各自独立库**：federation → `mongo_store_e2e_fed`、real-backends → `mongo_store_e2e_real`（MySQL database / PG database / Mongo db 同名各自独立），`before`/`reset()` 的 DROP/CREATE/DELETE 只碰本库；默认连接串内嵌独立库名，且 `MYSQL_URI` / `PG_URI` / `MONGO_URI` 环境变量可整串覆盖以便 CI 复用。文件头注释写明隔离约定（ISTQB Independent/Repeatable） | `tests/federation-e2e.test.js`、`tests/real-backends-e2e.test.js` |
| R7-m1 | 索引创建失败由仅 `console.error` 改为统一反馈通道 `feedback.emit({ type:'index_create_failed', code:'indexCreateFailed', layer:'host', message, hint })`；无 sink 时由 feedback 默认 stderr 输出承担兜底语义，**不双份打印**。新增回归测试：`init()` 中 createIndex 抛错时 sink 收到该事件且 init 不中断 | `src/index.js`、`tests/index-feedback.test.js`（新增） |
| R7-m2 | **文档级整改**（按第 7 轮建议的短期方案，不改造成 worker）：sqlite 执行器模块头补「⚠️ 同步阻塞说明」（better-sqlite3 同步驱动在 async 契约内阻塞事件循环，属有意设计选择；高并发主链路用 MySQL/PG/Mongo 或独立进程），`runStmts` 注释同步标注；`executors/index.js` 导出处加同类提示并回链；README「Supported backends」表 SQLite 行补 sync driver 说明与替代建议 | `src/executors/sqlite.js`、`src/executors/index.js`、`README.md` |
| R7-m3 | 形参 `require` 改名 `needCtx`（消除对 CJS `require` 的遮蔽）；Grep 复查发现 `src/index.js:137` Store 方法 `setRequireContext(require = true)` 为同类遮蔽点，一并改名；两处调用点（tests/require-context.test.js）均为位置传参，零变更 | `src/schema.js`、`src/index.js` |
| R7-m4 | mysql/postgres 两份 `_groupIndexes` 逐行比对：归并逻辑完全一致，唯一差异是唯一性判定入参（MySQL `nonUnique` 取反 vs PG `unique` 直取）→ 抽取共享单份 `introspect/_shared.js#groupIndexes(rows, uniqueOf)`，差异经 `uniqueOf` 参数化，两侧各留一行注释说明判定来源，**行为零变更**（复评实测 e2e introspect/syncSchema 用例全绿） | `src/introspect/_shared.js`（新增）、`src/introspect/mysql.js`、`src/introspect/postgres.js` |

#### 二、实测验证（全部来自实际运行）

| 项 | 命令 | 实测结果 |
|---|---|---|
| Lint | `npm run lint` | **exit 0；0 违规 / 0 告警** |
| 全量测试 · 连跑稳定性 | `npm test` × 10（两个 5 连跑批次） | **10/10 次 exit 0**；后一批次逐次记录 `pass=82 fail=0 skipped=0`。测试用例数 81 → **82**（新增索引失败反馈用例；6 套件不变） |
| 并发验证（不互相清库） | 两个 e2e 文件**同时各一进程**，连做 3 轮（共 6 进程） | **6/6 通过**：federation 2/2 ×3、real-backends 23/23 ×3，无 `ER_NO_SUCH_TABLE`、无结果污染 |
| 覆盖率门禁 | `npm run test:coverage`（c8 --all，门禁 90/90/85/75） | exit 0 通过；新增 `_shared.js` 覆盖率 **100%** |
| 单文件 e2e | `node --test tests/federation-e2e.test.js` / `tests/real-backends-e2e.test.js` | 2/2 与 23/23 全绿 |

边界说明（如实记录）：R7-M1 的隔离口径为「**每文件独立库**」。同文件多实例并发（如 3 个进程同时跑 federation-e2e）仍共享该文件的库、会互踩 fixture——实测确实如此，属本设计范围外（需 per-pid 库名才可解）；node:test 全量运行形态（每文件单进程、文件间并发）已被上述并发验证覆盖。

环境准备记录：本地 MySQL（root）与 PostgreSQL（postgres）以管理员新建 `mongo_store_e2e_fed` / `mongo_store_e2e_real` 并授权 `e2e` 账号（`GRANT ALL ON db.*` / `CREATE DATABASE ... OWNER e2e`）；Mongo 库随首写隐式创建。两测试文件头注释已写明库名约定与环境变量覆盖方式，可照此在任何环境复现。

#### 三、更新总分（按第 7 轮全量口径重算）

| # | 维度 | 第 7 轮 | 第 8 轮 | 回补依据 |
|---|---|---|---|---|
| 1 | 功能正确性 | 15.0 | 15.0 | 不变 |
| 2 | 可靠性 | 9.5 | **10.0** | R7-m1 关闭：兜底/降级/拦截全部走统一反馈通道，异常处理无静默失守 |
| 3 | 安全性 | 15.0 | 15.0 | 不变 |
| 4 | 性能效率 | 9.5 | **10.0** | R7-m2 关闭（按第 7 轮建议的短期方案）：同步阻塞面显式文档化并给出替代路径；worker 化列为长期优化项 |
| 5 | 可维护性 | 14.5 | **15.0** | R7-m4 关闭：重复实现归一为共享单份 |
| 6 | 可读性与规范 | 9.5 | **10.0** | R7-m3 关闭：内置名遮蔽清零（含同批发现的 index.js 同类点） |
| 7 | 测试质量 | 8.0 | **10.0** | R7-M1 关闭：独立性/可重复性恢复并有实测证据（10 连跑全绿 + 双文件并发 6/6） |
| 8 | 文档与可理解性 | 5.0 | 5.0 | 不变 |
| 9 | 架构与设计 | 10.0 | 10.0 | 不变 |
| — | Σ 维度分 | 96.0 | **100.0** | |
| + | 亮点加分 | +3.5 | +3.5 | 不变 |
| — | **总分** | 99.5 | **100（封顶，S 卓越）** | 100.0 + 3.5 = 103.5 触顶取 100 |

#### 四、结论

1. **Blocker / Critical / Major：全部清零**；Minor（R7-m1~m4）全部整改（R7-m2 为文档级）；Info 4 条维持已评估。
2. 第 7 轮「不满足定稿条件」的两条障碍（存在未清零 Major、存在新增未修复问题）均已消除；第 7 轮 → 第 8 轮等级同为 S、问题收敛且无新增 C 及以上问题，**满足定稿条件**，本报告至此定稿。
3. 后续建议（不阻塞定稿）：① SQLite 写路径 worker 线程化（R7-m2 长期项，压测报告已列待办）；② 如 CI 需要同文件并行矩阵，再评估 per-pid 库名隔离；③ 反馈通道默认 stderr 输出的换行/控制字符单行化（R7-I1，Info 备查）。
