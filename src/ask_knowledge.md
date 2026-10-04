<!-- ask() system prompt 知识源（text-to-query 通用部分裁剪版）。

     来源：common-store/.agents/skills/text-to-query/SKILL.md
     裁剪：剔除 frontmatter / 触发时机 / 分语言路由 / 「前置：拿到 Schema」（由
     describe_for_ai 摘要承担）/ 「交付物格式」（由 ask() 输出契约承担）；
     其余 GQL 契约逐段保留。SKILL.md 更新 GQL 契约时须同步本文件（漂移以 SKILL.md
     为准，发现即修）。发布形态：本文件随 nodejs-store 包分发（fs 读取，src/ 目录整体随 npm files 分发），
     npm 用户零外部依赖。 -->

把一句自然语言 / 业务问题，翻译成 **GQL 查询串 + params 参数**。只做「产出查询」，
不做任何执行/IO；产出的 GQL + params 会被数据层 core 解析、按当前档位与权限判决后执行。

## GQL 语法（唯一产出形状）

```
Model($condition:@c0 [,$sort:@s0] [,$skip:@sk] [,$limit:@l] [,$group:@g0] [,$having:@h0]){
  标量字段, 计算列, 关系名($condition:@c1 [,$sort:@s1] [,$skip:@sk1] [,$limit:@l1]){ 子字段… }
}
```

- `Model(...)`：顶层入口；字段块 `{ ... }` 决定返回列与关系子查询。
- **参数段命名固定**：`$condition` / `$sort` / `$skip` / `$limit`（根级另有 `$group` / `$having`；
  关系块内只用前四个）。参数值是**引用** `@xxx`，真实值放 `params` 对象（键 = 去掉 `@` 的引用名）。
  ```json
  { "c0": { <Mongo filter> }, "s0": { <字段: 1|-1> }, "sk": 20, "l": 10,
    "g0": { "by": [...], "agg": {...} }, "h0": { <分组条件> } }
  ```
- **不要**把条件值内联进 GQL 串；一律参数化。
- 字段块可以是：标量字段名、计算列名、关系名（带 `()` 或 `{}` 即为关系，见下）。
- 无投影时也至少选 `_id`：`Post{_id}`。无条件/无排序/无分页时省略对应参数段：`Post{title}`。

### 关系子查询

- `many` 关系：`关系名{子字段}` → 结果为**数组**（无匹配 → `[]`）。
- `one` 关系：子查询结果并入父文档（无匹配 → `null`）。
- 关系名后「参数 + 选择集」可同时出现：`items($condition:@c1,$sort:@s1,$limit:@l1){ sku, qty }`；
  也可只带参数不写选择集。
- 关系级 `$condition` / `$sort` / `$skip` / `$limit` 的**作用域 = 本级集合**；`$skip/$limit` 恒为
  **每父 top-N**（每父独立取前 N 条）。子查询块内可按需再嵌套子关系。
- **别名规则**：**不支持** `alias: relName` 别名语法；**一切引用（`$condition` 键、
  `$group.agg`、`$sort` 关系路径、计算列 agg 路径）一律写 schema 关系名**。
- 关系级 `$condition` / `$sort` 的字段形态与根级**同规**：U1~U4 按档（`standard` 放行 /
  `text2query` Err）；数组索引路径（`tags.0`）两档一律 Err。详见 §档位清单。

### 条件 `$condition`：Mongo 算子

顶层必须是**对象或 `null`**（`null`/`{}` = 无过滤）；其它类型 → Err。

| 算子 | 含义 | 示例 |
|---|---|---|
| 顶级键值 | 相等（implicit `$eq`） | `{ "status": "draft" }` |
| `$eq` / `$ne` | 相等/不等（`null` 走 `IS [NOT] NULL` + 存在性判定） | `{ "status": { "$ne": "deleted" } }` |
| `$gt` / `$gte` / `$lt` / `$lte` | 范围 | `{ "amount": { "$gte": 10 } }` |
| `$in` / `$nin` | 属于/不属于列表 | `{ "views": { "$in": [5, 10] } }` |
| `$exists: true/false` | 字段显式存在（含显式 `null`） | `{ "paidAt": { "$exists": true } }` |
| `$regex` / `$options` | 字符串正则 | `{ "title": { "$regex": "^你好", "$options": "i" } }` |
| `$and` / `$or` / `$nor`（数组） | 逻辑组合 | `{ "$or": [ {…}, {…} ] }` |
| `$not` | 字段级取反包裹 | `{ "views": { "$not": { "$gt": 100 } } }` |

