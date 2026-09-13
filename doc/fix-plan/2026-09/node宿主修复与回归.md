# nodejs-store 修复文档 · 2026-09

> 依据：`rust-store/doc/fix-plan/2026-09/缺陷分层决策-共享核心修复主案.md`。
> **nodejs 与 py 同挂一个 Rust 核心（core-node），故共享核心的全部缺陷（R1~R6/R8~R10、S1/S3/S4）node 同样存在，核心修复后自动继承**。本仓不需要为这些核心逻辑重复实现任一修复。

## node 是否有同样问题 → 在哪修复

| 缺陷 | node 是否受影响 | nodejs-store 要做什么 |
|------|----------------|----------------------|
| R1/R2/R3/R4/R6/R8/R9/R10/S1/S3/S4 | ✅ 同核心继承 | 无需实现；核心修完即生效 |
| R5 分页根因（核心）| ✅ | 核心修根因；本仓 `src/crud/query.js` `queryWithCount` 塑形与 py 对齐去重 |
| R7 asyncFn 依赖 | ⚠️ 架构同、宿主独立 | 核心注入若补齐 → 本仓验证 `asyncFn` 尾处理取 depends；若宿主实现差异 → 本仓与 py 对齐同一语义 |

## 建议本仓动作
1. **补回归/冒烟**：核心 P0/P1 修复后，在 nodejs-store 补词面等价冒烟，覆盖 R1/R3/R6/R8/R9（当前无场景套件，避免「一处修、一端漏验证」）。
2. **R5 塑形去重**：`src/crud/query.js` 的 `queryWithCount` 结果塑形随核心分页修复收敛为薄封装（与 `py-store/src/py_store/crud/query.py` 同构）。
3. **R7 asyncFn**：确认本仓 asyncFn 尾处理与 py 语义一致（depends 注入/剥离、权限裁剪）。
4. **跨端契约**：建议复用 py-store `example/course-platform/cases/*.json` 作为双端行为契约回归条，避免用两套预期互相漂移。

## 明确不必做的事
- ❌ 不在 nodejs-store 复刻核心 permission/planning/dialect 修复（会重复造轮子，且易与核心分叉）。核心是唯一实现源。