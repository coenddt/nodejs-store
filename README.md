# nodejs-store

**One data layer for MongoDB, MySQL, SQLite and PostgreSQL — define models as pure JSON, query them with a MongoDB-style GQL tree syntax, and get role-based access control, computed columns and soft-delete out of the box.**

![npm version](https://img.shields.io/npm/v/nodejs-store)
![license](https://img.shields.io/npm/l/nodejs-store)
![node](https://img.shields.io/node/v/nodejs-store)
![backends](https://img.shields.io/badge/backends-MongoDB%20%7C%20MySQL%20%7C%20SQLite%20%7C%20PostgreSQL-blue)
![query dialect](https://img.shields.io/badge/query%20dialect-GQL%20(MongoDB--flavoured)-green)

`nodejs-store` lets a Node.js service talk to MongoDB (native aggregation), MySQL, PostgreSQL and SQLite through a **single schema definition and a single query dialect**. Nested relations compile to **one native query per backend** — you never hand-write `$lookup` or raw SQL.

> Also looking for the Python version? See [`py-store`](https://github.com/coenddt/py-store) (pip `storepy`). Both are thin hosts over the shared Rust engine [`rust-store`](https://github.com/coenddt/rust-store).
> 中文文档见 [README.zh-CN.md](README.zh-CN.md)。

**Documentation site:** <https://coenddt.github.io/nodejs-store/> — every scenario walkthrough with runnable code and the engine's exact limits, one indexable page per scenario.

---

## Table of contents

- [What it is](#what-it-is)
- [When to use it](#when-to-use-it)
- [When not to use it](#when-not-to-use-it)
- [How it compares](#how-it-compares)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Supported backends](#supported-backends)
- [Features](#features)
- [GQL tree queries](#gql-syntax)
- [Aggregation](#aggregation)
- [Query & write API](#query--write-api)
- [Multi-datasource connections](#multi-datasource-connections)
- [Permission context](#permission-context)
- [Schema reference](#schema-reference)
- [Advanced API](#advanced-api)
- [Transactions](#transaction-boundary)
- [FAQ](#faq)
- [Related projects](#related-projects)

---

## What it is

A lightweight, backend-agnostic data layer for Node.js. You describe your models once as pure JSON (`fields`, `relations`, `computes`, `indexes`, `read`/`write` role whitelists). From that description the library derives:

- **command planning** (GQL → Mongo command JSON) — executed by the Rust core `rust-store-node`,
- **dialect translation** (command JSON → parameterized SQL) for MySQL / PostgreSQL / SQLite,
- **permission checks** (schema-level + field-level read/write, owner-condition injection),
- **computed columns**, **soft-delete archives**, and **result rehydration** (flat JOIN rows → nested documents).

MongoDB is the *primary dialect*: queries are written in a MongoDB-flavoured GQL, and the three relational backends adapt to it. That is what makes one schema portable across a document store and three relational stores.

### How it relates to py-store and rust-store

```
                 ┌──────────────────────────────┐
   Node.js  ──▶  │  nodejs-store (npm, host)    │ -┐
                 └──────────────────────────────┘  │  rust-store-node (napi-rs)
                                                   ▼
                                     ┌───────────────────────────────┐
                                     │ rust-store/core (pure logic)  │
                                     │ GQL · permissions · computes  │
                                     │ command planning · dialects   │
                                     └───────────────────────────────┘
                                                   ▲
                 ┌──────────────────────────────┐  │  rust-store-py (PyO3)
   Python   ──▶  │  py-store (pip, host)        │ -┘
                 └──────────────────────────────┘
```

The **Rust core** owns GQL parsing, permission checks, computed columns, command planning and SQL dialect translation — it never touches a database. The **hosts** (`nodejs-store`, `py-store`) own driver IO, callbacks and placeholder substitution. Behaviour therefore cannot drift between Node.js and Python: there is only one implementation.

## When to use it

Reach for `nodejs-store` when any of these describe your situation:

- **One codebase, several databases.** You ship the same service against MongoDB in dev and PostgreSQL in production (or per-tenant), and you don't want two data-access layers.
- **You need nested / relational reads without writing `$lookup` or JOINs.** Order → items, Course → lessons, User → orders — all expressed once in the schema and resolved in a single query.
- **You are building an admin backend or internal CRUD service** and want schema-driven CRUD, soft-delete, computed columns and role checks without a full ORM.
- **You need row-level / field-level access control.** Whitelists per role, `guest` can never write, `creator` ownership is checked against `doc.createdBy`, and owner conditions are injected automatically into queries.
- **You are building an AI / natural-language data-QA layer.** The library was designed with AI query hosts in mind: `buildPipeline()` exposes the planned query without executing it, and degraded / non-pushdownable paths emit structured feedback events instead of failing silently. See the companion skill [`text-to-query`](#related-projects).
- **You are migrating between MongoDB and SQL** and want to keep one query syntax during the transition.
- **Multi-tenant SaaS.** One schema definition, N tenants: bind a schema to `(source, namespace, collection)` and re-target any query or write at execution time with a `{ source, namespace }` override.

Typical concrete scenarios (see [`doc/use-cases/`](doc/use-cases/) for full walkthroughs):

| Scenario | Why nodejs-store fits |
| --- | --- |
| Multi-tenant SaaS with per-tenant schema/database | `namespace` per tenant + runtime route override, one schema |
| Admin dashboard / internal tool | Schema-driven CRUD, soft-delete, computed columns, RBAC |
| MongoDB today, PostgreSQL tomorrow | Same GQL + same schema, only the datasource changes |
| AI data-QA / text-to-query agent | Plan-only `buildPipeline`, deterministic command JSON, feedback events |
| Mixed SQL + Mongo in one product | Cross-source queries with native SQL pushdown and Mongo in-memory federation |
| Audit-friendly CRUD | Every schema auto-gets a `<Model>Deleted` archive table/collection |

## When not to use it

Being explicit about the boundary saves you time:

- **You want a full ORM with a migration engine.** `nodejs-store` is a *data layer*, not a migration tool. It can **read** a SQL backend's physical structure (`syncSchema` → introspection) but it never writes DDL back. Pair it with your migration tool of choice.
- **You need a type-safe generated client.** Schemas are runtime JSON, not TypeScript types. You get flexibility and cross-language parity (same schema runs in Node and Python), not compile-time type inference.
- **You only ever use one database and rarely join.** A plain driver (or a single-database ODM/ORM) will be simpler.
- **You need raw aggregation escape hatches.** `$pipeline` passthrough and `store.aggregate()` were deliberately removed. Use `$condition` / `$group` / `$having` / relations; anything that cannot be safely translated fails **explicitly** rather than silently.
- **You are on SQLite in a high-concurrency hot path.** The SQLite executor uses the synchronous `better-sqlite3` driver by design — calls block the event loop. Prefer MySQL / PostgreSQL / MongoDB there, or isolate SQLite in its own process.

## How it compares

General positioning, not a benchmark — always verify against each tool's current docs.

| | nodejs-store | Mongoose | Prisma | TypeORM / Sequelize | Drizzle |
| --- | --- | --- | --- | --- | --- |
| Primary shape | JSON schema + GQL data layer | ODM (MongoDB) | Schema DSL + generated client | Decorator/entity ORM | TypeScript SQL builder |
| Backends | MongoDB, MySQL, SQLite, PostgreSQL | MongoDB | PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, CockroachDB | MySQL, PostgreSQL, SQLite, MSSQL, Oracle (+ MongoDB) | PostgreSQL, MySQL, SQLite, … |
| One query dialect across Mongo **and** SQL | ✅ (MongoDB-flavoured GQL) | ➖ (Mongo only) | ➖ (one client per provider) | ⚠️ (Mongo model differs from SQL entities) | ➖ (SQL only) |
| Nested relation reads in one query | ✅ declarative relations → `$lookup` / `JOIN` | ✅ `populate()` | ✅ `include` | ✅ relations | ⚠️ manual joins |
| Built-in role / field-level RBAC + owner injection | ✅ | ➖ | ➖ (via extensions) | ➖ | ➖ |
| Read-time computed columns (sync / async / relation-agg) | ✅ | ➖ (getters) | ➖ | ➖ | ➖ |
| Soft-delete archive table auto-provisioned | ✅ | ➖ | ➖ | ➖ | ➖ |
| Migration / DDL engine | ➖ (introspection read-only) | ➖ | ✅ | ✅ | ✅ |
| Static type generation | ➖ (runtime JSON, cross-language parity) | ➖ | ✅ | ⚠️ (decorators + TS) | ✅ |
| Shared native core across Node & Python | ✅ (Rust `rust-store`) | ➖ | ➖ | ➖ | ➖ |

### How it differs from specific libraries

Positioning only, based on those projects' public documentation at the time of writing — verify against your own requirements.

- **vs Mongoose** — Mongoose is MongoDB-only. `nodejs-store` uses a similar MongoDB-style query syntax (`$gt`, `$or`, `$set`, `$inc`) but the same query also runs unchanged against MySQL, SQLite and PostgreSQL.
- **vs `mongoosql-core`** — the closest in spirit: it also runs Mongoose-style queries on MongoDB, PostgreSQL and MySQL. `nodejs-store` additionally targets SQLite, ships schema-level permissions (role/field whitelists plus `creator` owner-condition injection), read-time computed columns (`fn` / `asyncFn` / relation-`agg`), an auto-provisioned `<Model>Deleted` soft-delete archive, and shares one Rust engine with a Python host so Node.js and Python cannot drift apart.
- **vs `unsql`** — `unsql` generates SQL from plain JavaScript objects for MySQL, PostgreSQL and SQLite. It does not target MongoDB, and it is a query/CRUD helper rather than a schema-driven data layer with permissions and computed columns.
- **vs Prisma** — Prisma is a schema DSL plus generated client with a migration engine and compile-time types. `nodejs-store` is a runtime JSON schema with no DDL or migration responsibility (it only *reads* physical structure via introspection) and no type generation — in exchange for one query dialect spanning a document store and three relational stores.
- **vs TypeORM / Sequelize / Drizzle** — Sequelize and Drizzle are SQL-only; TypeORM models MongoDB separately from its SQL entities. `nodejs-store` treats MongoDB as the primary dialect and compiles the same GQL to SQL for the other three backends.

Short version: use an ORM when you want **compile-time types and migrations**; use `nodejs-store` when you want **one runtime schema + one query dialect spanning MongoDB and SQL**, with RBAC and computed columns built in.

## Installation

```bash
npm install nodejs-store
```

Requires Node.js 18+ and one supported backend (MongoDB / MySQL / SQLite / PostgreSQL).

## Quick start

```js
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();
await init(client.db('mydb')); // idempotently creates indexes for registered schemas

// Register a schema (pure JSON)
store.register({
  name: 'Post',          // model name used in GQL
  collection: 'posts',   // optional, defaults to name
  idPrefix: 'PT',        // string _id: prefix + base36 timestamp + random
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    tags: { type: 'array', default: [] },
  },
  computes: {
    statusLabel: {
      type: 'string',
      depends: ['status'],
      fn: (doc) => (doc.status || '').toUpperCase(),
    },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

// Write — only user data; defaults are filled on read
const doc = await store.insert('Post', { title: 'Hello' });

// Query — GQL tree syntax, values referenced from params via @key
const items = await store.query(
  'Post($condition:@c0,$sort:@s1,$limit:@l) { title, status, statusLabel }',
  { c0: { status: 'draft' }, s1: { createdAt: -1 }, l: 20 },
);
```

The same schema and the same query run unchanged against PostgreSQL — only the `init()` datasource changes:

```js
await init({ default: { kind: 'postgres', exec } });   // exec: your pg pool adapter
const items = await store.query('Post($condition:@c0) { title, status }', { c0: { status: 'draft' } });
```

## Supported backends

| Backend | Notes |
| --- | --- |
| MongoDB | native aggregation pipeline (`find`/`aggregate`/`$lookup`) |
| MySQL | parameterized SQL, `information_schema` introspection |
| SQLite | parameterized SQL, `sqlite_master` + `PRAGMA` introspection. **Sync driver** (`better-sqlite3`): calls block the event loop by design — for high-concurrency hot paths prefer MySQL/PostgreSQL/MongoDB, or isolate SQLite in a dedicated process |
| PostgreSQL | parameterized SQL (`$n`), `RETURNING` support |

GQL tree queries compile to a single native query per backend — never hand-write `$lookup` or raw SQL again.

## Features

- **Pure JSON schemas, zero code** — a model is just an object: fields, relations, computes, indexes.
- **GQL tree queries → one native query** — nested relations resolve in a single query; never hand-write `$lookup` again.
- **Normalized aggregation** — root-level `$group` / `$having` and relation aggregate predicates (semi/anti-join) in the same GQL, pushed down to all four backends.
- **Read-time defaults & computed columns** — writes store only user data; reads fill defaults and run `fn` / `asyncFn` / relation-`agg` computes.
- **Smart mutation** — `mutation()` auto-detects upsert by `_id` + unique index and recursively fills relation children.
- **Soft-delete built in** — every schema auto-registers a `<Model>Deleted` archive collection/table; `remove()` archives before deleting.
- **Permission context** — `AsyncLocalStorage`-based roles (`super_admin`/`admin`/`guest`/`creator`...), schema/field-level read/write whitelists, automatic owner-condition injection.
- **Multi-datasource & multi-tenant** — locate a schema by `(source, namespace, collection)`; re-target per request with a route override.
- **Async-first, Rust core** — built on the `mongodb` Node.js driver and a shared Rust core with SQL dialects.

## GQL syntax

```text
Model($condition:@c0,$sort:@s1,$skip:@sk,$limit:@l1) {
  field1, field2, obj.subField,
  Relation($condition:@c2,$sort:@s3,$limit:@l2) { f3, Nested { f4 } }
}
```

- Values come from the params object: `{ c0: {...}, s1: {...} }`.
- Object sub-fields use dot notation; relations are declared in the schema (`type: 'many' | 'one'`) and resolved automatically — **do not hand-write `$lookup`**.
- `many` relations return arrays (`[]` when empty); `one` relations merge into the parent document (`null` when missing).
- Relation-level `$sort`/`$skip`/`$limit` are **per-parent top-N** (each parent gets its own window; translated to a window function on SQL).

> **Breaking change**: user `$pipeline` passthrough and `store.aggregate()` were removed (raw aggregation escape hatch). A GQL containing `$pipeline` now fails explicitly instead of being silently ignored.

## Aggregation

Normalized aggregation lives **inside GQL** — no separate API, no raw pipeline.

**Root-level `$group` + `$having`** (GROUP BY / HAVING):

```js
const rows = await store.query(
  'Course($condition:@c0,$group:@g0,$having:@h0,$sort:@s0,$limit:@l0){ status, n, total }',
  {
    c0: { status: { $ne: 'deleted' } },
    g0: { by: ['status'], agg: { n: { $count: '*' }, total: { $sum: 'price' } } },
    h0: { n: { $gt: 1 } },
    s0: { total: -1 },
    l0: 20,
  },
);
```

- Whitelisted operators: `$count` / `$sum` / `$avg` / `$min` / `$max`.
- Fixed execution order: `$condition` (WHERE) → `$group` (GROUP BY) → `$having` (HAVING) → `$sort` → `$skip`/`$limit` → projection.
- Omit `by` (or pass `[]`) for a single all-table group; the empty-input case still returns one row (`$count` → `0`, others → `null`).

**Relation aggregate predicates (semi / anti-join)** — filter parents by an aggregate over a relation, without fanning out:

```js
await store.query('Product($condition:@c0,$sort:@s0){ _id, name }', {
  c0: {
    $and: [
      { status: 'onSale' },
      { orders: { $count: { $gt: 3 } } },                                  // has > 3 orders
      { $not: { orders: { $sum: { $of: 'amount', $gt: 10000 } } } },       // not a whale
    ],
  },
  s0: { name: 1 },
});
```

Translates to `EXISTS` / `NOT EXISTS` on SQL and `$lookup` + `$match` on MongoDB.

**Relation-rolling computed columns** — declare once in the schema, request by name:

```js
computes: {
  itemCount: { type: 'int', agg: { $count: 'items' } },       // 0 when empty
  itemsTotal: { type: 'float', agg: { $sum: 'items.qty' } },  // null when empty
}
```

## Query & write API

```js
const items  = await store.query(gql, params);            // Array
const one    = await store.queryOne(gql, params);         // object | null
const page   = await store.queryWithCount(gql, params);   // { items, total, hasMore, page, pageSize } (pageSize capped at 5000)
const exists = await store.exists('Post', { _id: pid });
const n      = await store.count('Post', { status: 'active' });

const doc    = await store.insert('Post', { ... });       // auto _id / createdAt / updatedAt
const docs   = await store.insertMany('Post', [{ ... }, ...]);
await store.update('Post', { _id: pid }, { status: 'live' });      // plain fields → $set
await store.update('Post', { _id: pid }, { $inc: { views: 1 } });  // '$'-prefixed keys pass through as operators
await store.updateMany('Post', { type: t }, { status: 'live' });
const r      = await store.remove('Post', { _id: pid });  // archives to <collection>_deleted first
await store.mutation('Post', { ... });                    // smart upsert + recursive relation children
await store.upsert('Post', { code: 'A1' }, { ... });      // explicit-condition upsert (no relation handling)
```

Notes:

- `null`/`undefined` values are stripped before persisting; `_id` cannot be changed via `update`.
- `createdAt`/`updatedAt` (ms) are framework-maintained — do not set them manually.
- `queryWithCount` accepts `page`/`pageSize` (recommended) or the traditional `$skip`/`$limit` params.
- `updateMany` / `remove` with an **empty condition** (`{}`, `null`, `{ "$and": [] }`) is rejected outright — it never falls through to a full-table write.

## Multi-datasource connections

Every schema is located by the triple `(source, namespace, collection)` — the triple must be
globally unique across the registry (duplicate registration throws instead of silently
mis-routing).

- `source` — connection key in `init({...})` (default `"default"`).
- `namespace` — database/schema inside the connection: Mongo db name, PG schema,
  MySQL database, SQLite attached db. Optional; `null` = connection default.
- `collection` — table/collection name.

```js
// Multiple Mongo servers: one source per connection
await init({ mongo_main: db, pg_a: { kind: 'postgres', exec } });

// Same MongoClient serving multiple databases: declare namespace (db name)
await init({ cluster: client });
store.register({ name: 'User', collection: 'users', datasource: 'cluster', namespace: 'tenant_42', ... });

// SQL cross-namespace joins are pushed down natively ("ns_a"."t" JOIN "ns_b"."t");
// only Mongo cross-db relations fall back to in-memory federation.
```

**Multi-tenant route override** — one schema definition, N tenants. Any query/write accepts
a `{ source, namespace }` override that re-targets commands at execution time (permissions
and computed columns still follow the structural schema):

```js
await store.query('User($condition:@c0){...}', params, { namespace: 'tenant_42' });
await store.insert('Order', data, { source: 'pg_cluster', namespace: 'tenant_7' });
```

**`routeOverride` is a trusted server-side parameter** — it carries no origin check, so
forwarding user-controlled input into it lets a caller re-target another tenant's
`source`/`namespace` (CWE-639 authorization-bypass surface). Never pass raw request data here.

Legacy single-db usage (`init(db)` + schema without `datasource`/`namespace`) is unchanged:
commands carry `source: 'default'`, `namespace: null`.

## Permission context

```js
// Set once per request (in middleware/router layer)
store.setContext({ userId: uid, roles: ['editor'] });

// Nested-safe role scoping
store.scopedRoles(['viewer'], () => store.query(gql, params));

// Internal/cron jobs — bypass permission checks
await store.runAsInternal(() => store.remove('Post', { _id: pid }));
```

- `super_admin`/`admin`/`internal` roles pass everything; other roles are checked against schema-level and field-level `read`/`write` whitelists; `guest` can never write.
- `creator` is a pseudo-role resolved by `doc.createdBy === ctx.userId`; schemas granting it automatically get owner conditions injected on queries and ownership checks on update/remove.
- No context set → permission checks disabled (backward compatible).
- Denied access throws `store.PermissionError` (with `status = 403`).

### Fail-secure mode (opt-in)

"No context" can mean both *system call* and *caller forgot the context* — by default the
latter silently passes every check (fail-open, kept for backward compatibility). For
security-sensitive hosts, enable the context requirement once at startup:

```js
store.setRequireContext(true);
// now every query/write without a context throws `ERR_NO_CONTEXT:...`
// internal jobs must be explicit:
await store.runAsInternal(() => store.remove('Post', { _id: pid }));
```

`runAsInternal` marks the call as `{ internal: true }`, which is semantically distinct from
a missing context and always passes. `setRequireContext(false)` restores the default.

## Schema reference

```js
{
  name: 'Order',
  collection: 'orders',
  idPrefix: 'OD',
  timestamps: true,                  // default: auto-maintain createdAt/updatedAt (ms)
  fields: {
    _id: 'string',                                        // shorthand
    title: { type: 'string', default: '' },
    meta: { type: 'object', default: {}, fields: { ... } },  // nested object fields
  },
  relations: {
    items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' },
  },
  computes: {
    total: { type: 'float', depends: ['amount'], fn: (d) => d.amount * 1.1 },
    itemCount: { type: 'int', agg: { $count: 'items' } },
  },
  indexes: [
    { keys: { status: 1 } },
    { keys: { code: 1 }, options: { unique: true } },
  ],
  read: ['editor', 'viewer'],        // optional schema-level role whitelists
  write: ['editor'],
}
```

Types: `string | int | long | float | double | boolean | array | object | date | any`.

Boundary rules worth knowing up front (all **fail explicitly**, never silently degrade):

- Filtering on array fields directly, on a whole object field, or on object dot-paths is rejected on every backend — model cross-entity semantics as `relations` instead.
- Relation predicates support **one level** of relation; paths like `orders.items.price` are rejected.
- An unreadable relation is an error, not a silent `false`.

## Advanced API

Everything below is reachable from the exported `store` singleton or the modules it
re-exports. Options prefixed with `?` are optional.

### `store.buildPipeline(gql, params?)`

Low-level parse — compiles GQL to the command plan **without executing it**, returning
`{ tokens, ast, pipeline, projection }`. Useful for debugging query shape, asserting
pushdown behaviour, or building custom tooling (e.g. an AI query agent that must show and
validate a plan before running it). Permissions / computes are **not** applied here.

```js
const plan = store.buildPipeline('Post($condition:@c0){ title }', { c0: { status: 'draft' } });
console.log(plan.pipeline);
```

### `store.syncSchema(opts)`

Pull a SQL backend's physical structure into the registry
(`introspect → schemaFromRows → mergeSchema(overlay) → register`). It only **reads** the
structure — it never writes DDL back to the database.

| Option | Type | Meaning |
| --- | --- | --- |
| `backend` | `'mysql' \| 'postgres' \| 'sqlite'` | required |
| `driver` | object | required; prefer a read-only account |
| `introspectOptions` | object | passed through to introspection (e.g. PG `schema`) |
| `overlay` | `Array` | local schemaJSON merged on top (permissions / computes / overrides) |
| `datasource` | string | bind every merged def to this source |
| `namespace` | string | bind every merged def to this namespace |
| `registerDefs` | boolean (default `true`) | `false` = return defs without registering |

Returns the merged `schemaJSON[]`.

```js
const defs = await store.syncSchema({
  backend: 'postgres', driver: pgPool, overlay: [Post], datasource: 'pg_a',
});
```

### `store.setFeedbackSink(fn)`

Take over the unified feedback channel used for fallback / degradation / interception
events. The sink receives one event object; pass `null` (or a non-function) to fall back to
the default stderr printer.

```js
store.setFeedbackSink((e) => logger.warn({ code: e.code }, e.hint));
// event shape: { type, code, layer, message, hint, ... }
//   type   federation_degraded | sql_pushdown_unsupported | ...
//   code   crossSourceSort | pushdownUnsupported | ...
//   layer  federation | dialect | ...
```

Non-pushdownable commands also throw `PushdownUnsupportedError` — catch it to re-run that
segment against a Mongo source.

### Low-level modules

The package re-exports its building blocks for advanced hosts:

```js
const {
  init, store, Store,
  PermissionError,              // thrown on denied access (status = 403)
  PushdownUnsupportedError,     // thrown when a command cannot be safely pushed down
  datasource, schema, permission, crud, executors, feedback, introspect,
  syncSchema,                   // same function as store.syncSchema
} = require('nodejs-store');

// introspect.run(backend, driver, options) → normalized structure rows
const rows = await introspect.run('mysql', pool, {});

// executors.createConnection(kind, driver, options) → SQL datasource descriptor { kind, exec }
await init({ default: db, pg_a: executors.createConnection('postgres', pgPool) });
```

- `schema` / `permission` / `feedback` / `datasource` expose the same functions the `store`
  singleton delegates to (e.g. `datasource.setConnections`, `datasource.hasConnection`,
  `datasource.isSql`, `datasource.runInTransaction`).
- **Multi-tenant route override** — pass `{ source, namespace }` as the last argument of any
  query/write, see [Multi-datasource connections](#multi-datasource-connections).

## Transaction boundary

- **Single SQL source**: `mutation` parent-child step sequences and `remove` (archive + delete) run inside one driver transaction on one checked-out connection — any step failure rolls back the whole sequence.
- **Each SQL write command** is itself atomic: multi-statement plans (e.g. MySQL write + readback) are transaction-wrapped in the executor.
- **Mongo sources**: single-document writes are atomic; multi-step `mutation` and `remove` execute sequentially and are **not** atomic across steps (Mongo transactions require a replica set). If your consistency requirement spans steps on Mongo, either use an SQL source for those models or add application-level compensation.
- **Archive idempotency**: `remove` archives with upsert-by-`_id` semantics, so a retry after partial failure no longer fails on duplicate `_id`.
- **Cross-source steps** (parent and child bound to different datasources) cannot be atomic — they run sequentially by design.

## FAQ

**How do I use one schema for both MongoDB and PostgreSQL in Node.js?**
Define the schema once as JSON, call `init()` with your datasource(s), and run the same GQL against either. MongoDB uses native aggregation; MySQL/PostgreSQL/SQLite get parameterized SQL. See [Quick start](#quick-start).

**How do I query nested / related data without writing `$lookup` or JOINs?**
Declare the relation in `relations` (`{ model, type: 'many' | 'one', localField, foreignField }`) and reference the relation name inside the GQL selection set. It becomes `$lookup` on Mongo and a `JOIN` on SQL, returned as nested documents.

**Does it support GROUP BY / COUNT / SUM / AVG?**
Yes — normalized aggregation is part of GQL: root-level `$group` / `$having` and relation aggregate predicates. See [Aggregation](#aggregation).

**Can I filter parents by an aggregate of their children ("products with more than 3 orders")?**
Yes — relation aggregate predicates implement semi/anti-join without fanning out; SQL uses `EXISTS`/`NOT EXISTS`.

**How do I implement row-level permissions?**
Use `store.setContext({ userId, roles })` plus schema-level `read`/`write` whitelists. The `creator` pseudo-role adds automatic ownership checks and owner-condition injection. `guest` can never write. Turn on `setRequireContext(true)` for fail-secure behaviour.

**How do I do soft delete?**
Every registered model automatically gets a `<Model>Deleted` archive collection/table. `store.remove()` archives the document first, then deletes it; re-creating the same `_id` does not collide because the archive write is upsert-by-`_id`.

**Is it usable for multi-tenant applications?**
Yes. Bind a schema to `(source, namespace, collection)` and pass a `{ source, namespace }` route override per request. Treat `routeOverride` as trusted server-side input only.

**Does it run migrations?**
No. `syncSchema()` only *reads* physical structure via introspection (introspect → merge overlay → register). Schema changes / DDL are your migration tool's job.

**Can I see the generated query without running it?**
Yes — `store.buildPipeline(gql, params)` returns the compiled plan (`{ tokens, ast, pipeline, projection }`) with no execution and no permission/compute application.

**What happens when SQL pushdown isn't possible?**
The command throws `PushdownUnsupportedError` **and** emits a structured feedback event (`sql_pushdown_unsupported`) through `setFeedbackSink`. Cross-source pagination/sort degradations emit `federation_degraded` events. Nothing fails silently.

**How is it related to py-store and rust-store?**
`rust-store` is the shared Rust engine (GQL parsing, permissions, computed columns, command planning, SQL dialect translation — pure logic, no IO). `nodejs-store` (npm) and [`py-store`](https://github.com/coenddt/py-store) (pip `storepy`) are thin hosts in front of it: they own driver IO, callbacks and placeholder substitution. Same schemas, same GQL, same semantics in Node and Python.

## Related projects

- [`py-store`](https://github.com/coenddt/py-store) — the Python asyncio twin (pip `storepy`, `from py_store import init, store`).
- [`rust-store`](https://github.com/coenddt/rust-store) — the shared Rust core and its `rust-store-node` / `rust-store-py` bindings.
- `text-to-query` — a companion skill that turns natural-language questions into GQL + params for this data layer.

## License

[MIT](LICENSE)
