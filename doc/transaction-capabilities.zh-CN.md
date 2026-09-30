# 事务型能力增补（关系谓词下推 / 自增主键 / 索引落地）

> 本文覆盖面向事务型业务场景（订单、库存等「写竞争 + 复杂读」）的三项能力增补：
> ① mutation 关系谓词下推、② `$group by` 关系路径、③ 自增 int 主键、④ 索引落地。
> 完整变更留痕见 common-store 仓库《事务型能力增补执行文档.md》。

## 1. mutation 关系谓词下推（update / remove 按关联表字段过滤）

`update` / `updateMany` / `remove` 的过滤条件键命中 `schema.relations` 的关系名时，
引擎自动归一为「preCommand（aggregate 取命中 `_id`）+ 主命令 `_id $in`」两段执行——
SQL 侧 preCommand 由既有 §9.6 机制下推为 `EXISTS`，Mongo 侧两段原生命令直接执行。

```python
# 按关联商品类目批量调库存（product 是 Inventory 声明的 one 关系）
await store.updateMany('Inventory', { product: { category: 'meat' } }, { $inc: { stock: 10 } });

// 删除已取消订单的明细行（含归档）
await store.remove('OrderItem', { order: { status: 'cancelled' } });
```

- **整值条件对象**：`{ product: { category: 'meat' } }`（spec 全部键不带 `$`）≡
  `$filter: {该对象}` + `$exists: true`（semi-join 语义糖）；
- **anti-join**：`{'$not': {'<rel>': {...}}}` 或 `{'<rel>': {'$exists': False}}`；
- **聚合谓词**：`{'<rel>': {'$sum': {'$of': 'quantity', '$gt': 4}}}` 等主/简写形式不变（§9.6）；
- 关系谓词同样过读权限（关系级 R6 + 子字段 F3），越权显式 `ERR_PERMISSION`；
- **修复**：此前 Mongo 侧 mutation 遇关系谓词是**静默 no-op**（`modifiedCount=0` 无告警），
  现已两端同修；SQL 侧的「无法安全翻译即显式报错」行为保持。

## 2. `$group by` 关系路径（one 关系）

分组键支持 **one 关系路径**（`关系名.目标表标量字段`），Mongo 侧以 `$lookup` + `$unwind`
（preserveNullAndEmptyArrays）实现（one 不扇出、行数与计数语义不变）；SQL 侧编译为
`LEFT JOIN g_<rel> ON g_<rel>.fk = t.local` + 分组列。无匹配行归入 null 组（跨后端一致）。

```python
# 订单项按商品类目统计件数（product 是 OrderItem 的 one 关系）
const rows = await store.query(
  'OrderItem($group:@g0){ product.category, n, qty }',
  { g0: { by: ['product.category'],
          agg: { n: { $count: '*' }, qty: { $sum: 'quantity' } } } },
);
# → [{'product': {'category': 'fruit'}, 'n': 3, 'qty': 6}, ...]
```

- **many 关系路径显式报错**（扇出会破坏 `$count:*` 等聚合语义），错误文案指明仅支持 one；
- by 键为关系路径时选择集用同路径（输出为嵌套对象 `{'product': {'category': ...}}`）。

## 3. 自增 int 主键（`strategy: "autoincrement"`）

`_id` 声明 `{"type": "int", "strategy": "autoincrement"}` 即启用数据库自增主键：

```python
schema.register({
  name: 'Order', collection: 'orders', timestamps: false,
  read: [...], write: [...],
  fields: {
    _id: { type: 'int', strategy: 'autoincrement' },
    orderNo: { type: 'string' },
  },
  relations: {}, computes: {},
});

const doc = await store.insert('Order', { orderNo: 'A001' });
// doc._id → 数据库自增值（PG/SQLite 经 INSERT…RETURNING 回读；MySQL 经 insertId）
```

- 不声明 `strategy` 保持既有 idPrefix 随机串方案，历史数据零影响；
- DDL 生成（`ddl.generate`）按后端产出 `INT AUTO_INCREMENT`（MySQL）/ `SERIAL`（PG）/
  `INTEGER PRIMARY KEY AUTOINCREMENT`（SQLite）；
- **显式报错清单**（no-error-masking，禁静默顶替）：
  - MongoDB 后端插入无 `_id` 文档 → `AUTOINCREMENT_NOT_SUPPORTED`（Mongo 无自增语义）；
  - `insertMany` 用于 autoincrement schema → `AUTOINCREMENT_NOT_SUPPORTED`
    （批量自增值回读不可靠）；
- 非法 `strategy` 值在 schema 注册期显式报错（仅支持 `"autoincrement"`）；
- 归档表（`<Model>Deleted`）自动剔除自增语义（显式拷贝源行 `_id`）。

## 4. 索引落地（`schema.indexes` → CREATE INDEX）

`schema.indexes`（Mongo 形态）由 `ddl.generate` 产出真实索引语句（每表 CREATE TABLE 后跟随）：

```python
schema.register({
  ...,
  indexes: [
    { keys: { orderNo: 1 }, unique: true },   // inline 选项
    { keys: { buyerId: 1 } },                  // 普通索引
  ],
});

ddl.generate('postgres', ['Order']);
// → ['CREATE TABLE "orders" (...);',
//    'CREATE UNIQUE INDEX "idx_orders_orderNo" ON "orders" ("orderNo" ASC)',
//    'CREATE INDEX "idx_orders_buyerId" ON "orders" ("buyerId" ASC)']
```

- 索引名 `idx_<collection>_<f1>_<f2>`；keys 值 `1 / -1` → `ASC / DESC`；
- 三方言（MySQL/PostgreSQL/SQLite）输出逐字节对齐；
- **生成器只产出文本、不执行**（边界不变）：SQL 侧由你执行 DDL 文本落库；
  Mongo 侧 `init()` 继续按 indexes 自动 `create_index`（既有行为）；
- 同名表重复注册时去重并触发 `ddlDuplicateTable` 告警（禁静默）。

## 5. 规划中：声明式 schema 迁移

首批白名单（加表 / 加列 / 类型放宽 / 加索引；白名单外显式 `MIGRATION_UNSUPPORTED`）的
设计已完成（API：`diff_defs(old, new)` + `generate_migration(backend, old, new)`，
纯函数、不连库、per-dialect 生成、禁 SQL 透传），尚未实施，发布说明以正式发版为准。
