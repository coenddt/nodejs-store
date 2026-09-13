# course-platform 场景矩阵 · 多后端对拍报告（2026-09-14）

## 一、环境与后端可达性

| 后端 | 可达 | 断言通过 | 用例总数 | skip 原因 |
|---|---|---|---|---|
| `mongodb` | 可达 | 90/90 | 90 | - |
| `postgres` | 可达 | 90/90 | 90 | - |
| `mysql` | 可达 | 90/90 | 90 | - |
| `sqlite` | 可达 | 90/90 | 90 | - |

> 本报告只出证据，不修实现。判定规则：SQL 结果集与 Mongo(oracle) 逐行相等，或显式 Err / `unsupported` + feedback 告警；静默不一致判缺陷。

## 二、覆盖度表（A~J 组）

| 组 | 用例数 | 后端 | 通过 | 失败 | skip(不可达) |
|---|----|----|----|----|----|
| A | 13 | mongodb,postgres,mysql,sqlite | 52 | 0 | - |
| B | 13 | mongodb,postgres,mysql,sqlite | 52 | 0 | - |
| C | 10 | mongodb,postgres,mysql,sqlite | 40 | 0 | - |
| D | 7 | mongodb,postgres,mysql,sqlite | 28 | 0 | - |
| E | 15 | mongodb,postgres,mysql,sqlite | 60 | 0 | - |
| F | 8 | mongodb,postgres,mysql,sqlite | 32 | 0 | - |
| G | 3 | mongodb,postgres,mysql,sqlite | 12 | 0 | - |
| H | 10 | mongodb,postgres,mysql,sqlite | 40 | 0 | - |
| J | 11 | mongodb,postgres,mysql,sqlite | 44 | 0 | - |

分组含义：A=A 字段形态；B=B 写路径；C=C 关系/自关联/嵌套/分页；D=D 计算列；E=E 权限矩阵；F=F 边界（时间/数值/布尔/三态）；G=G 不可翻译必须显式；H=H 多后端一致性；J=J 根级 $group/$having/关系聚合谓词。

未覆盖组：**I(联邦/跨源)** —— 原因与既有覆盖见第四节「未覆盖项 / 已知覆盖缺口」。

## 三、缺陷清单（按 静默失真 > 越权 > 其它 排序）

无失败用例。

## 四、未覆盖项 / 已知覆盖缺口

1. **I 组（联邦 / 跨源）** —— 本场景是单源 harness（每后端单个 `default` 源，同进程内换连接串行复跑），不铺设双可写源。跨源联邦已由既有 `tests/federation-e2e.test.js`（Mongo 根 → MySQL 子 + 跨源 `asyncFn`，对应 I-01/I-03/I-04）与 `tests/multi-datasource.test.js`（多源定位 / namespace / routeOverride）覆盖，本场景不重复；I 组其余条目（联邦降级告警、`MAX_FEDERATION_ROWS` 上限保护、联邦权限一致、源失败不静默）**本轮未覆盖**。
2. **`op:"raw"` 断言中 `fn` 写在 step 级（非 `expect.fn`）的 6 步为 no-op** —— `E-13` / `E-14` / `E-16`（`check_require_context` / `check_privileged_roles` / `check_write_owner`）与 `F-06 step1` / `H-04 step1` / `H-05 step1`（`check_bool_rows` / `check_numeric_rows`）：两宿主 harness 的 `assert_step` 只读 `expect.kind`，用例 JSON 未把 `fn` 放进 `expect`，故这 6 步返回 `no assertion`（py 侧 `.out/*.json` 同为 `"expectKind": null, "note": "no assertion"`）。本场景**严格沿 py 语义**未改动用例资产，故 `setRequireContext` 开关、特权角色放行、写路径 owner 校验、布尔/数值回读类型 4 类断言在 raw 层**未被实际执行**，仅有 A-18 / D-06 / F-05 三步的 raw 断言（`expect.kind=raw`）真正生效。
3. **`D-06`** 在 Py 与 Node 两宿主均只覆盖「依赖不可读字段时 secret 不外泄」，未覆盖「计算列因依赖不可读而显式 Err」分支（该分支要求 Host/core 主动拒算）。

## 五、复跑命令与环境变量

```powershell
cd nodejs-store
$env:LOCAL_CORE='1'; $env:NODE_ENV='test'
# 本场景（四真实库串行对拍）
node --test tests/scenario-course-platform.test.js
# 全量回归（既有 + 新增）
npm test
```

- `LOCAL_CORE=1`：从相邻 `rust-store/core-node/dist/` 加载原生核心；**不要**设 `NODE_ENV=production`（会使本地兜底失效，回落 npm 依赖）。
- 后端可达性可用 `MYSQL_URI` / `PG_URI` / `MONGO_URI` 覆盖；缺省：MySQL `mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e?charset=utf8mb4`、PostgreSQL `postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e`、MongoDB `mongodb://127.0.0.1:27017/mongo_store_e2e`；SQLite 为 better-sqlite3 内存库。
- 每个用例前 `reset → seed`（seed 走 `store.insert` 真实写路径），ctx 三态齐备。

