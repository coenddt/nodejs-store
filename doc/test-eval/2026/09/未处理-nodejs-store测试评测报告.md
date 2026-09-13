# nodejs-store 测试评测报告

> 本报告由 `.trae/skills/test-evaluation` SKILL 流程产出：九维检查项清单 → 全量实跑 → 达成度判定 → 缺陷定级 → 评分。
> 证据根目录（下称 `E`）= `f:\独立开发者\项目\mongo-store\tmp\test-eval\`，全部原始日志落盘于 `E*.log / E*.out`。

## 0. 元信息

| 项 | 值 |
|---|---|
| 评测对象 | `nodejs-store`（mongo-store 多后端数据层 Node 薄 Host），版本 **1.1.0**，commit **efa7638** |
| 评测范围 | 全仓（`src/` 全模块 + `tests/` + `scripts/` + `.github/workflows/`），不改动被测代码 |
| 评测维度 | 九维（功能 / 边界 / 组合 / 交互 / 压力 / 兼容 / 安全 / 回归 / 测试工程） |
| 评测环境 | Windows（本机）；**Node v25.1.0**；MySQL 8.0.42 / PostgreSQL 16.4 / MongoDB 8.0.12 / SQLite 3.50.4；原生产物 `rust-store-node`（core-node，`LOCAL_CORE=1` 本地兜底加载 `rust-store/core-node/dist/rust-store-node.node`） |
| 实测执行 | 26 条命令 / 探针（含 81 项单测、25 项 E2E、23 项补充探针、51 项 core 探针、4 进程并发验证、2 档压测、覆盖/lint/audit）；日志见 §7；评测日期 **2026-09-12** |
| 评测标准 | ISO/IEC/IEEE 29119-1..4、ISO/IEC 25010/25023、ISTQB CTFL 4.0、OWASP Top 10 2021 / ASVS / WSTG、MITRE CWE Top 25、F.I.R.S.T、SonarQube Quality Gate、DORA |
| 本轮总分 | **68.3 / 100（C 合格）** |

> **架构前提**：nodejs-store 为薄 Host，查询/权限/管道规划等核心逻辑全部来自共享的 Rust 单核心（`rust-store/core`）。因此 core 级缺陷（D-01/D-02/D-03/D-06/D-07/D-08）在本仓同样成立，本报告对其**负连带责任**。

## 1. 执行摘要

- **一句话结论**：功能主链路、四后端真实库、契约对拍、覆盖率门禁与重复执行稳定性均达标，覆盖率门槛进 CI 且实测达标为三仓唯一；但被**共享核心的两个 Critical 缺陷**（GQL 关系带参+子选择集解析失败、`$where` 载荷致条件静默丢失）拖累，只能判为「合格」。
- **最严重问题（≤3 条）**：
  1. **D-02（C）**：`$where` 恶意载荷使条件**静默丢弃**，查询返回全量数据（`rows=85`），且无任何告警事件（`unsupported=[]`）——结果静默错误（§4）。
  2. **D-01（C）**：README 记载的「关系带参 + 子选择集」GQL 语法解析失败，Node / Python 双绑定表现一致（§4）。
  3. **D-05（M）**：`tests/real-backends-e2e.test.js` 使用固定表名 + 破坏性 DDL，多进程并发执行互相踩表致 E2E 大面积失败，测试不具备并行安全性（§4）。
- **最突出亮点（≤3 条）**：
  1. 唯一**覆盖率门槛进 CI 且实测达标**的仓库：`c8 --check-coverage --statements 90 --lines 90 --functions 85 --branches 75`，实测 `92.69 / 77.3 / 87.8`（`Ejs-coverage.log`）。
  2. CI 为 `eslint 零告警 + test:coverage` 双门禁（`.github/workflows/ci.yml`），lint 实测 `exit 0`（`Ejs-lint.log`）。
  3. 契约与分层完备：黄金 fixtures 三侧复算 3/3 一致（`Erust-verify-fixtures.log`），`tests/` 含 guards / host-contract / multi-datasource / require-context / federation-e2e / real-backends-e2e 六类。
- **与上一轮对比**：仓库内既有 `doc/2026-09-12-测试报告.md` 与 `doc/code-review/2026/09/已完成-nodejs-store评测报告.md`。本轮为**首次九维实跑评测**，不可直接比对分数；仅性能项与既有压测基线可比（见 §3.5）。

## 2. 评分卡

| # | 维度 | 满分 | 达成率 R | 缺陷扣分 P | 维度分 | 主要失分原因 |
|---|------|------|----------|------------|--------|--------------|
| 1 | 功能正确性 | 15 | 0.833 | 5.5 | **7.00** | D-01（C，−5）；幂等性缺回归（m，−0.5）；F3/F5/F7 仅部分覆盖 |
| 2 | 边界值与极值 | 12 | 0.682 | 0.5 | **7.68** | `$limit` 非法类型未校验（m，−0.5）；上限+1、集合超限、时间戳极值无显式断言 |
| 3 | 组合与等价类 | 10 | 0.800 | 0 | **8.00** | 状态迁移/类型组合/异常叠加/组合剪裁说明仅部分覆盖 |
| 4 | 交互与集成 | 12 | 0.875 | 2.0 | **8.50** | D-03（M，−2，绑定序列化边界）；I9 并发隔离未通过；I6/I7 部分覆盖 |
| 5 | 压力与性能 | 12 | 0.750 | 0 | **9.00** | 无 p99、无分段稳定性观测、无性能门禁（S10=0）；吞吐基线对照受评测环境干扰不可归因（§3.5 注） |
| 6 | 兼容性 | 10 | 0.727 | 0 | **7.27** | 运行时/平台/后端版本均单点验证，兼容矩阵未进 CI（M9=0） |
| 7 | 安全测试 | 12 | 0.833 | 5.5 | **4.50** | D-02（C，−5）；联邦上限错误文案错乱（m，−0.5）；X1/X5 部分覆盖 |
| 8 | 回归与质量门禁 | 9 | 0.818 | 0 | **7.36** | CI 无 DB service 致真实后端 E2E 恒 skip（G4=0.5）；发布前不跑测试（G6=0.5） |
| 9 | 测试工程与可复现性 | 8 | 0.808 | 2.0 | **4.46** | D-05（M，−2，并行安全/数据隔离）；T1 独立性仅部分验证；T9 文档不全 |
| — | 小计 | 100 | — | 15.5 | **63.77** | |
| — | 亮点加分 | ≤5 | — | — | **+4.50** | 黄金对拍 +2；负向体系 +1.5；覆盖率门槛进 CI +1 |
| — | **总分** | 100 | — | — | **68.3** | |

等级：**C 合格**；否决项核查：**无**（V1–V5 均未命中，详见 §3.7）。
> 等级约束核对：本仓存在 2 条 Critical（维度 1、7）→ 按 §6 等级映射，「B 良好」要求 `C ≤ 1` 不成立，故等级判为 C，与本轮 68.3 自洽。

## 3. 维度明细

### 3.1 功能正确性（满分 15）

| # | 检查项 | w | d | 加权 | 实测证据（命令/日志） | 说明 |
|---|--------|---|---|------|----------------------|------|
| F1 | 读路径闭环 | 2 | 1.0 | 2.0 | `Ejs-npm-test.log`（`crud.query/queryOne/queryWithCount/exists/count` 全绿）；`Ejs-coverage.log:30-75` 四库 E2E；`Ejs-e2e.log` 25 passed | 断言具体字段值与条数 |
| F2 | 写路径闭环 | 2 | 1.0 | 2.0 | `Ejs-coverage.log:84-96`（insert/insertMany/update/updateMany/remove/upsert/mutation）+ 写后回读 | 四后端均含 `_id` 还原断言 |
| F3 | GQL/查询语义 | 2 | 0.5 | 1.0 | 正向：`Ejs-coverage.log:5-8`（跨库联邦嵌套关联、排序、投影）；反向：**D-01**（`Edefect-d01-recheck.log` V3/V4/V6/V7/V10 全 ERR） | 嵌套关系「带参+子选择集」不可用，反向用例暴露功能错误 |
| F4 | 写入派生语义 | 1 | 1.0 | 1.0 | `Ejs-coverage.log:10-12`（`timestamps:"s"` 秒级 / 缺省毫秒 / 非法值注册即报错）；`crud.insert 自动 ID + 时间戳` | 含秒与毫秒两态 |
| F5 | 事务与多步原子性 | 1 | 0.5 | 0.5 | `Ejs-coverage.log:91`（remove = 归档 + 物理删除） | 无失败注入用例；「非原子」语义未被测试确认 |
| F6 | 错误语义 | 1 | 1.0 | 1.0 | `Ejs-probe-bcise.log:9`（PermissionError: 无写入权限）、`:10`（未注册 source 明确报错）、`:22`（UNIQUE constraint failed） | 断言具体错误类型/信息 |
| F7 | 幂等性 | 1 | 0.5 | 0.5 | `crud.upsert 按条件命中/生成新 ID`、`crud.insertMany 空数组返回空` | 重复 register 同名 schema 产生重复条目（**D-06**），幂等性不完整 |
| F8 | 真实依赖下的正确性 | 1 | 1.0 | 1.0 | `Ejs-coverage.log:30-62`（MySQL/PG/Mongo 真实库 + 三者 syncSchema） | 连接信息见 §0 环境 |
| F9 | 跨实现一致性 | 1 | 1.0 | 1.0 | `Erust-verify-fixtures.log`：`Rust core / core-node / core-py` 三侧复算 **3/3 一致** | 冻结黄金基准 |

- **R** = Σ(w×d)/Σw = 10.0 / 12 = **0.833**；**P** = 5.0（D-01）+ 0.5（D-06）= **5.5**；**维度分** = 15×0.833 − 5.5 = **7.00**
- 本维度缺陷：D-01（C）、D-06（m）

### 3.2 边界值与极值（满分 12）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| B1 | 数值边界 | 1 | 0.5 | 0.5 | `Ejs-probe-bcise.log:22`（重复 `_id` 报错）、`Ejs-probe-bcise.log:6`（`$limit 1e9` 截断 rows=4） | `$limit="abc"` 未被校验（**D-07**） |
| B2 | 空与缺省 | 2 | 1.0 | 2.0 | `Ejs-probe-bcise.log:2,12`（空串/null/0/false 写入回读，`title=''`、`views=0` 断言通过；sqlite+mongo 双路径） | null 在 string 字段回落 `''` |
| B3 | 集合长度边界 | 1 | 0.5 | 0.5 | `crud.insertMany 空数组返回空`、`crud.mutation 空数组返回空数组` | 批量上限（超限批量）无用例 |
| B4 | 分页与游标边界 | 2 | 0.5 | 1.0 | `crud.queryWithCount pageSize 上限 5000`（断言）；`Ejs-probe-bcise.log:6`（1e9 截断） | 宿主层缺「上限+1」显式断言（core 探针 B-15/B-21 有，见 §3.5 注） |
| B5 | 字符串边界 | 1 | 1.0 | 1.0 | `Ejs-probe-bcise.log:3,13`（emoji/中文/组合字符/零宽 roundtrip 保真）；`:4,14`（1 万字符 roundtrip 长度不失真） | CJK + emoji + 超长三类齐备 |
| B6 | 时间边界 | 1 | 0.5 | 0.5 | `Ejs-coverage.log:10-12`（秒/毫秒两态 + 非法单位拒绝） | epoch / 负时间戳 / 时区未覆盖 |
| B7 | 结构深度边界 | 1 | 0.5 | 0.5 | core 探针 B-06（深度 10 通过）/ B-07（深度 11 报错） | 宿主层无深度用例；越界文案与 D-01 纠缠 |
| B8 | 状态与资源边界 | 1 | 0.5 | 0.5 | `Ejs-probe-bcise.log:10`（routeOverride 指向未注册 source 明确报错） | 超时 / 断连 / 重试 / 超长标识符未覆盖 |
| B9 | 边界断言质量 | 1 | 1.0 | 1.0 | `Ejs-probe-bcise.log:22` 断言具体错误串；`:7` 断言 `queryOne` 未命中返回 `null` | 断言具体值/错误，非「不崩溃」 |

- **R** = 7.5 / 11 = **0.682**；**P** = 0.5（D-07）；**维度分** = 12×0.682 − 0.5 = **7.68**
- 本维度缺陷：D-07（m）

### 3.3 组合与等价类（满分 10）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| C1 | 等价类划分显式性 | 1 | 1.0 | 1.0 | `Ejs-coverage.log:30-75` 四后端 × 七命令参数化表，划分维度可直接读出 | |
| C2 | 多参数组合覆盖 | 2 | 1.0 | 2.0 | 同上（后端 × 命令 × 条件：4×7=28 组合）；`Ejs-probe-bcise.log` sqlite×mongo 双路径 | |
| C3 | 权限/规则决策表 | 2 | 1.0 | 2.0 | core 探针 `rust-probe-bcise.log:27-41`：5 角色 × 读/写 + `requireContext × ctx × 读/写` 8 例决策表 | 含拒绝分支与具体报错 |
| C4 | 状态迁移组合 | 1 | 0.5 | 0.5 | `Ejs-probe-bcise.log:23`（remove 后主表 0 / 归档 1） | 缺非法迁移（对已删记录再更新/再删）负向用例 |
| C5 | 类型组合 | 1 | 0.5 | 0.5 | string / number 两型覆盖 | bool / date / object / null 型 × 后端组合不足 |
| C6 | 配置/开关组合 | 1 | 1.0 | 1.0 | `Ejs-coverage.log:63-67`（require_context 开/关 × 读/写 × 无/用户/系统 ctx）；core 探针 I-01（多 Registry 实例开关隔离） | 2×2 组合已验证 |
| C7 | 异常组合 | 1 | 0.5 | 0.5 | `PushdownUnsupportedError 结构与 feedback() 投影`（下推不支持 → 反馈事件） | 多失败点叠加（写失败+回滚失败）无 |
| C8 | 组合剪裁说明 | 1 | 0.5 | 0.5 | CI 与 `tests/` 有分层说明 | 无显式组合策略/剪裁文档 |

- **R** = 8.0 / 10 = **0.800**；**P** = 0；**维度分** = **8.00**
- 本维度缺陷：无

### 3.4 交互与集成（满分 12）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| I1 | 测试分层结构 | 2 | 1.0 | 2.0 | 单元/契约 81 项 + E2E 25 项（`Ejs-npm-test.log` / `Ejs-e2e.log`），E2E 占比 24% | 未失衡 |
| I2 | 契约测试 | 2 | 1.0 | 2.0 | `Erust-verify-fixtures.log`（fixtures 3/3）+ `host contract: resolvePlaceholders / _truthy / _newIdPool / callback bridge` | 有共享 fixture 消费链路 |
| I3 | 全链路集成 | 1 | 1.0 | 1.0 | `Ejs-probe-bcise.log:23`（insert→remove→主表/归档表终态断言）；联邦 A5/A6 断言最终值 | |
| I4 | 真实依赖集成 | 2 | 1.0 | 2.0 | `Ejs-coverage.log:30-62`：MySQL / PostgreSQL / MongoDB 真实实例全 CRUD | |
| I5 | 异步与回调交互 | 1 | 1.0 | 1.0 | `host contract: callback bridge (fn + asyncFn)`；`feedback sink 回调与默认 stderr` | |
| I6 | 事务与连接交互 | 1 | 0.5 | 0.5 | `identifier safety: 恶意 field 名加引号后安全，且连接可复用` | 无事务边界用例；连接泄漏未验证 |
| I7 | 测试替身保真度 | 1 | 0.5 | 0.5 | 测试以真实库为主、mock 少 | **D-03** 证明「绑定序列化边界」无替身/断言覆盖，保真度未被识别 |
| I8 | 跨进程/并发交互 | 1 | 1.0 | 1.0 | `Ejs-probe-bcise.log:7,8`（Promise.all 30 并发读写一致、50 并发 ID 唯一）；`Emultiprocess-verify.log`（4 进程 160 条：唯一性/无丢失/分布 3/3 PASS） | |
| I9 | E2E 数据隔离与可重复 | 1 | 0.5 | 0.5 | `Epar-node-a.out`（并发跑 MySQL/PG/Mongo E2E 全 ✖）/ `Epar-node-b.out`（23 passed） | 有并发实跑证据但**未通过**（**D-05**） |

- **R** = 10.5 / 12 = **0.875**；**P** = 2.0（D-03）；**维度分** = 12×0.875 − 2.0 = **8.50**
- 本维度缺陷：D-03（M）；D-05 归属维度 9，避免重复扣分

### 3.5 压力与性能（满分 12）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| S1 | 压测资产可运行 | 2 | 1.0 | 2.0 | `Ejs-stress-8x200-rerun.log` / `Estress-smoke-tier.log`（`scripts/stress.js` 输出 `[RESULT]` JSON） | 模型含联邦链路（federation_ops 分项） |
| S2 | 负载档位 | 1 | 1.0 | 1.0 | 冒烟 1×10（`Estress-smoke-tier.log`）+ 负载 8×200（`Ejs-stress-8x200-rerun.log`） | 两档对比 |
| S3 | 指标完整性 | 1 | 1.0 | 1.0 | `qps / errors / errors_by_type / all_ops{p50,p95,max,avg} / federation_ops{...}` | 缺 p99 |
| S4 | 错误率 | 2 | 1.0 | 2.0 | 两档 `errors=0`（8000 ops） | 无错误可归因 |
| S5 | 吞吐基线对照 | 1 | 0.5 | 0.5 | 历史基线 **637.70 QPS** → 本轮 **560.62 QPS**；同轮对标 py-store 307.84 / rust-core 279.57 | 评测时段机器被外部任务占满（CPU 100%、磁盘近满，用户确认）→ 与基线差异**不可归因于产品**，仅记录实测值 |
| S6 | 尾延迟分析 | 1 | 0.5 | 0.5 | `all_ops p50=13 / p95=33 / max=183 ms`；`federation p50=19 / p95=32` | 无 p99；长尾有初步归因（联邦为主开销） |
| S7 | 瓶颈定位 | 1 | 0.5 | 0.5 | 推理链：联邦操作（1600/8000）主导耗时 | 无 CPU/内存/事件循环观测证据 |
| S8 | 稳定性与泄漏 | 1 | 0.5 | 0.5 | 仅单次 8×200 | 无前/中/后分段或浸泡 |
| S9 | 压测可信度 | 1 | 1.0 | 1.0 | 原始 `[RESULT]` 行落盘、命令可复现、表/库隔离（suffix `js`） | |
| S10 | 性能门禁 | 1 | 0.0 | 0.0 | `scripts/stress.js` 不进 CI（`.github/workflows` 无压测 job） | 无阈值断言 |

**吞吐对照表**

| 档位 | 规模 | QPS | errors | p50 (ms) | p95 (ms) | max (ms) |
|---|---|---|---|---|---|---|
| 冒烟 | 1×10 | 316.46 | 0 | 1.08 | 12.10 | 14.04 |
| 负载 | 8×200 | 556.79 → 复跑 **560.62**（时段受外部负载干扰，见下注） | 0 | 13 | 33 | 183 |
| 历史基线 | 8×200 | **637.70**（来源：`doc/2026-09-12-压测报告.md:36` @ 2026-09-12，**本轮未复跑**） | — | — | — | — |

> 注：评测时段机器被外部任务占满（CPU 100%、磁盘近满，用户确认），三仓吞吐与历史基线的差异不作产品缺陷计分（见 §8）。

- **R** = 9.0 / 12 = **0.750**；**P** = 0；**维度分** = **9.00**
- 本维度缺陷：无

### 3.6 兼容性（满分 10）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| M1 | 多后端等价性 | 2 | 1.0 | 2.0 | `Ejs-coverage.log:30-75`：MySQL/PG/Mongo/SQLite 四后端跑**同一套** E2E 断言全绿 | 声明后端全部实跑 |
| M2 | 方言差异专项 | 2 | 1.0 | 2.0 | `Ejs-coverage.log:33`「PG/SQLite RETURNING，MySQL 两段编排」+ `$inc` + upsert `_id` 冲突目标 | ≥2 项方言特性专项 |
| M3 | 多语言绑定等价性 | 1 | 1.0 | 1.0 | `Erust-verify-fixtures.log` 3/3 一致 | |
| M4 | 运行时版本兼容 | 1 | 0.5 | 0.5 | CI `node-version: 22`；release `node-version: 20`；本地实测 v25.1.0 | 无版本矩阵，`engines` 与实测未交叉验证 |
| M5 | 平台兼容 | 1 | 0.5 | 0.5 | CI 仅 `ubuntu-latest`；本轮 Windows 实跑通过 | 仅 1 平台有验证记录 |
| M6 | 后端版本兼容 | 1 | 0.5 | 0.5 | `Eenv-versions.log`：MySQL 8.0.42 / PG 16.4 / Mongo 8.0.12 / SQLite 3.50.4 | 仅单版本，无范围声明 |
| M7 | 编码与排序规则兼容 | 1 | 1.0 | 1.0 | `Ejs-probe-bcise.log:3,13`（Unicode roundtrip）；`identifier safety`（引号与大小写） | |
| M8 | 向后兼容 | 1 | 0.5 | 0.5 | 冻结 parity 快照可回归 | 无「旧用法零变更」专项用例 |
| M9 | 兼容矩阵自动化 | 1 | 0.0 | 0.0 | CI 无 DB service 容器、无 OS/版本矩阵 | 纯手工/单点验证 |

- **R** = 8.0 / 11 = **0.727**；**P** = 0；**维度分** = **7.27**
- 本维度缺陷：无

### 3.7 安全测试（满分 12）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| X1 | 注入防御 | 2 | 0.5 | 1.0 | 正向：`identifier safety: 未注册的 collection 直接报错（不拼接用户输入）`；反向：**D-02** `Ejs-probe-bcise.log:11,21`（`$where` 载荷 → `rows=85` 全量返回） | 条件被静默丢弃，注入防御不成立 |
| X2 | 权限矩阵 | 2 | 1.0 | 2.0 | `Ejs-probe-bcise.log:9`（guest 写被拒且错误类型为 `PermissionError`、消息含「无写入权限」、且越权数据未落库）+ core 探针 5 角色决策表 | 含拒绝分支与具体断言 |
| X3 | 越权防御 | 2 | 1.0 | 2.0 | `Ejs-probe-bcise.log:10`（routeOverride 指向未注册 source 明确报错、不静默回落）；`perm.scopedRoles`；`Edefect-d02-v1-mongo.log`（Mongo 路径带 owner 条件时 `$where` **未**越权读到他人数据） | 水平/垂直越权均有负向验证 |
| X4 | fail-secure 默认 | 1 | 1.0 | 1.0 | `Ejs-coverage.log:63-67`：默认 fail-open 且**显式文档化**，`require_context` 开启后缺 ctx 抛 `ERR_NO_CONTEXT` | 开关两态均有用例 |
| X5 | 恶意载荷 | 1 | 0.5 | 0.5 | **D-02**：`$where` 未被拦截；超深 GQL / 超大批量未覆盖 | 仅 1 类载荷且未通过 |
| X6 | 敏感信息暴露 | 1 | 1.0 | 1.0 | 错误消息为业务语义（如「无写入权限」「数据源未配置: xxx」），不含 SQL 原文/表结构 | 字段裁剪亦实测（`crud.query 带关系与排序仍返回裁剪结果`） |
| X7 | 资源耗尽防御 | 1 | 0.5 | 0.5 | `MAX_PAGE_SIZE=5000` 有上限断言；联邦行数上限错误文案错乱（**D-08**） | 上限存在但错误语义不符 |
| X8 | 凭据与配置安全 | 1 | 1.0 | 1.0 | 测试连接串 `e2e/e2e123` 仅指向本地测试库；workflow 一律走 `secrets`/OIDC，仓库内无 token | 风险等级：低 |
| X9 | 依赖漏洞 | 1 | 1.0 | 1.0 | `Ejs-npm-audit.log`：`found 0 vulnerabilities` | |

- **R** = 10.0 / 12 = **0.833**；**P** = 5.0（D-02）+ 0.5（D-08）= **5.5**；**维度分** = 12×0.833 − 5.5 = **4.50**
- 本维度缺陷：D-02（C）、D-08（m）
- **否决项核查**：V1 要求「越权读到他人数据」。`Edefect-d02-v1-mongo.log` 实测带 owner 条件的 `$where` 攻击载荷**未**读到他人数据（`越权可见他人=false`）；但 SQL 路径（`Edefect-d02-unsupported.log`：`$where` → `SELECT ... WHERE` 静默消失、`unsupported=[]`）构成「条件静默丢弃 / 结果静默错误」，按 §3 判 **C**，不构成 V1。

### 3.8 回归与质量门禁（满分 9）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| G1 | 测试套件全绿 | 2 | 1.0 | 2.0 | `Ejs-npm-test.log` 81 pass / 0 fail；`Ejs-e2e.log` 25 pass；`Ejs-repeat5.log` 5×`exit=0` | 见 §6 并发例外说明 |
| G2 | 回归基线 | 1 | 1.0 | 1.0 | `rust-store/fixtures/` 冻结快照 + `Erust-verify-fixtures.log` 3/3 复算 | 有生成器与消费链路 |
| G3 | 门禁完整性 | 2 | 1.0 | 2.0 | `.github/workflows/ci.yml`：`npm run lint`（eslint 零告警）+ `npm run test:coverage` | lint + test 双门禁齐备 |
| G4 | CI 与本地一致性 | 1 | 0.5 | 0.5 | CI 无 `services:` → `tests/real-backends-e2e.test.js` 走自带 skip 分支（源码 `if (!ctx.ready) return t.skip(ctx.reason)`）；本地真实库全绿 | 关键用例在 CI 恒 skip，形成盲区（项目自带 skip 机制，记 0.5） |
| G5 | 覆盖率门槛 | 1 | 1.0 | 1.0 | `Ejs-coverage.log:3` 阈值 `--statements 90 --lines 90 --functions 85 --branches 75`；实测 `92.69 / 92.69 / 87.8 / 77.3` **达标** | 三仓中唯一 |
| G6 | 发布流程校验 | 1 | 0.5 | 0.5 | `release-npm.yml:33-40` 校验 tag↔`package.json` version；但**发布前不跑测试** | 半覆盖 |
| G7 | 变更可追溯 | 1 | 1.0 | 1.0 | `CHANGELOG.md` 存在；git log 全为 Conventional Commits；SemVer 与 tag 对应 | 注：`package.json` 已 1.1.0 而 tag 止于 v1.0.0（未发版，非缺陷） |
| G8 | 缺陷回归固化 | 1 | 0.5 | 0.5 | 历史修复伴随用例（如 `require_context` 全路径用例）；但本轮 D-01/D-02/D-03 无回归用例 | 半覆盖 |
| G9 | 失败阻断能力 | 1 | 0.5 | 0.5 | `ci.yml` 在 `pull_request` 触发 | 无分支保护配置证据，阻断能力待确认 |

- **R** = 9.0 / 11 = **0.818**；**P** = 0；**维度分** = **7.36**
- 本维度缺陷：无。**G4 注**：CI 恒 skip 但仓库未在任何发布说明中宣称「真实后端测试全部通过」，故不构成 V4。

### 3.9 测试工程与可复现性（满分 8）

| # | 检查项 | w | d | 加权 | 实测证据 | 说明 |
|---|--------|---|---|------|----------|------|
| T1 | 独立性 | 2 | 0.5 | 1.0 | `Ejs-independence.log`：`guards.test.js` 7 pass、`host-contract.test.js` 4 pass、`multi-datasource.test.js` 9 pass 均 exit 0；但清单中 `tests/crud.test.js` **不存在**（实际为 `tests/test-nodejs-store.js`），第 4 项未取到证据 | 单点运行仅部分验证 |
| T2 | 可重复性 | 2 | 1.0 | 2.0 | `Ejs-repeat5.log`：5 次全量 `pass 81 / fail 0`，耗时 1398–1535 ms | flaky 率 = 0 |
| T3 | 并行安全 | 1 | 0.5 | 0.5 | `Epar-node-a.out`：并发跑真实后端 E2E 全部 ✖ | 有并发实跑但产生额外失败（**D-05**） |
| T4 | 数据隔离 | 1 | 0.5 | 0.5 | `tests/real-backends-e2e.test.js` 固定表名 + `DROP TABLE IF EXISTS` 破坏性 DDL | 隔离机制不成立（D-05 根因） |
| T5 | 可移植性 | 1 | 1.0 | 1.0 | 真实后端不可达走 skip（`if (!ctx.ready) return t.skip(ctx.reason)`）；无仓库外硬路径 | 实测 `LOCAL_CORE` 兜底亦生效 |
| T6 | 可维护性 | 1 | 1.0 | 1.0 | `tests/` 六文件职责清晰；共用 helper；`src/` 单文件均 < 300 行 | |
| T7 | 断言质量 | 2 | 1.0 | 2.0 | 抽查全部断言为具体值/具体错误串；无永真断言、无被吞异常 | |
| T8 | 执行时长 | 1 | 1.0 | 1.0 | 单测 1.61 s（24 个测试文件依次执行）；E2E 1.50 s | 远低于 5 min |
| T9 | 测试文档 | 1 | 0.5 | 0.5 | `README.md` **无**测试章节（grep `test|测试` 零命中）；`doc/2026-09-12-测试报告.md` 记录了结果但无运行说明/门槛/夹具来源 | 部分具备 |
| T10 | 覆盖广度 | 1 | 1.0 | 1.0 | 81 用例 / 22 源文件；语句覆盖 92.69% | 比例合理 |

- **R** = 10.5 / 13 = **0.808**；**P** = 2.0（D-05）；**维度分** = 8×0.808 − 2.0 = **4.46**
- 本维度缺陷：D-05（M）

## 4. 缺陷清单

| ID | 严重度 | 维度 | 标题 | 最小复现步骤 | 原始输出证据 | CWE/规则 | 影响面 | 修复建议 |
|----|--------|------|------|--------------|--------------|----------|--------|----------|
| D-01 | **C** | 1 | GQL「关系带参 + 子选择集」解析失败（共享核心） | `node tmp/test-eval/probes/_verify15.cjs`，观察 V3/V4/V6/V7/V10 | `Edefect-d01-recheck.log`：`V3 ERR 期望 id(undefined) 实际 p({) 位置 10`、`V4 ERR 位置 18`；Python 侧同样 `Edefect-d01-recheck-py.log` | CWE-20 | 三端（core 共享）；README 记载语法不可用 | 修正 GQL 语法分析：关系名后「参数列表 + 选择集」需可同时出现；补正向回归用例 |
| D-02 | **C** | 7 | `$where` 恶意载荷使查询条件静默丢弃、返回全量数据 | `node tmp/test-eval/probes/probe-js.cjs`（X-03，sqlite 与 mongo 双路径） | `Ejs-probe-bcise.log:11,21`：`$where 载荷导致全量泄露，rows=85`；SQL 侧条件静默消失：`Edefect-d02-unsupported.log`（`SELECT t."_id", t."name" FROM "v_parent" t`，`unsupported=[]`） | CWE-89 / CWE-943 / OWASP A03:2021 | 三端；结果静默错误（调用方无法区分「无数据」与「条件被丢弃」） | 不支持的条件键应**显式报错**而非静默丢弃；对 `$where`/`$function` 等键建立拒绝名单；补负向回归用例 |
| D-03 | **M** | 4 | 无 `idPrefix` 且未显式给 `_id` 时生成 `_id=undefined`，跨绑定序列化崩溃 | `node tmp/test-eval/probes/_verify11.cjs`；Python 侧 `_verify_py2.py` | `Eprobe-iso11.log`：`insert._id = undefined` → `query ERROR JS functions cannot be represented as a serde_json.Value`；`Eprobe-py-iso2.log`：`TypeError: 不支持的 Python 类型`；`Edefect-d03-rust-binding.log` | CWE-20（跨语言绑定序列化边界） | 三端（绑定层） | `_id` 缺失且无 `idPrefix` 时核心应显式报错或由绑定层统一兜底生成；补双向序列化契约用例 |
| D-05 | **M** | 9 | 真实后端 E2E 固定表名 + 破坏性 DDL，多进程并发互踩 | 两个进程同时执行 `tests/real-backends-e2e.test.js` | `Epar-node-a.out`：MySQL/PG/Mongo E2E 及 syncSchema 全部 ✖（每后端 7 项）；对照单进程 `Epar-node-b.out` 23 passed | —（测试可靠性） | 测试工程；CI 并行时会误报 | 表名/库名按进程或随机后缀隔离；改用 fixture 生命周期管理；补并发 job |
| D-06 | m | 1 | 重复 register 同名 schema 静默覆盖且 `list()` 出现重复条目 | `node tmp/test-eval/probes/probe-rust.cjs`（I-03） | `Erust-probe-bcise.log:72`：`list=4 second=ok`（重复注册后列表为 `["Dup","DupDeleted","Dup","DupDeleted"]`） | CWE-20 | 三端；Host 枚举 schema 时重复 | 同名覆盖时同步去重 `order`，或显式报错 |
| D-07 | m | 2 | `$limit` 非数值未校验，原样进入聚合管道 | `probe-rust.cjs`（B-18） | `Erust-probe-bcise.log:68`：`{"$limit":"abc"}` 被原样放入 `pipeline` | CWE-20 | 三端 | 对 `$limit/$skip` 做类型与范围校验，非法值显式报错 |
| D-08 | m | 7 | 联邦结果超 `MAX_FEDERATION_ROWS` 时错误文案错乱 | `probe-rust.cjs`（S-01） | `Erust-probe-bcise.log:75`：`第 0 个取数单元的结果必须是数组`（未提及行数上限） | CWE-703 | 三端；排障成本上升 | 超限时抛出含上限与实测行数的专用错误 |

**严重度统计**：B **0** / C **2** / M **2** / m **3** / I **0**

## 5. 测试覆盖矩阵（九维 × 现状）

| 维度 | 既有资产 | 本轮实跑 | 补充实跑 | 缺口结论 |
|------|----------|----------|----------|----------|
| 1 功能 | 81 项（`tests/` 8 文件 + `scripts/test.js`） | 有 | 有（core 51 例 + 宿主 23 例） | 关系带参+子选择集、原子性失败注入缺 |
| 2 边界 | 部分（crud 边界 + require-context） | 有 | 有（BVA 22 + 宿主 8 例） | 上限+1、类型组合、时间极值缺 |
| 3 组合 | 参数化 E2E（4 后端 × 7 命令） | 有 | 有（决策表 15 例） | 状态迁移/异常叠加/剪裁说明缺 |
| 4 交互 | `real-backends-e2e` / `federation-e2e` / `host-contract` | 有 | 有（并发 30/50、4 进程） | 事务边界、替身保真度缺 |
| 5 压力 | `scripts/stress.js` | 有（2 档） | 有 | 无门禁、无分段/浸泡、无 p99；基线对照受评测环境干扰 |
| 6 兼容 | 四后端 E2E + parity | 有 | 有（版本实采） | 版本/平台矩阵缺，M9=0 |
| 7 安全 | `guards` / `require-context` / `identifier safety` | 有 | 有（1 轮注入攻击） | `$where` 未拦截；超深/超大批量缺 |
| 8 回归门禁 | `ci.yml` + c8 门槛 + fixtures | 有 | 有 | CI 无 service 容器；发布前不跑测试 |
| 9 测试工程 | 六类测试文件 + helpers | 有 | 有（独立性/重复 5 次/并发） | 并发隔离失败；README 无测试章节 |

## 6. 受限清单（未执行的检查项）

| 检查项 | 未执行原因 | 建议补测方式 |
|--------|------------|--------------|
| 压力：尖峰 / 浸泡档 | 需用户同意长时占用机器 | 低负载 × ≥30 min 浸泡 + 尖峰跳变 |
| 压力：p99 指标 | `scripts/stress.js` 未输出 p99 | 脚本补 p99 分位 |
| 压力：性能门禁（S10） | 项目无此设施 | 在 CI 增加 `stress` job 并对 QPS/尾延迟设阈值断言 |
| 兼容：多运行时/多平台/后端版本矩阵（M4/M5/M6/M9） | 本机仅 1 组版本、1 平台；CI 无 service 容器 | CI 增加 OS × Node × DB 版本 matrix |
| 交互：事务边界与连接泄漏（I6） | 项目无事务 API（单命令模型） | 在 Host 层以失败注入模拟多步写 |
| 安全：超深 GQL / 超大批量载荷（X5） | 无对应用例 | 新增深度/批量越界载荷用例 |
| 回归：分支保护配置（G9） | 无 GitHub 仓库设置访问权限 | 由仓库管理员导出分支保护规则 |
| 回归：CI 真实后端一致性（G4） | CI 无 DB service | 增加 `services: mysql/postgres/mongo` 容器 |

## 7. 执行证据附录

> `E` = `f:\独立开发者\项目\mongo-store\tmp\test-eval\`

```
[维度 1/4/6/8] $ npm test  （nodejs-store）
  结果：tests 81 / pass 81 / fail 0 / duration 1445.5 ms（exit 0）
  日志：Ejs-npm-test.log

[维度 4] $ npm run test:e2e
  结果：tests 25 / suites 6 / pass 25 / fail 0 / 1500.11 ms
  日志：Ejs-e2e.log

[维度 5] $ npm run test:coverage  （c8 门槛检查随行）
  结果：92.69 Stmts / 77.3 Branch / 87.8 Funcs / 92.69 Lines；check-coverage 通过
  日志：Ejs-coverage.log

[维度 8/9] $ npm run lint
  结果：LINT_EXIT=0
  日志：Ejs-lint.log

[维度 9] $ npm test ×5（重复性）
  结果：run 1..5 exit=0 :: pass 81 | fail 0（1398 / 1412 / 1535 / 1435 / 1405 ms）
  日志：Ejs-repeat5.log

[维度 9] 单文件独立执行
  结果：guards.test.js exit=0 pass 7；host-contract.test.js exit=0 pass 4；
        multi-datasource.test.js exit=0 pass 9；tests/crud.test.js NOT FOUND（清单错误）
  日志：Ejs-independence.log

[维度 2/4/7] $ node tmp/test-eval/probes/probe-js.cjs  （宿主层探针，真实 Mongo + 内存 SQLite）
  结果：total=23 pass=20 fail=3（X-03-sqlite / X-03-mongo / B-07）
  日志：Ejs-probe-bcise.log

[维度 2/3/4/7] $ node tmp/test-eval/probes/probe-rust.cjs  （core-node 直驱，51 例）
  结果：total=51 pass=40 fail=11
  日志：Erust-probe-bcise.log

[维度 7] 依赖漏洞扫描
  结果：found 0 vulnerabilities
  日志：Ejs-npm-audit.log

[维度 5] $ node scripts/stress.js （8 workers × 200 rounds，LOCAL_CORE=1）
  结果：{"qps":560.62,"errors":0,"all_ops":{"p50_ms":13,"p95_ms":33,"max_ms":183}}
  日志：Ejs-stress-8x200-rerun.log

[维度 5] 冒烟档 1×10
  结果：{"qps":316.46,"errors":0}
  日志：Estress-smoke-tier.log

[维度 4/9] 四进程并发（2×node + 2×py）
  结果：M1 唯一性 PASS / M2 无丢失 PASS / M3 分布 PASS → 3/3
  日志：Emultiprocess-verify.log

[维度 4/9] 两进程并发跑真实后端 E2E
  结果：进程 A：MySQL/PG/Mongo E2E 全 ✖ + syncSchema ✖；进程 B：23 passed
  日志：Epar-node-a.out / Epar-node-b.out

[维度 6] 环境与后端版本实采
  结果：python=3.14.4 / mysql=8.0.42 / postgres=16.4 / mongo=8.0.12 / sqlite=3.50.4 / node=v25.1.0
  日志：Eenv-versions.log

[维度 8] 仓库元信息与 CI/发布流水线
  结果：workflows = ci.yml / release-npm.yml；git log 6 条；tags v1.0.0 / v0.1.0
  日志：Erepo-git-and-workflows.log

[维度 1/2/4/7] 缺陷最小复现复核
  结果：D-01（V3/V4/V6/V7/V10 全 ERR）、D-02（SQL 条件静默消失）、D-03（绑定序列化崩溃）
  日志：Edefect-d01-recheck.log / Edefect-d01-d02.log / Edefect-d02-unsupported.log / Edefect-d02-v1-mongo.log / Edefect-d03-rust-binding.log / Eprobe-iso11.log
```

## 8. 范围外发现（不计分）

| 现象 | 位置 | 初判严重度 | 建议 |
|------|------|------------|------|
| 探针期望与实现契约不一致（经代码复核为**设计内行为**）：`roles:['admin ']`/`['ADMIN']`/`['']` 在 schema **未配置 write 白名单**时放行 | `rust-store/core/src/permission.rs:71-89`（无白名单 → 非 guest 放行） | I（非缺陷） | 若宿主可能传入非受控 roles，建议增加角色字符串白名单校验并文档化默认放行契约 |
| 未声明字段在投影中被静默丢弃（探针期望报错） | `Eprobe-*`（core 探针 B-05） | I（待确认） | 明确「未声明字段忽略」是否为公开契约，若是则补文档 |
| `register` 缺 `collection` 时回落为 `name`（探针期望拒绝） | `rust-store/core/src/schema.rs:119-124` | I（非缺陷） | 文档化默认值语义 |
| 关系深度 11 用例报「关系 L11 未在 schema L10 中定义」（用例仅构造到 L10） | core 探针 B-07 | I（用例构造问题） | 修正探针 schema 层级后复测 |
| `creator` 伪角色在 plan 期通过、由 owner 条件注入落实隔离（探针误判为越权） | `permission.rs:118-136, 249-263` | I（非缺陷） | 建议在 README 明确「plan 期放行 + 条件注入」两段式语义 |
| `require_context=true` 且无 ctx 时抛 `ERR_NO_CONTEXT`（探针误判为「意外报错」） | core 探针 C-rc-1/2 | I（非缺陷，实为 fail-secure 生效） | 修正探针断言后复测 |
| `tests/` 中 `tests/test-nodejs-store.js` 与其它 `.test.js` 命名不统一 | `nodejs-store/tests/` | I | 统一命名便于独立执行清单化 |
| 评测时段机器被外部任务占满（CPU 100%、磁盘近满，用户确认）：三仓吞吐全部显著低于各自历史基线（node −12.1%、py −62.7%、rust −61.6%），差异属环境干扰而非产品退化，本轮据此撤销性能退化类缺陷（原 D-09） | 全部压测日志（`E*-stress-*.log` / `Estress-8x200-idle-rerun.log`） | I（环境） | 空闲时段复测三仓吞吐后再与基线对比 |

## 9. 改进建议（按优先级）

| 优先级 | 建议 | 对应缺陷 | 预期收益 | 落地方式 |
|--------|------|----------|----------|----------|
| P0 | `$where`/`$function` 等不支持条件键改为**显式报错**，绝不静默丢弃 | D-02 | 消除「结果静默错误」，恢复注入防御可信度 | core `pipeline/plan` 校验 + 负向回归用例 |
| P0 | 修正 GQL 语法：关系名后「参数 + 选择集」可同时出现 | D-01 | 恢复 README 记载能力 | core parser + 正向/反向用例 |
| P1 | `_id` 缺失且无 `idPrefix` 时显式报错或统一兜底 | D-03 | 消除跨绑定崩溃 | core + 双绑定契约用例 |
| P1 | 真实后端 E2E 表名按进程隔离，去掉破坏性 DDL | D-05 | 测试可并行、CI 可信 | `tests/real-backends-e2e.test.js` + CI 并行 job |
| P1 | CI 增加数据库 service 容器 | G4/M9 | 消除「CI 恒 skip」盲区 | `ci.yml` 增 `services:` |
| P2 | 增加性能门禁（QPS/尾延迟阈值断言） | S10 | 回归可自动拦截 | `ci.yml` 增 `stress` job |
| P2 | `$limit/$skip` 类型与范围校验 | D-07 | 边界输入可控 | core 校验 + 用例 |
| P2 | 覆盖率门槛扩展到分支 ≥ 80%；README 补测试章节 | T9/G5 | 文档与门槛补齐 | README + `c8` 参数 |

## 10. 复现指南

```powershell
# 环境前置：Windows；Node v25.1.0；MySQL 8.0.42 / PostgreSQL 16.4 / MongoDB 8.0.12 / SQLite 3.50.4
# 开发期本地兜底：指向相邻 rust-store 的 core-node 产物
$env:LOCAL_CORE='1'

# 1. 单元 / 契约测试
cd f:\独立开发者\项目\mongo-store\nodejs-store
npm test

# 2. 覆盖率（含门禁阈值）
npm run test:coverage

# 3. lint
npm run lint

# 4. 真实后端 E2E（需本地四库可达；凭据 e2e/e2e123，库 mongo_store_e2e）
npm run test:e2e

# 5. 压测（scripts/stress.js 不会自动注入 LOCAL_CORE，需手工设置，见 §8 观察项）
$env:LOCAL_CORE='1'
node scripts/stress.js        # 8 workers × 200 rounds

# 6. 补充探针
node f:\独立开发者\项目\mongo-store\tmp\test-eval\probes\probe-js.cjs
node f:\独立开发者\项目\mongo-store\tmp\test-eval\probes\probe-rust.cjs
```

## 附录 A：标准对照

| 标准 | 本报告的使用位置 |
|------|------------------|
| ISO/IEC/IEEE 29119-1..4 | 九维框架、BVA/等价类/决策表设计（§3.2/3.3） |
| ISO/IEC 25010 / 25023 | 维度 1/5/6/7 的质量特性与度量 |
| ISTQB CTFL 4.0 | 维度 2/3 的边界值、等价类、状态迁移 |
| OWASP Top 10 2021 / ASVS / WSTG | 维度 7 攻击面（A03 注入） |
| MITRE CWE Top 25 | §4 各缺陷 CWE 归类 |
| F.I.R.S.T / Clean Tests | 维度 9 判据 |
| SonarQube Quality Gate / DORA | 维度 8 门禁与性能回归判据 |

## 附录 B：项目规则优先声明

- 本仓自带覆盖率门槛（`statements/lines 90、functions 85、branches 75`）低于 SKILL §2 通用阈值（分支 75 与通用一致），**以项目门槛为准**，实测达标记 d=1。
- 本仓 fail-open 为**显式文档化契约**（`permission.rs` 模块文档），故 X4 按「默认行为被实测确认且开关两态有用例」记 d=1，不按漏洞处理。
- 本仓为薄 Host，DB 执行由 executor 承担，`I4 真实依赖集成` 判定以宿主真实库 E2E 为准。
