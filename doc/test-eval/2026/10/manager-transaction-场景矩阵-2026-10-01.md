# manager-transaction 场景矩阵 · 多后端对拍报告（2026-10-01，nodejs-store）

## 一、环境与后端可达性

- `mongodb`：未执行
- `postgres`：未执行
- `mysql`：未执行
- `sqlite`：未执行

> 本报告只出证据，不修实现。判定规则：SQL 结果集与 Mongo(oracle) 逐行相等或显式 Err/unsupported+告警；静默不一致判缺陷。

## 二、逐用例结果（阶段0：T1/T2/T3 组，红用例为增补路线验收标尺）

| 用例 | 组 | mongodb | postgres | mysql | sqlite |
|---|---|---|---|---|---|

## 三、失败明细（证据原样摘录）
