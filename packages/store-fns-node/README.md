# store-fns-node

L2 计算列实现包（Node）——语言级共享层。宿主通过 `core::naming` 归一算法把
schema 声明的逻辑 `fnRef` 与本包导出的实现名匹配后绑定。

- 导出形状：扁平字典 `{ implName: impl(item, ctx) }`（唯一导出）。
- 命名约定：`implName` 用 camelCase；与逻辑 `fnRef`（默认 `<schema.name>.<计算列key>`）
  由宿主归一后匹配，故实现名与声明名书写可不同（`Order.total` ↔ `orderTotal`）。
- 零运行时依赖：本包不 import core 或宿主，唯一耦合是「导出名遵循 Node 语言风格」。
- 独立版本：本包版本独立于 nodejs-store 宿主版本。

规范正文（`llms-full.txt` / `ask_knowledge.md` 等）由 08 号分步回填。
