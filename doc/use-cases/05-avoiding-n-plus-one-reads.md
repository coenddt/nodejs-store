# Avoiding N+1 reads

## The problem

An endpoint lists a page of parents (orders) and then, for each parent, goes back to the
database for its children (order items). The first version is one query for the list plus one
query per parent:

```js
// N+1: 1 query for the list + 1 query per parent
const orders = await store.query(
  'Order($condition:@c0,$sort:@s0,$limit:@l){ _id, code }',
  { c0: { status: 'open' }, s0: { createdAt: -1 }, l: 20 },
);

for (const order of orders) {
  order.items = await store.query(
    'OrderItem($condition:@c0,$sort:@s0,$limit:@l){ sku, qty }',
    { c0: { orderId: order._id }, s0: { qty: -1 }, l: 5 },
  );
}
```

A list of 20 parents costs 21 round trips, and the cost grows with the size of the list. Each
trip also re-parses the same shape and re-runs the same permission checks, and nothing keeps
the parent list and its children consistent with each other — a concurrent write between the
two loops is invisible to the result.

## Why nodejs-store

A relation is declared **once** in the schema, not spelled out per read:

```js
relations: {
  items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' },
}
```

Referencing the relation name inside the GQL selection set resolves it as part of the *same*
read:

- **MongoDB** — the relation becomes a `$lookup` stage inside the same aggregation pipeline;
  the whole list is one `aggregate()` call.
- **MySQL / PostgreSQL / SQLite** — the relation becomes a `LEFT JOIN` in the same `SELECT`
  (nested relations become further joins); the whole list is one statement.

You do not hand-write the child query, so it cannot drift from the parent query: the same
`$condition` / `$sort` / `$skip` / `$limit` semantics apply at both levels, and permissions and
computed columns are resolved against the schema for each level.

## Walkthrough

```js
const { store } = require('nodejs-store');

store.register({
  name: 'Order',
  collection: 'orders',
  idPrefix: 'OD',
  timestamps: true,
  fields: {
    code: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
  },
  relations: {
    items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

store.register({
  name: 'OrderItem',
  collection: 'order_items',
  idPrefix: 'OI',
  timestamps: true,
  fields: {
    orderId: { type: 'string' },
    sku: { type: 'string', default: '' },
    qty: { type: 'int', default: 1 },
  },
});

// One read: the parents plus a per-parent window of their items.
const orders = await store.query(
  'Order($condition:@c0,$sort:@s0){ _id, code, status, items($sort:@s1,$limit:@l1){ sku, qty } }',
  {
    c0: { status: 'open' },
    s0: { createdAt: -1 },
    s1: { qty: -1 },
    l1: 5,
  },
);
// orders = [{ _id, code, status, items: [{ sku, qty }, ...] }, ...]
```

That read compiles to one native execution per backend:

```js
// MongoDB — one aggregation pipeline for the whole list
[
  { $match: { status: 'open' } },
  { $sort: { createdAt: -1 } },
  {
    $lookup: {
      from: 'order_items',
      let: { rel__id: { $ifNull: ['$_id', null] } },
      pipeline: [
        { $match: { $expr: { $eq: ['$orderId', '$$rel__id'] } } },
        { $sort: { qty: -1 } },
        { $limit: 5 },
        { $project: { _id: 1, sku: 1, qty: 1 } },
      ],
      as: 'items',
    },
  },
]
```

```sql
-- MySQL / PostgreSQL / SQLite — one statement for the whole list (shape; identifiers are
-- back-quoted on MySQL and double-quoted elsewhere, PostgreSQL binds $n instead of ?)
SELECT t."_id", t."code", t."status",
       r0."sku" AS "items_0_sku", r0."qty" AS "items_0_qty"
FROM "orders" t
LEFT JOIN (
  SELECT * FROM (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c."orderId" ORDER BY c."qty" DESC) AS "__rn"
    FROM "order_items" c
  ) w WHERE w."__rn" <= 5
) r0 ON r0."orderId" = t."_id"
WHERE t."status" = ?
ORDER BY t."createdAt" DESC;
```

The child rows come back flat and are rehydrated into the nested `items` array per parent, so
the application sees the same document shape it would have assembled by hand.

### Paging the parents

Adding a parent window to the same read is where the shape changes. With a root `$skip` /
`$limit`, the planner switches to a **two-phase** shape: phase one selects the page's `_id`s,
phase two matches those `_id`s and resolves the relations.