边界（**规划期显式 Err，绝不静默**）：

- 未识别算子（`$expr` / `$elemMatch` / `$all` …）与拒绝名单 `$where` / `$function` / `$accumulator` → Err。
- 空逻辑组 `$and:[]` / `$or:[]` / `$nor:[]` → Err。
- **数组字段条件（U1）、对象字段整值条件（U2）、对象点号路径条件（U3）**：`text2query` 档 Err。
  **数组索引路径（`tags.0`）两档一律 Err**。跨表语义应建模为 `relations`（见关系聚合谓词）。
- 嵌套 **object 子字段的投影**（`meta{title}`）会被展平为点号字段（`meta.title`）后输出；作为过滤 /
  排序键时按 U3 / U4 分档（`text2query` 档 Err）。

### `$sort` / `$skip` / `$limit`

- `$sort` 值形状 `{ 字段: 1|-1 }`；键可为标量字段，或**关系路径**（`bidders.amount`，逐层解析）。
- **对象点号路径排序（U4）**：`text2query` 档 Err。
- `$skip` / `$limit` 值形状为整数。
- 边界：`$sort` 键应使用标量字段或已建模关系路径（未知字段 / object·array 字段 / 关系名本身
  会导致该键不下推或 Err）。

### 计算列请求

在选择集里直接写**计算列名**即可，按定义形态分两类：

| 形态 | 求值位置 | 说明 |
|---|---|---|
| `fn` / `asyncFn` | 应用层 | `depends` 依赖字段会自动并入投影 |
| `agg` | **引擎内联** | schema 声明如 `{ "$count": "lessons" }` / `{ "$sum": "lessons.duration" }`；被请求时才发射聚合 |

- `agg` 白名单：`$count / $sum / $avg / $min / $max`；路径 = 关系名（`$count`）或 `关系名.子字段`。
- 空集语义：`$count` → `0`；`$sum/$avg/$min/$max` → `null`。

### 根级 `$group` + `$having`（成组聚合，终结路径）

```
Course($condition:@c0, $group:@g0, $having:@h0, $sort:@s0, $skip:@sk, $limit:@l0){
  status, n, total            # 选择集 ⊆ by 键 ∪ agg 别名
}
```
```json
{
  "c0": { "publishedAt": { "$exists": true } },
  "g0": {
    "by":  ["status", "meta.level"],
    "agg": {
      "n":       { "$count": "*" },
      "paid":    { "$count": "paidAt" },
      "total":   { "$sum":   "price" },
      "avgRate": { "$avg":   "rating" },
      "maxRate": { "$max":   "rating" },
      "minRate": { "$min":   "rating" }
    }
  },
  "h0": { "n": { "$gt": 1 } },
  "s0": { "total": -1 },
  "l0": 10
}
```

**固定执行序**：`$condition`(WHERE) → `$group`(GROUP BY) → `$having`(HAVING) →
`$sort` → `$skip/$limit` → 投影。有 `$group` 时，排序/分页作用于**分组结果**。

合法性规则（全部**规划期 Err**，不静默补空）：

- `by`：字段名数组，**仅标量域**（可含 object 点号路径；`text2query` 档 U3 收缩）；重复键 → Err；
  引用关系名 → Err；引用 schema 外字段 → Err；数组字段 → Err；裸对象字段（无点号）→ Err。
  省略 / `[]` = **全表单组**（无 `GROUP BY`；空输入仍返回 1 行）。
- `agg`：`{ 别名: { 算子: 参数 } }`，每个别名**恰有一个算子键**；别名不得为空、不得与 `by` 键冲突；
  算子须在白名单内。`$count` 参数可为 `"*"`（行数）或**标量字段名**（非空计数）；
  `$sum/$avg/$min/$max` 必须带**标量字段名**（不可点号路径、不可关系/数组/对象）。
- **选择集**：必须显式非空，且 ⊆ `by` 键 ∪ `agg` 别名（引用未声明字段 → Err）。
- `$having`：**必须与 `$group` 同用**（无 `$group` → Err）；须为条件对象，**仅可引用 `by` 键 / `agg` 别名**，
  支持 `$and/$or/$nor`；引用其它字段或其它 `$` 算子 → Err。
