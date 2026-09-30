# manager-transaction 场景矩阵 · 多后端对拍报告（2026-09-30，nodejs-store）

## 一、环境与后端可达性

- `mongodb`：可达，通过 8/8
- `postgres`：可达，通过 8/8
- `mysql`：可达，通过 8/8
- `sqlite`：可达，通过 8/8

> 本报告只出证据，不修实现。判定规则：SQL 结果集与 Mongo(oracle) 逐行相等或显式 Err/unsupported+告警；静默不一致判缺陷。

## 二、逐用例结果（阶段0：T1/T2/T3 组，红用例为增补路线验收标尺）

| 用例 | 组 | mongodb | postgres | mysql | sqlite |
|---|---|---|---|---|---|
| T1-01 | T1 | pass | pass | pass | pass |
| T1-02 | T1 | pass | pass | pass | pass |
| T1-03 | T1 | pass | pass | pass | pass |
| T1-04 | T1 | pass | pass | pass | pass |
| T1-05 | T1 | pass | pass | pass | pass |
| T2-02 | T2 | pass | — | — | — |
| T3-01 | T3 | pass | pass | pass | pass |
| T3-02 | T3 | pass | pass | pass | pass |
| T2-01 | T2 | — | pass | pass | pass |

## 三、失败明细（证据原样摘录）