```js
const orders = await store.query(
  'Order($condition:@c0,$sort:@s0,$skip:@sk,$limit:@l0){ _id, code, items($sort:@s1,$limit:@l1){ sku, qty } }',
  { c0: { status: 'open' }, s0: { createdAt: -1 }, sk: 20, l0: 10, s1: { qty: -1 }, l1: 5 },
);
```

```js
// Phase 1 — page the parent ids
[{ $match: { status: 'open' } }, { $sort: { createdAt: -1 } }, { $skip: 20 }, { $limit: 10 },
 { $project: { _id: 1 } }]

// Phase 2 — resolve the relations for exactly those ids
[{ $match: { _id: { $in: ['...ids from phase 1...'] } } },
 { $lookup: { /* items, as above */ } },
 { $project: { _id: 1, code: 1, items: 1 } }]
```

That is two native executions (two aggregations on MongoDB; two SQL statements on the other
backends), not one, and the ordering is restored from the phase-one `_id` order. It is still
**not N+1**: the number of executions is fixed, independent of how many parents the page
contains. The two-phase shape is used when the read has a relation **and** a root `$skip` /
`$limit`, and the root `$sort` does not reference a relation field.

### What is paged

- The root `$skip` / `$limit` (or `page` / `pageSize` in `queryWithCount`) page the **parent**
  rows. The result has one document per parent.
- A relation-level `$sort` / `$skip` / `$limit` is **per-parent top-N**: `items` above is the
  top 5 items *of each order*, not the first 5 items overall. It never reduces the number of
  parents.
- A relation `$condition` filters the children inside that window; it does not filter parents.
  To filter parents by something across their children ("orders with more than 3 items"), use a
  relation aggregate predicate — a semi/anti-join that does not fan out.
- Sorting parents by a relation field (`$sort: { 'items.qty': -1 }`) also works; the planner
  then keeps everything in one aggregate, because the sort key comes from the joined side.

## Pitfalls

- **It is not always exactly one query.** The parent paging case above is a genuine two-phase
  execution. Check the shape of a specific read before assuming one round trip: the low-level
  command plan is
  `require('nodejs-store').schema.core.planQuery(gql, params, null)`, and its `mode` is
  `'find' | 'aggregate' | 'two_phase'` while its `commands` array is the exact sequence that
  will run (permissions and computes are not applied at this level). `'find'` is the no-relation
  fast path; `'aggregate'` is the single native execution.
- **Cross-source relations do not push down.** If the relation target lives on a different
  `source` (or a different MongoDB database), the relation is removed from the pushed-down query
  and resolved by the federation path: one fetch per source, joined in memory. That is more than
  one query, but still a fixed number of fetches rather than one per parent. The path is bounded:
  each source's rows are capped, and a relation-level `$sort` / `$skip` / `$limit` (or a root
  sort on a cross-source relation field) cannot be pushed per parent — those emit a
  `federation_degraded` event through `setFeedbackSink` instead of failing silently.
- **`queryWithCount` runs a separate count query.** It executes the page query plus a
  `countDocuments` command (so two, or three in the two-phase shape above). Use it for list
  headers, not inside a per-row loop.
- **Relation reads are bounded by the schema.** GQL can only resolve relations you declared in
  `relations`; there is no ad-hoc join. Relation predicates support one level only, and filtering
  directly on an array field, a whole object field or an object dot-path is rejected on every
  backend. An unreadable relation is an error, not a silent `false`.
- **Deep relation chains are truncated.** Nesting is expanded up to the builder's depth limits
  (10 levels overall, and at most 4 paginated relations on a path); beyond that the lookup
  degrades to a foreign-key match only and deeper levels are not expanded — that segment is
  absent rather than an error.
- **An unmappable root `$sort` on SQL fails explicitly.** If a root sort key cannot be mapped to
  a column (unknown field, object/array field, the relation name itself, or no matching
  relation drill-down), the translation marks it unsupported and the command throws
  `PushdownUnsupportedError` **and** emits a `sql_pushdown_unsupported` feedback event, rather
  than returning rows in the wrong order.

## See also

- [GQL syntax](../../README.md#gql-syntax)
- [Aggregation](../../README.md#aggregation)
- [Schema reference](../../README.md#schema-reference)
- [02 — AI data-QA agent](02-ai-data-qa-agent.md)
- [Root README](../../README.md)