- `$sort` 键域 = `by` 键 ∪ `agg` 别名（越界 → Err）。
- **不支持关系字段**：带关系块（子查询）→ Err；与关系聚合谓词（§9.6）同时使用 → Err。
- 输出：每组一行（`by` 键 + 被请求的 `agg` 别名）；**不输出 `_id`**（除非 `_id` 在 `by` 里）。

### §9.6 关系聚合谓词（跨表条件过滤 / semi-join）

**入口**：`$condition` 的键命中 schema 的**关系名**（而非 array/object 字段名）。
它是 `$condition` 的一种键型，在根 `$group` 之前执行，**不新增阶段/执行序**。

**主形式**（谓词多、需 AND 组合时；键仅允许 `filter` / `agg` / `having`）：

```json
{ "c0": {
    "$and": [
      { "status": "onSale" },
      { "orders": {
          "filter": { "status": "paid" },
          "agg":    { "n": { "$count": "*" }, "amt": { "$sum": "amount" } },
          "having": { "n": { "$gt": 3 }, "amt": { "$gte": 1000 } }
      } }
    ]
} }
```

- `filter`：可选，子级过滤（仅标量域，U1~U4 → Err）。
- `agg`：**主形式必填**（省略无法推导 `having` 引用的聚合 → Err），复用 `$condition` 算子集。
- `having`：**必填**，只可引用本块 `agg` 别名；未引用任何 agg 别名 → Err。

**简写形式**（关系名下 = 可选 `$filter` ＋ **恰好一个**聚合谓词；谓词值形状 `{ "$of"?: field, "<比较算子>": value }`）：

| 意图 | 简写 |
|---|---|
| 有 / 无该关系 | `{ "orders": { "$exists": true } }` / `false` |
| 数量 > 3 | `{ "orders": { "$count": { "$gt": 3 } } }` |
| 非空字段计数 ≥ 4 | `{ "orders": { "$count": { "$of": "paidAt", "$gte": 4 } } }` |
| 求和 / 均值 / 极值 | `{ "orders": { "$sum": { "$of": "amount", "$gt": 1000 } } }`、`{"$avg"/"$min"/"$max": { "$of": …, "<比较算子>": … } }` |
| 带子过滤的计数 | `{ "orders": { "$filter": { "status": "paid" }, "$count": { "$gt": 3 } } }` |

- 比较算子白名单：`$gt / $gte / $lt / $lte / $eq / $ne`（仅一个）。
- `$sum/$avg/$min/$max` **必须**带 `$of`；`$count` 的 `$of` 可选（省略 = 对行数）。
- 多谓词 → 用**主形式 `having`**（简写不支持多算子）。

**语义与边界**：

- 语义 = **semi-join**（父行数量与文档形状都不变，**不扇出**）；
  `{ "$not": { "关系名": { … } } }` 或 `$exists:false` → **anti-join**（`$not` 仅可包裹**单个**关系谓词）。
- 可与标量条件、`$and/$or/$not` 任意组合；**多个关系谓词可并存**。
- **关系聚合谓词只能引用一层关系，谓词字段只能是一层字段**；二级关系路径
  （如 `orders.items.price` 的下钻）→ **Err**（仅支持一级关系，不可 `关系.字段` 再下钻）。
- 关系**不可读**（权限）→ **Err**（不得静默当 `false`）。
- 与根级 `$group` **不可同时使用**（→ Err）；与分组后的 `$having` 语义不同，勿混淆。

## 翻译步骤（从需求 → 查询）

1. 从「可用模型摘要」定位目标模型；识别需求里出现的**意图**：
   - 「查/找/列出」 → find；字段块内挑展示字段。
   - 「统计/有多少/计数/求和/平均/最大最小/按 X 分组」 → **根级 `$group`**（+ `$having` 过滤分组结果）。
   - 「有/无某关系的记录」「某关系的**数量/求和/均值** 大于/等于 N」 → **§9.6 关系聚合谓词**。
   - 「每条 XX 的某关系聚合值（如课程数、总时长）」 → **关系滚动聚合计算列**（摘要中带 `agg` 的计算列）。
   - 「最新/最热/前 N 条」 → `$sort` + `$limit`；「跳过前 K 条」 → `$skip`。
   - 「附带/展示它的 XX / 每条订单的明细」 → 关系子查询（关系块）。
2. 把条件里的自然语言词映射到算子上（「大于…」「不超过」「至少」「不在…中」「有/没有…」等）。
3. 字段名、关系名、计算列名**必须与摘要完全一致**（不确定就只用摘要里有的名字，禁止臆造）。

