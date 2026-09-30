# Transactional Capabilities (Relation-Predicate Pushdown / Autoincrement PKs / Index DDL)

> This document covers three capability additions aimed at transactional workloads
> (orders, inventory — write contention + complex reads): ① relation predicates in
> mutations, ② `$group by` relation paths, ③ autoincrement integer primary keys,
> ④ index DDL generation. Full change history lives in the common-store repo
> (`事务型能力增补执行文档.md`).

## 1. Relation predicates in mutations (filter `update` / `remove` by related-table fields)

When a filter key in `update` / `updateMany` / `remove` matches a relation name declared in
`schema.relations`, the engine normalizes it into two steps — a **preCommand** (an aggregate
fetching matching `_id`s) plus the main command rewritten as `_id $in`. On SQL backends the
preCommand is pushed down to `EXISTS` via the existing §9.6 machinery; on MongoDB both steps
run as native commands.

```python
# Adjust stock for every inventory row whose product is in a category
# (`product` is a `one` relation declared on Inventory)
await store.updateMany('Inventory', { product: { category: 'meat' } }, { $inc: { stock: 10 } });

// Delete order-item rows of cancelled orders (with archival)
await store.remove('OrderItem', { order: { status: 'cancelled' } });
```

- **Plain condition object**: `{ product: { category: 'meat' } }` (no `$`-prefixed keys) ≡
  `$filter: {…}` + `$exists: true` (semi-join sugar);
- **anti-join**: `{'$not': {'<rel>': {...}}}` or `{'<rel>': {'$exists': False}}`;
- **Aggregate predicates**: main/shorthand forms such as
  `{'<rel>': {'$sum': {'$of': 'quantity', '$gt': 4}}}` are unchanged (§9.6);
- Relation predicates pass relation-level (R6) and sub-field (F3) read permission checks;
  unauthorized access fails with an explicit `ERR_PERMISSION`;
- **Fix**: MongoDB previously treated relation predicates in mutations as a **silent no-op**
  (`modifiedCount=0`, no warning) — both sides are now fixed; the SQL side keeps its
  "untranslatable → explicit error" behavior.

## 2. `$group by` relation path (`one` relations)

Group keys accept a **`one`-relation path** (`relation.targetScalarField`). MongoDB implements
it with `$lookup` + `$unwind` (`preserveNullAndEmptyArrays` — no fan-out, row count semantics
preserved); SQL compiles to `LEFT JOIN g_<rel> ON g_<rel>.fk = t.local` plus the group column.
Unmatched rows fall into the `null` group consistently across backends.

```python
# Count order items per product category (`product` is a `one` relation on OrderItem)
const rows = await store.query(
  'OrderItem($group:@g0){ product.category, n, qty }',
  { g0: { by: ['product.category'],
          agg: { n: { $count: '*' }, qty: { $sum: 'quantity' } } } },
);
# → [{'product': {'category': 'fruit'}, 'n': 3, 'qty': 6}, ...]
```

- **`many` relation paths fail explicitly** (fan-out would break `$count:*` semantics);
  the error message states that only `one` paths are supported;
- When grouping by a relation path, select the same path in the projection (output is a nested
  object `{'product': {'category': ...}}`).

## 3. Autoincrement integer primary keys (`strategy: "autoincrement"`)

Declare `_id` as `{"type": "int", "strategy": "autoincrement"}` to use a database-managed
autoincrement primary key:

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
// doc._id → database-assigned value (PG/SQLite via INSERT…RETURNING; MySQL via insertId)
```

- Without `strategy`, the existing `idPrefix` random-string scheme applies — zero impact on
  existing data;
- DDL generation (`ddl.generate`) emits `INT AUTO_INCREMENT` (MySQL) / `SERIAL` (PG) /
  `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite) per backend;
- **Explicit errors** (no error masking, no silent substitution):
  - inserting a document without `_id` on MongoDB → `AUTOINCREMENT_NOT_SUPPORTED`
    (MongoDB has no autoincrement semantics);
  - `insertMany` on an autoincrement schema → `AUTOINCREMENT_NOT_SUPPORTED`
    (batch last-id reads are unreliable);
- Invalid `strategy` values fail at schema registration (only `"autoincrement"` is supported);
- Archive tables (`<Model>Deleted`) drop the autoincrement strategy automatically
  (they copy the source row's `_id` explicitly).

## 4. Index DDL (`schema.indexes` → CREATE INDEX)

`schema.indexes` (MongoDB shape) is now compiled into real index statements by `ddl.generate`
(emitted right after each table's CREATE TABLE):

```python
schema.register({
  ...,
  indexes: [
    { keys: { orderNo: 1 }, unique: true },   // inline option
    { keys: { buyerId: 1 } },                  // regular index
  ],
});

ddl.generate('postgres', ['Order']);
// → ['CREATE TABLE "orders" (...);',
//    'CREATE UNIQUE INDEX "idx_orders_orderNo" ON "orders" ("orderNo" ASC)',
//    'CREATE INDEX "idx_orders_buyerId" ON "orders" ("buyerId" ASC)']
```

- Index name: `idx_<collection>_<f1>_<f2>`; key values `1 / -1` → `ASC / DESC`;
- Output is byte-identical across MySQL / PostgreSQL / SQLite;
- **The generator only emits text and never executes** (boundary unchanged): on SQL backends
  you run the DDL yourself; on MongoDB `init()` keeps auto-creating indexes from `indexes`
  (existing behavior);
- Duplicate table registrations are de-duplicated with a `ddlDuplicateTable` warning
  (never silent).

## 5. Planned: declarative schema migration

The design is complete for a first whitelist (add table / add column / type widening /
add index; anything outside the whitelist fails with `MIGRATION_UNSUPPORTED`). API shape:
`diff_defs(old, new)` + `generate_migration(backend, old, new)` — pure functions, no database
access, per-dialect generation, raw-SQL passthrough forbidden. Not yet implemented; the
release notes govern once shipped.
