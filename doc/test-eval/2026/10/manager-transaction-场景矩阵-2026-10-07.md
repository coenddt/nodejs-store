# manager-transaction 场景矩阵 · 多后端对拍报告（2026-10-07，nodejs-store）

## 一、环境与后端可达性

- `mongodb`：**skip** —— MongoDB 不可达（mongodb://127.0.0.1:27017/mongo_store_e2e_mgrtx）: connect ECONNREFUSED 127.0.0.1:27017
- `postgres`：**skip** —— PostgreSQL 不可达（postgres://e2e:e2e123@127.0.0.1:5432/mongo_store_e2e_mgrtx）: connect ECONNREFUSED 127.0.0.1:5432
- `mysql`：**skip** —— MySQL 不可达（mysql://e2e:e2e123@127.0.0.1:3306/mongo_store_e2e_mgrtx?charset=utf8mb4）: connect ECONNREFUSED 127.0.0.1:3306
- `sqlite`：可达，通过 22/22

> 本报告只出证据，不修实现。判定规则：SQL 结果集与 Mongo(oracle) 逐行相等或显式 Err/unsupported+告警；静默不一致判缺陷。

## 二、逐用例结果（阶段0：T1/T2/T3 组，红用例为增补路线验收标尺）

| 用例 | 组 | mongodb | postgres | mysql | sqlite |
|---|---|---|---|---|---|
| T1-01 | T1 | — | — | — | pass |
| T1-02 | T1 | — | — | — | pass |
| T1-03 | T1 | — | — | — | pass |
| T1-04 | T1 | — | — | — | pass |
| T1-05 | T1 | — | — | — | pass |
| T2-01 | T2 | — | — | — | pass |
| T3-01 | T3 | — | — | — | pass |
| T3-02 | T3 | — | — | — | pass |
| T4-01 | T4 | — | — | — | pass |
| T4-02 | T4 | — | — | — | pass |
| T4-03 | T4 | — | — | — | pass |
| T4-04 | T4 | — | — | — | pass |
| T4-05 | T4 | — | — | — | pass |
| T5-01 | T5 | — | — | — | pass |
| T5-02 | T5 | — | — | — | pass |
| T5-03 | T5 | — | — | — | pass |
| T5-04 | T5 | — | — | — | pass |
| T5-05 | T5 | — | — | — | pass |
| T5-06 | T5 | — | — | — | pass |
| T5-07 | T5 | — | — | — | pass |
| T5-08 | T5 | — | — | — | pass |
| T5-09 | T5 | — | — | — | pass |

## 三、失败明细（证据原样摘录）