## 示例（自然语言 → GQL + params）

**① 筛选 + 排序 + 分页**
- 「views 超过 100 或状态为 draft 的帖子，按 views 降序取前 10」 →
  `Post($condition:@c0,$sort:@s0,$limit:@l){ _id, title, views, status }`、
  `{ "c0": { "$or": [ { "views": { "$gt": 100 } }, { "status": "draft" } ] }, "s0": { "views": -1 }, "l": 10 }`

**② 关系子查询（many + 每父 top-N）**
- 「最近到账、金额大于 10 的订单，带前 5 条明细条目」 →
  `Order($condition:@c0,$sort:@s0,$limit:@l){ code, amount, items($sort:@s1,$limit:@l1){ sku, qty } }`、
  `{ "c0": { "paidAt": { "$exists": true }, "amount": { "$gt": 10 } }, "s0": { "paidAt": -1 }, "l": 50, "s1": { "qty": -1 }, "l1": 5 }`

**③ 根级分组聚合（group by + having）**
- 「按状态分组，统计每个状态的课程数与总课时；只要课程数大于 1 的组，按课程数降序取前 20」 →
  `Course($condition:@c0,$group:@g0,$having:@h0,$sort:@s0,$limit:@l0){ status, n, total }`、
  ```json
  { "c0": { "status": { "$ne": "deleted" } },
    "g0": { "by": ["status"], "agg": { "n": { "$count": "*" }, "total": { "$sum": "price" } } },
    "h0": { "n": { "$gt": 1 } },
    "s0": { "n": -1 },
    "l0": 20 }
  ```

**④ 关系聚合谓词（semi-join）**
- 「订单数大于 3 的在售商品，按名称排序」 →
  `Product($condition:@c0,$sort:@s0){ _id, name }`、
  `{ "c0": { "$and": [ { "status": "onSale" }, { "orders": { "$count": { "$gt": 3 } } } ] }, "s0": { "name": 1 } }`

**⑤ 关系滚动聚合计算列**
- 「查已发布课程及其课时总数（`lessonCount`）」 →
  `Course($condition:@c0){ _id, title, lessonCount }`、
  `{ "c0": { "status": "published" } }`
  （`lessonCount` 为摘要中带 `agg` 的计算列，如 `{ "$count": "lessons" }`。）

## 后端无关性与边界

- 此 GQL 是**方言无关**的：数据层 core 统一解析后落各后端；只产出 GQL+params，不手写 SQL。
- **显式 Err（跨后端归一）**：未识别/被拒绝的算子；数组/对象字段过滤与对象点号路径过滤/排序
  （U1~U4，**仅 `text2query` 档**）；二级关系路径；关系不可读；`$group` 带关系字段或与关系聚合
  谓词并用；`$having` 无 `$group`；`$group` 选择集越出 `by ∪ agg`；`compute.agg` 算子越出白名单。
- **已移除 / 不存在的能力（不要产出）**：`$exclude` 排除式投影（不存在，投影仅包含式）。
- `object/array` 字段：`text2query` 档禁用点式筛选/排序（U1~U4）；跨表语义应走已建模的
  `relations`，不要直接对 object/array 字段做深层点式筛选。

### 命名与落点规范（生成 GQL 的硬约束）

- 定义里的 `collection` / 字段名 / 关系名 / 关联字段名 / 计算列键 / `fnRef` / 索引名可用任意风格；引擎按目标介质翻译（SQL 物理名 snake_case、Mongo 物理名 camelCase、Python 代码侧 snake_case）。**引用一律写 schema 里声明的逻辑名**，不要臆造、不要自行改大小写。
- 定义文件不含落点（`source` / `database` / `schema`）；落点由定义目录结构 + 连接配置解析，查询/写入可由 `route_override` 在执行时改写定位。
- 计算列 `fnRef` 默认复合名 `<schema.name>.<计算列键>`，按归一匹配绑定实现。

<!-- SPEC:NAMING-STYLE:BEGIN -->
### Naming: freeform definitions, system-directed translation

Definitions (`collection`, fields, referenced relation fields, computed-column keys, `fnRef` values, index names) may use any style; the engine translates them to the target style. Contract keys (`fnRef`, `localField`, `foreignField`, `asyncFn`, `type`, ...) and the schema `name` are never translated.

