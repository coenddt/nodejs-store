# MongoDB to PostgreSQL migration

## The problem

A service started on MongoDB and now needs PostgreSQL (compliance, reporting, a new team's
tooling — the reason does not matter). The obvious cost is rewriting every query: Mongo
aggregations, `$lookup`s and a pile of driver-specific code, all of which must be re-expressed
in SQL, then re-tested. You also want to see the target's physical structure (types, nullability)
to plan the move, without a migration tool rewriting anything behind your back.

During the transition you may run both databases side by side — a new read path on PostgreSQL,
the old one still on MongoDB — so both must speak the same query language.

## Why nodejs-store

- The schema is defined **once** as pure JSON and carries **no backend-specific fields**, so the
  exact same definition and the exact same GQL work on MongoDB and on PostgreSQL.
- Switching backends is switching the `init()` datasource. The read path picks native aggregation
  on MongoDB and parameterized SQL on PostgreSQL/SQLite/MySQL.
- `store.syncSchema({ backend, driver, overlay })` pulls a SQL backend's physical structure into
  the registry (`introspect → schemaFromRows → mergeSchema(overlay) → register`) so you can see
  what is actually there and merge your local permissions/computes on top.

## Walkthrough

```js
const { init, store } = require('nodejs-store');

// One schema definition — no backend-specific fields.
const Order = {
  name: 'Order',
  collection: 'orders',
  idPrefix: 'OD',
  timestamps: true,
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    amount: { type: 'float', default: 0 },
    createdBy: { type: 'string' },
  },
  computes: {
    total: { type: 'float', depends: ['amount'], fn: (d) => d.amount * 1.1 },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
  read: ['editor', 'viewer'],
  write: ['editor'],
};
store.register(Order);

// The same GQL string for both backends.
const gql = 'Order($condition:@c0,$sort:@s0){ _id, title, status, total }';
const params = { c0: { status: 'open' }, s0: { createdAt: -1 } };

// Today: MongoDB (native aggregation).
await init({ default: mongoDb });
const fromMongo = await store.query(gql, params);

// Tomorrow: PostgreSQL — only the datasource changes; the GQL above is unchanged.
await init({ default: { kind: 'postgres', exec: pgPool } });
const fromPostgres = await store.query(gql, params);
```

To inspect the PostgreSQL structure and merge your local defs on top:

```js
const { syncSchema } = require('nodejs-store'); // same function as store.syncSchema

const defs = await store.syncSchema({
  backend: 'postgres',
  driver: pgPool,        // prefer a read-only account
  overlay: [Order],      // local permissions / computes / overrides merged on top
  datasource: 'pg_a',
});
// defs: merged schemaJSON[] — introspection only, no DDL is written back.
```

## Pitfalls

- **`syncSchema` is read-only — there is no DDL or migration engine.** It only *reads* physical
  structure through introspection; schema changes and DDL remain your migration tool's job. It
  also cannot create tables that do not exist yet.
- **Same query, different transaction boundaries.** On a single SQL source, `mutation` step
  sequences and `remove` (archive + delete) run inside one driver transaction. On MongoDB,
  multi-step `mutation` and `remove` execute sequentially and are **not** atomic across steps
  (Mongo transactions require a replica set). Plan compensation for cross-step consistency on
  Mongo.
- **Boundary rules are enforced on every backend.** Filtering directly on array fields, on a
  whole object field or on object dot-paths is rejected on all four backends — model
  cross-entity semantics as `relations` instead. Relation predicates support one level only.
- **Physical structure first.** `syncSchema` introspects what already exists; the PostgreSQL
  tables must be provisioned (by your migration tool) before introspection is meaningful.

## See also

- [`store.syncSchema`](../../README.md#storesyncschemaopts)
- [Transaction boundary](../../README.md#transaction-boundary)
- [Schema reference](../../README.md#schema-reference)
- [Root README](../../README.md)
