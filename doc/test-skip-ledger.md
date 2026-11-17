# 测试跳过台账（skip ledger）

覆盖 `node --test` 实测全部 **36 个 skipped 用例**（nodejs-store 25、store-api 2、store-graphql 2、
store-rbac-bootstrap 3、store-resource-bootstrap 4；meta-store / store-grpc / store-mcp /
store-gateway 为 0）。目的：把「环境依赖跳过」与「长期挂起」分开，避免门禁把两者混为一谈。

## 分类判据

| 类别 | 前缀 | 判据 | 门禁处置 |
|---|---|---|---|
| 环境依赖 | `[环境依赖]` | 缺**外部运行环境**才不跑：真实数据库 / 原生 core / 相邻仓库 / 环境变量 / 可选 peer 包。补齐环境后应全绿，**不属缺测** | CI 尽量起服务（MySQL 8 / pgvector / Mongo 副本集）覆盖；CI 内仍缺的部分记录在案，不计入覆盖率缺口 |
| 长期挂起 | `[长期挂起]` | 已确认为**跨方向能力缺口**（需 Rust core 侧改动），在当前方向无法修复 | 单列挂账，不计入本期门禁；修复行号与责任方向写在用例的 skip 文案里 |

统计（任一包目录下执行）：

```bash
node --test 2>&1 | grep -E "﹣ |\(skipped" | grep -c "\[环境依赖\]"
node --test 2>&1 | grep -E "﹣ |\(skipped" | grep -c "\[长期挂起\]"
```

## 一、nodejs-store（25）

### [长期挂起] × 1

| 用例 | 挂起原因 |
|---|---|
| `tests/host-security.test.js` — `exists: 条件引用字段白名单外字段应拒绝` | `core plan_exists_with_ctx` 仅校验表级 read/RBAC（`rust-store/core/src/command/write.rs:186-205`），条件字段白名单未校验 —— 跨方向项，需 Rust core 补齐 |

### [环境依赖] × 24

**A. 后端矩阵限定 × 13**（`tests/scenario-manager-transaction.test.js` 经
`extraSkip(kind, c)` 按用例 `backends` 白名单过滤；后端已全程跑通，只是该用例语义仅适用于
列出的后端）
T2-01、T4-01、T4-02、T4-03、T4-04 ×3、T4-05 ×3、T2-02 ×3（后两项在后端不匹配时各跳过 3 次）。

**B. Mongo 向量能力 × 11**（`tests/vector-conformance.test.js`）
C1–C11 全组：本机 mongod 不支持 `$vectorSearch`（需 Atlas 或 AtlasCLI 本地部署）。
CI 用 `mongo:7 --replSet` 可跑事务，但**不提供** `$vectorSearch`，故这 11 条在 CI 同样跳过 ——
属**平台能力**而非缺测；判定逻辑见该文件 `probeVectorSearch()`。

## 二、store-api-node（2）

| 用例 | 类别 | 缺什么 |
|---|---|---|
| `policyProvider 装配守卫 + requireContext 覆盖` | `[环境依赖]` | `nodejs-store`（optional peer）不可解析，policyProvider 全流程需宿主包 |
| `policyProvider：profile 覆盖经视图生效` | `[环境依赖]` | 同上 |

## 三、store-graphql-node（2）

| 用例 | 类别 | 缺什么 |
|---|---|---|
| `policyProvider 装配守卫 + requireContext 覆盖` | `[环境依赖]` | `nodejs-store` optional peer 不可解析 |
| `policyProvider：profile 覆盖经视图生效（ctx 复用自 contextFactory）` | `[环境依赖]` | 同上 |

## 四、store-rbac-bootstrap-node（3）

| 用例 | 类别 | 缺什么 |
|---|---|---|
| `参考 schema bootstrap 后对普通角色可读（真实 core）` | `[环境依赖]` | `STORE_NATIVE=1` + 真实 rust core 原生执行 |
| `write: [] 拒写 + closed 姿态下 read: null 整表不可见（真实 core）` | `[环境依赖]` | 同上 |
| `start() 中途注册失败 ⇒ 已注册表残留（真实门面，非原子）` | `[环境依赖]` | 同上 |

## 五、store-resource-bootstrap-node（4）

| 用例 | 类别 | 缺什么 |
|---|---|---|
| `参考三表 bootstrap 后对普通角色可读（真实 core）` | `[环境依赖]` | `STORE_NATIVE=1` + 真实 rust core 原生执行 |
| `write: [] 拒写 + closed 姿态下 read: null 整表不可见（真实 core）` | `[环境依赖]` | 同上 |
| `start() 中途 schema 注册失败 ⇒ 已注册表残留（真实门面，非原子）` | `[环境依赖]` | 同上 |
| `configureResource 失败 ⇒ schema 零注册（真实 core，零副作用）` | `[环境依赖]` | 同上 |

## 结论

- 36 个 skipped 中 **35 个为 `[环境依赖]`**（补环境即可执行），**1 个为 `[长期挂起]`**（跨方向项，已定位到 Rust core 行号）。
- 所有 skip 文案均带类别前缀，门禁可用上表命令机械统计；`skip` 理由字符串属测试元信息，与被测代码行为无关。