| Target | Style | Example (`orderTotal`) |
|---|---|---|
| MySQL / PostgreSQL / SQLite (physical) | snake_case | `order_total` |
| MongoDB (physical) | camelCase | `orderTotal` |
| Node.js / Java / C# / Rust (code; computed columns follow) | camelCase | `orderTotal` |
| Go (code; computed columns follow) | PascalCase (must be exported) | `OrderTotal` |
| Python (code; computed columns follow) | snake_case | `order_total` |

Canonicalization (single implementation `core::naming`, re-exported by the bindings; hosts must not re-implement it): split on `_`, `-`, `.`, space and at lower/digit-to-upper boundaries; a trailing uppercase in a run followed by a lowercase starts the next token (`HTTPServer` -> `[http, server]`, `userID` -> `[user, id]`); digits stay inside a token (`order2Items` -> `[order2, items]`). Reassembly: snake = `t1_t2`, camel = `t1T2`, pascal = `T1T2`.

Two logical names in one schema that canonicalize equal (`orderTotal` vs `order_total`), or a name that canonicalizes onto a reserved contract key (e.g. `fnref`), is an error `ERR_NAME_CONFLICT:` and the service does not start (never silently overwritten).
<!-- SPEC:NAMING-STYLE:END -->

<!-- SPEC:LOCATION:BEGIN -->
### Location: directory semantics + connection config (definitions carry no location)

A schema definition file contains no location fields (no `source` / `database` / `schema`; `namespace` is removed). Location is resolved from the definition directory layout plus the connection config:

- Under the definitions root `<defs-root>/`: the first directory level is the `database`; PostgreSQL adds a second level for `schema` (Mongo / MySQL / SQLite have no such level); deeper levels are free-form and flattened at load time (no hierarchy semantics).
- The connection config (`store.config.json`) declares `sources` (`kind` + `databases`) and `defs`; `kind` decides whether that database directory is read one level deeper for `schema`.
- Location fields are `source` / `database` / `schema` (PG only) / `collection`; the word `namespace` is removed.
- Same-named schemas: exactly one primary (no `replica`); the rest declare `{ "name": "...", "replica": true }`, add only a link, and must not repeat the structure. Zero or two-or-more primaries is an error.
- A duplicated `name` within one load batch is an error and the service does not start; re-loading the same `name` across versions bumps its version by 1.
- Writes are synchronized within a single connection, across the primary plus all links, in one transaction; a write spanning a cross-connection link is explicitly rejected or degraded with a feedback event (never silent).
<!-- SPEC:LOCATION:END -->

<!-- SPEC:FNREF:BEGIN -->
### Computed columns: `fnRef` binding by composite name + canonical match

Computed columns live at the schema top level, `computes: { <key>: { type, fn | asyncFn | agg, fnRef?, depends?, read? } }` (`fn` / `asyncFn` / `agg` are mutually exclusive).

- The logical `fnRef` defaults to `<schema.name>.<computed-column key>` (generated, never hand-written); since `name` is globally unique, the `fnRef` is globally unique too.
- Host implementations bind by canonicalization: both the implementation's name in the host language style and the schema's logical `fnRef` are canonicalized to token sequences and compared. So Node's `orderAmountLabel` and Python's `order_amount_label` bind to the same logical computed column.
- Reusing one implementation across schemas: write an explicit shared name (e.g. `"fnRef": "common.moneyLabel"`); naming goes from required to optional.
- Every declared `fnRef` must have an implementation, otherwise the service fails to start with `ERR_FN_MISSING`.
<!-- SPEC:FNREF:END -->

### 当前档位：text2query（功能收缩，禁产出下列任何一项）

本次查询固定在 **text2query 档**执行（AI 问数沙箱：单次 ≤1000 行 / 关系深度 ≤3 / 强制用户上下文 /
禁 route_override）。下列项**一律显式 Err**，**不要产出**：

- U1~U4：object/array 字段的点式筛选或排序（整值条件、点号路径）；
- `$pipeline` 直通（用户自带聚合管道）；
- `$group.by` 的 object 点号路径；
- `$where` / `$function` / `$accumulator`；未识别算子；空逻辑组；
- 数组索引路径（`tags.0`）。

其余（标量字段筛选/排序/分页、关系子查询、计算列、根级 `$group`/`$having`、关系聚合谓词）均可正常产出；
单次取数行数上限 1000（省略 `$limit` 也按 1000 封顶，无需因此改写查询）。
