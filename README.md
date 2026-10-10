# nodejs-store

**One data layer for MongoDB, MySQL, SQLite, PostgreSQL and local disk — define models as pure JSON, query them with a MongoDB-style GQL tree syntax, and get role-based access control, computed columns and soft-delete out of the box.**

![npm version](https://img.shields.io/npm/v/nodejs-store)
![license](https://img.shields.io/npm/l/nodejs-store)
![node](https://img.shields.io/node/v/nodejs-store)
![backends](https://img.shields.io/badge/backends-MongoDB%20%7C%20MySQL%20%7C%20SQLite%20%7C%20PostgreSQL%20%7C%20Local-blue)
![query dialect](https://img.shields.io/badge/query%20dialect-GQL%20(MongoDB--flavoured)-green)

`nodejs-store` lets a Node.js service talk to MongoDB (native aggregation), MySQL, PostgreSQL, SQLite and local disk through a **single schema definition and a single query dialect**. Nested relations compile to **one native query per backend** — you never hand-write `$lookup` or raw SQL.

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
- [Triggers](#triggers)
- [Transactional capabilities](#transactional-capabilities)
- [FAQ](#faq)
- [Related projects](#related-projects)
- [Framework usage contract](#framework-usage-contract)

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
- **Multi-tenant SaaS.** One schema definition, N tenants: locate a schema by `(source, database, schema, collection)` and re-target any query or write at execution time with a `{ source, database, schema }` override.

Typical concrete scenarios (see [`doc/use-cases/`](doc/use-cases/) for full walkthroughs):

| Scenario | Why nodejs-store fits |
| --- | --- |
| Multi-tenant SaaS with per-tenant schema/database | `database` per tenant + runtime route override, one schema |
| Admin dashboard / internal tool | Schema-driven CRUD, soft-delete, computed columns, RBAC |
| MongoDB today, PostgreSQL tomorrow | Same GQL + same schema, only the datasource changes |
| AI data-QA / text-to-query agent | Plan-only `buildPipeline`, deterministic command JSON, feedback events |
| Mixed SQL + Mongo in one product | Cross-source queries with native SQL pushdown and Mongo in-memory federation |
| Audit-friendly CRUD | Every schema auto-gets a `<Model>Deleted` archive table/collection |

## When not to use it

Being explicit about the boundary saves you time:

- **You want a full ORM with a migration engine.** `nodejs-store` is a *data layer*, not a migration tool. It can **read** a SQL backend's physical structure (`syncSchema` → introspection) but it never writes DDL back. Pair it with your migration tool of choice. There is an optional `generateDdl()` that renders `CREATE TABLE` text from your registered schemas — pure text, it never connects to or writes to the database.
- **You need a type-safe generated client.** Schemas are runtime JSON, not TypeScript types. You get flexibility and cross-language parity (same schema runs in Node and Python), not compile-time type inference.
- **You only ever use one database and rarely join.** A plain driver (or a single-database ODM/ORM) will be simpler.
- **You need raw aggregation escape hatches.** `$pipeline` passthrough and `store.aggregate()` were deliberately removed. Use `$condition` / `$group` / `$having` / relations; anything that cannot be safely translated fails **explicitly** rather than silently.
- **You are on SQLite in a high-concurrency hot path.** The SQLite executor uses the synchronous `better-sqlite3` driver by design — calls block the event loop. Prefer MySQL / PostgreSQL / MongoDB there, or isolate SQLite in its own process.

## How it compares

General positioning, not a benchmark — always verify against each tool's current docs.

| | nodejs-store | Mongoose | Prisma | TypeORM / Sequelize | Drizzle |
| --- | --- | --- | --- | --- | --- |
| Primary shape | JSON schema + GQL data layer | ODM (MongoDB) | Schema DSL + generated client | Decorator/entity ORM | TypeScript SQL builder |
| Backends | MongoDB, MySQL, SQLite, PostgreSQL, local | MongoDB | PostgreSQL, MySQL, SQLite, SQL Server, MongoDB, CockroachDB | MySQL, PostgreSQL, SQLite, MSSQL, Oracle (+ MongoDB) | PostgreSQL, MySQL, SQLite, … |
| One query dialect across Mongo **and** SQL | ✅ (MongoDB-flavoured GQL) | ➖ (Mongo only) | ➖ (one client per provider) | ⚠️ (Mongo model differs from SQL entities) | ➖ (SQL only) |
| Nested relation reads in one query | ✅ declarative relations → `$lookup` / `JOIN` | ✅ `populate()` | ✅ `include` | ✅ relations | ⚠️ manual joins |
| Built-in role / field-level RBAC + owner injection | ✅ | ➖ | ➖ (via extensions) | ➖ | ➖ |
| Read-time computed columns (sync / async / relation-agg) | ✅ | ➖ (getters) | ➖ | ➖ | ➖ |
| Soft-delete archive table auto-provisioned | ✅ | ➖ | ➖ | ➖ | ➖ |
| Migration / DDL engine | ➖ (introspection read-only; optional `generateDdl` text) | ➖ | ✅ | ✅ | ✅ |
| Static type generation | ➖ (runtime JSON, cross-language parity) | ➖ | ✅ | ⚠️ (decorators + TS) | ✅ |
| Shared native core across Node & Python | ✅ (Rust `rust-store`) | ➖ | ➖ | ➖ | ➖ |

### How it differs from specific libraries

Positioning only, based on those projects' public documentation at the time of writing — verify against your own requirements.

- **vs Mongoose** — Mongoose is MongoDB-only. `nodejs-store` uses a similar MongoDB-style query syntax (`$gt`, `$or`, `$set`, `$inc`) but the same query also runs unchanged against MySQL, SQLite and PostgreSQL.
- **vs `mongoosql-core`** — the closest in spirit: it also runs Mongoose-style queries on MongoDB, PostgreSQL and MySQL. `nodejs-store` additionally targets SQLite, ships schema-level permissions (role/field whitelists plus `creator` owner-condition injection), read-time computed columns (`fn` / `asyncFn` / relation-`agg`), an auto-provisioned `<Model>Deleted` soft-delete archive, and shares one Rust engine with a Python host so Node.js and Python cannot drift apart.
- **vs `unsql`** — `unsql` generates SQL from plain JavaScript objects for MySQL, PostgreSQL and SQLite. It does not target MongoDB, and it is a query/CRUD helper rather than a schema-driven data layer with permissions and computed columns.
- **vs Prisma** — Prisma is a schema DSL plus generated client with a migration engine and compile-time types. `nodejs-store` is a runtime JSON schema with no migration engine (it only *reads* physical structure via introspection, and `generateDdl()` only *renders* `CREATE TABLE` text without touching the database) and no type generation — in exchange for one query dialect spanning a document store and three relational stores.
- **vs TypeORM / Sequelize / Drizzle** — Sequelize and Drizzle are SQL-only; TypeORM models MongoDB separately from its SQL entities. `nodejs-store` treats MongoDB as the primary dialect and compiles the same GQL to SQL for the other three backends.

Short version: use an ORM when you want **compile-time types and migrations**; use `nodejs-store` when you want **one runtime schema + one query dialect spanning MongoDB and SQL**, with RBAC and computed columns built in.

## Installation

```bash
npm install nodejs-store
```

Requires Node.js 18+ and one supported backend (MongoDB / MySQL / SQLite / PostgreSQL / local disk).

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
| local (local disk) | collections persisted as JSON files, evaluated directly by the core's local evaluator (no SQL, no driver); see [Local disk data source (local)](#local-disk-data-source-local) |

GQL tree queries compile to a single native query per backend (except the local source — commands are evaluated directly by the core's local evaluator) — never hand-write `$lookup` or raw SQL again.

### Local disk data source (local)

Zero external services, zero native DB engine: collections are persisted as JSON files and commands are evaluated directly inside the Rust core's local evaluator (semantics match the MongoDB driver).

```js
const { init, local } = require('nodejs-store');

await init({ default: local.connect({ dir: './data/store' }) });
```

- **Usage**: `local.connect({ dir })` returns a connection descriptor (`kind: 'local'`); pass it to `init()` / `setConnections()` like any Mongo/SQL connection.
- **On-disk format**: `<dir>/<physical collection>.json` (an array of documents); writes go through a `.tmp` temp file and an atomic `rename`.
- **Transactions**: snapshot isolation — during a transaction reads/writes hit an in-memory snapshot; `commit()` persists the whole directory, `rollback()` discards it. Atomic by construction.
- **Guardrails**: hard cap of 100,000 documents per collection (explicit error, never silent truncation); no indexes (sequential scan only) — declaring `schema.indexes` emits a `local_indexes_ignored` feedback event.
- **Concurrency limit**: single process only — in-process writes are serialized by a directory lock; cross-process concurrency is outside the v1 guarantee.

## Features

- **Pure JSON schemas, zero code** — a model is just an object: fields, relations, computes, indexes.
- **GQL tree queries → one native query** — nested relations resolve in a single query; never hand-write `$lookup` again.
- **Normalized aggregation** — root-level `$group` / `$having` and relation aggregate predicates (semi/anti-join) in the same GQL, pushed down to all five backends.
- **Read-time defaults & computed columns** — writes store only user data; reads fill defaults and run `fn` / `asyncFn` / relation-`agg` computes.
- **Smart mutation** — `mutation()` auto-detects upsert by `_id` + unique index and recursively fills relation children.
- **Soft-delete built in** — every schema auto-registers a `<Model>Deleted` archive collection/table; `remove()` archives before deleting.
- **Permission context** — `AsyncLocalStorage`-based roles (`super_admin`/`admin`/`guest`/`creator`...), schema/field-level read/write whitelists, automatic owner-condition injection.
- **Multi-datasource & multi-tenant** — locate a schema by `(source, database, schema, collection)`; re-target per request with a route override.
- **Async-first, Rust core** — built on the `mongodb` Node.js driver and a shared Rust core with SQL dialects.
- **Relation predicates in mutations** — filter `update` / `remove` by related-table fields, pushed down to all five backends (previously a silent no-op on MongoDB).
- **Autoincrement primary keys** — declare `_id` as `{ type: 'int', strategy: 'autoincrement' }` for database-assigned integer IDs, with explicit errors where autoincrement is impossible.
- **Index DDL** — `schema.indexes` compiles to real `CREATE [UNIQUE] INDEX` statements (per backend, byte-identical); the generator still only emits text.

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

### Transactions and raw SQL

```js
async function transfer() {
  const rows = await store.executeRaw(
    'default', 'SELECT * FROM accounts WHERE _id = ? FOR UPDATE', [accId]);
  await store.executeRaw(
    'default', 'UPDATE accounts SET balance = ? WHERE _id = ?', [newBalance, accId],
    true);
}

await store.transaction('default', transfer);
```

- `store.transaction(source, fn)` opens a transaction scope on one source: every `executeRaw` / CRUD call inside `fn` lands on that source's transaction connection, with `commit` / `rollback` as one unit (reuses the internal `runInTransaction`). Mongo sources are probed at runtime (replica set / sharded) and wrapped in a session transaction; on standalone or probe failure `fn` runs as-is and emits `mongo_transaction_unsupported` (`deployment: standalone|unknown`) — it never pretends to be atomic. Executors without `withTransaction` also run `fn` as-is and emit a `transaction_not_atomic` feedback event (degradation is allowed, silent pretence is not). A nested same-source transaction opens a savepoint (an inner failure rolls back only that scope); without savepoint primitives it degrades by joining the outer transaction and emits `nested_savepoint_unsupported`.
- `store.executeRaw(source, sql, params = null, isWrite = null)` runs raw SQL, compiled by the core `rawStmtCompile`. Two styles selected by the `params` type: **positional** (array/null) passes the SQL through as-is with native placeholders (`?` for MySQL / SQLite, `$1..$n` for PostgreSQL); **named** (object) compiles `:name` tokens in the SQL into dialect placeholders (same-name reuse, `::` casts / quotes / comments kept intact; missing or unused names throw `RawSqlError`). SQL sources only — a Mongo source throws `RawSqlError` (`store.RawSqlError`).
- When `isWrite` is omitted it is inferred from the SQL's first word (SELECT / WITH / EXPLAIN / SHOW / PRAGMA / TABLE count as reads, everything else as a write — defaulting to write is the safe direction); passing it explicitly overrides the inference. Returns `{ rows, affectedRows }`: rows for reads, the affected-row count for writes.
- `store.executeNative(source, collection, pipeline = [], options = null)` runs a native aggregation pipeline on a Mongo source (the Mongo counterpart of the SQL-side `executeRaw` escape hatch): `pipeline` is a native aggregation pipeline, `options` uses driver-native keys (`allowDiskUse` / `batchSize` / `hint` / `maxTimeMS`..., no host-side whitelist). Inside a transaction / session the session is injected automatically (owned by the transaction; `options.session` cannot override it); resolution always follows the read path, so `$merge` / `$out` write stages require you to open a transaction yourself. Mongo sources only — a SQL source throws `NativeCommandError` pointing to `executeRaw`; the MongoClient form requires a schema-declared database. Returns `{ rows }`.

### Session (Unit of Work)

```js
await store.session(async (s) => {
  await s.insert('Order', { ... });
  await s.update('Account', cond, { ... });
  await s.executeRaw('pg_main', 'SELECT ... FOR UPDATE', [1]);
});
```

- Inside a session, **every command on the same SQL source lands on one transaction connection**: the session commits once on exit, and rolls back as one unit on any exception.
- **Lazy transaction start**: a session with no commands never checks out a connection.
- **Cross-source writes fail closed**: if a session writes to ≥2 datasources, it rolls everything back and throws `NonAtomicWriteError` on exit (no distributed transaction — it never commits a half-done unit of work).
- Mongo sources are probed at runtime (replica set / sharded) and made transactional; on standalone or probe failure they run as-is (non-atomic) and emit one `mongo_transaction_unsupported` (`deployment: standalone|unknown`) feedback event.
- Sessions nest: an inner scope opens a savepoint (`SAVEPOINT sp_<n>`) on the outer transaction and, on exit, `RELEASE`s it (success) or `ROLLBACK TO`s and releases it (failure) — **an inner failure rolls back only the inner scope while the outer one continues**. When the transaction handle has no savepoint primitives, the nested scope degrades by joining the outer one and emits one `nested_savepoint_unsupported` feedback event.

### DDL generation

```js
let sql = store.generateDdl('mysql');                       // every registered model
sql     = store.generateDdl('postgres', ['Course', 'CourseDeleted']);
```

`store.generateDdl(backend, names)` maps one registered schema def to one `CREATE TABLE` — the inverse of `syncSchema()`, which only *reads*. The generator is **pure text**: it never connects to, or writes to, the database (iron rule 6 still holds).

- Only scalar fields become columns; `object` / `array` fields do not.
- Every table gets the `__present` sentinel column; `timestamps` models also get `createdAt` / `updatedAt`; the `<collection>_deleted` archive table is generated like any other registered def.
- No `CREATE INDEX` is emitted — SQL backends keep indexes as metadata only.
- MySQL `__present` is `VARCHAR(255)`; a schema whose present-token string would overflow emits a `ddlPresentOverflow` feedback event rather than failing silently.

## Multi-datasource connections

Every schema is located by `(source, database, schema, collection)` — `schema` applies to
PostgreSQL sources only; the location must be globally unique across the registry (duplicate
registration throws instead of silently mis-routing).

- `source` — connection key in `init({...})` (default `"default"`).
- `database` — the database inside the connection: Mongo db name, PG / MySQL database,
  SQLite attached db.
- `schema` — the PostgreSQL schema (PG sources only); `null` on every other backend.
- `collection` — table/collection name.

Definitions carry **no location fields**: a definition file declares no `source` /
`database` / `schema` (its `collection` is just the logical table/collection name). The
location is resolved from the definition directory layout plus the connection config:

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

```js
// Multiple Mongo servers: one source per connection
await init({ mongo_main: db, pg_a: { kind: 'postgres', exec } });

// Same MongoClient serving multiple databases: choose the database
await init({ cluster: client });
store.register({ name: 'User', collection: 'users', datasource: 'cluster', database: 'tenant_42', ... });

// SQL cross-database joins are pushed down natively ("db_a"."t" JOIN "db_b"."t");
// only Mongo cross-db relations fall back to in-memory federation.
```

**Multi-tenant route override** — one schema definition, N tenants. Any query/write accepts
a `{ source, database, schema }` override that re-targets commands at execution time
(permissions and computed columns still follow the structural schema):

```js
await store.query('User($condition:@c0){...}', params, { database: 'tenant_42' });
await store.insert('Order', data, { source: 'pg_cluster', database: 'tenant_7' });
```

**`routeOverride` is a trusted server-side parameter** — it carries no origin check, so
forwarding user-controlled input into it lets a caller re-target another tenant's
`source`/`database`/`schema` (CWE-639 authorization-bypass surface). Never pass raw request
data here.

Legacy single-db usage (`init(db)` + schema without `datasource`/`database`) is unchanged:
commands carry `source: 'default'`, `database: null`, `schema: null`.

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

<!-- SPEC:FNREF:BEGIN -->
### Computed columns: `fnRef` binding by composite name + canonical match

Computed columns live at the schema top level, `computes: { <key>: { type, fn | asyncFn | agg, fnRef?, depends?, read? } }` (`fn` / `asyncFn` / `agg` are mutually exclusive).

- The logical `fnRef` defaults to `<schema.name>.<computed-column key>` (generated, never hand-written); since `name` is globally unique, the `fnRef` is globally unique too.
- Host implementations bind by canonicalization: both the implementation's name in the host language style and the schema's logical `fnRef` are canonicalized to token sequences and compared. So Node's `orderAmountLabel` and Python's `order_amount_label` bind to the same logical computed column.
- Reusing one implementation across schemas: write an explicit shared name (e.g. `"fnRef": "common.moneyLabel"`); naming goes from required to optional.
- Every declared `fnRef` must have an implementation, otherwise the service fails to start with `ERR_FN_MISSING`.
<!-- SPEC:FNREF:END -->

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
| `database` | string | bind every merged def to this database |
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

### `store.ask(question, opts)`

AI ask — natural-language query (L1, read-only). The question plus a permission-filtered
schema summary (`store.describeForAi`) go to a pluggable LLM, which must answer with a
single `{"gql","params"}` JSON object; that query is then planned and executed inside the
hardened `text2query` profile (read-only, row/depth caps, route override disabled).
Structured failures are fed back to the LLM for retry (up to `maxRetries` rounds); on
exhaustion `AskExhausted` is thrown — ask never silently degrades and never returns
empty data for a failed query.

LLM output is treated as untrusted input: the guardrails (profile, context enforcement,
read-only) are hardcoded server-side and unreachable by the model.

| Option | Type | Meaning |
| --- | --- | --- |
| `llm` | `string \| Function` | required; registry name (see [`llm`](#llm-registry-llm) below) or an `async (messages) => string` client |
| `ctx` | object | required; server-side user context `{ userId, roles }`; a missing ctx is rejected (fail-secure) and the context never enters any LLM message |
| `maxRetries` | number (default `3`) | retries after a failed attempt (total attempts ≤ `1 + maxRetries`) |
| `knowledge` | string | override the system-prompt knowledge text (default: bundled `ask_knowledge.md`) |

Resolves to an `AskResult` `{ data, attempts, events }`. Each attempt is
`{ llmRaw, gql, params, rows }` — the successful round carries no `error` key; failed
rounds carry `{ error: { code, message } }` with `code` ∈ `badLlmOutput`,
`profileBlocked`, `permissionDenied`, `planError`. LLM client faults (`LlmError`:
network / HTTP status / empty content) propagate untouched — link failures fail
explicitly and are not retried.

```js
const { llm } = require('nodejs-store');

llm.registerLlm('deepseek', llm.makeOpenaiCompat({
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY,
}));

const result = await store.ask('Total amount of my last 10 orders?', {
  llm: 'deepseek',
  ctx: { userId: 'u1', roles: ['viewer'] },
});
console.log(result.data);                 // query result rows
console.log(result.attempts.at(-1).gql);  // the GQL the model produced
```

> The `text2query` profile is a process-wide core singleton: concurrent `ask()` calls in
> one process interleave. Serialize asks per process, or run each in its own worker.

### `store.describeForAi(ctx?)`

Permission-filtered schema summary for LLM prompts — a compact JSON array with one
`{ name, fields, relations, computes }` entry per model. Without a context only model
and field *names* are exposed (no types — probe-resistant). With a context, models,
fields, relations and computed columns are filtered by the caller's role
(`canRead` / `readableFields` / `readableRelations` / `readableComputes`), archive
tables (`*Deleted`) are dropped, and ops details (indexes / datasource / location)
never enter the prompt.

```js
const summary = store.describeForAi({ userId: 'u1', roles: ['viewer'] });
// [{ name: 'Order', fields: { _id: 'string', code: 'string', ... }, relations: { ... }, computes: { ... } }]
```

On native bindings that lack the `readableComputes` verdict, computed columns with a
`read` whitelist are conservatively excluded from the summary and an
`askSummaryComputeSkipped` feedback event is emitted — narrow the exposure, never
over-disclose.

### LLM registry (`llm`)

Pluggable LLM clients with no SDK bundled. A client is a single function
`async (messages: Array<{ role, content }>) => string`:

```js
const { llm } = require('nodejs-store');

llm.registerLlm('deepseek', client);  // duplicate name → throws
llm.getLlm('deepseek');               // unregistered name → throws

llm.makeOpenaiCompat({                // OpenAI-compatible factory (global fetch, zero deps);
  baseUrl, model, apiKey,             // covers DeepSeek / OpenAI / Moonshot / Ollama / ...
  jsonMode: true,                     // false → omit response_format (prompt convention + strict parse fallback)
  effort: 'low',                      // null → omit reasoning_effort
  maxTokens: 4096,
  timeoutMs: 90000,
});
```

Client faults throw `LlmError` with a structured `.detail` (`code` ∈ `llmNetworkError`,
`llmHttpError`, `llmEmptyContent`, `llmJsonPromptMissing`); `store.ask` propagates them
untouched.

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
- **Multi-tenant route override** — pass `{ source, database, schema }` as the last argument of any
  query/write, see [Multi-datasource connections](#multi-datasource-connections).

## Transaction boundary

| Scenario | Atomicity |
|---|---|
| Single-command API (`insert` / `insertMany` / `updateMany` / `upsert` / `remove` / `count` / `exists`) | Naturally atomic within one SQL source (a single statement); single documents are atomic on Mongo |
| `store.transaction(source, fn)` | Atomic within one SQL source: every command in the scope shares one connection and one transaction; nested same-source scopes use a savepoint (an inner failure rolls back only that scope) |
| `store.session(...)` | Atomic **across multiple calls** on one SQL source inside the session; cross-source writes are rejected explicitly (`NonAtomicWriteError`) |
| Cross-source multi-write without a session | Not atomic (no 2PC / Saga), executed datasource by datasource, and declares `nonAtomic` via the feedback channel (event `non_atomic_write`, with the sources) |
| Multi-step writes on Mongo | replica set / sharded: atomic on a single Mongo source (session transaction); standalone: non-atomic and explicitly declares `mongo_transaction_unsupported` |

- **Mongo sources**: made transactional inside a session according to the runtime probe; non-transactable ones (standalone / probe failure) run as-is and emit a `mongo_transaction_unsupported` feedback event (`deployment: standalone|unknown`) (degradation is allowed, silent pretence is not).
- **SQL executors without `openTransaction`**: commands run as-is inside a session and emit a `session_not_atomic` feedback event (degradation is allowed, silent pretence is not).
- **SQL executors without `withTransaction`**: commands run as-is inside a transaction scope (or the top-level atomic envelope) and emit a `transaction_not_atomic` feedback event (symmetric with `session_not_atomic`; degradation is allowed, silent pretence is not).
- **Archive idempotency**: `remove` archives with upsert-by-`_id` semantics, so a retry after partial failure no longer fails on duplicate `_id`.
- Read consistency: only multiple reads inside an explicit session share one transaction connection; reads outside a session do not open an extra transaction.
- **Cross-source writes (no session)**: a single write call touching ≥2 datasources **cannot be atomic**; it runs sequentially and emits one `non_atomic_write` feedback event (`code: nonAtomic`, with the source list) — degradation is allowed, silence is not. Converge writes onto a single source, or wrap them in `store.session()` (which fails closed on cross-source writes).

## Triggers

Declarative trigger chains on a schema: write events (`insert` / `update` / `remove`) are expanded by the Rust core at plan time into an ordered list of side-effect steps (`plan.triggers`) that the host runs in sequence inside the same atomic envelope as the source write. The declaration form (the `triggers` event keys plus the field table) and the placeholder grammar are defined by the "Triggers" section of the rust-store README; the core's expanded output is byte-for-byte identical across hosts (golden guard: `rust-store/fixtures/triggers/cases.json`).

**Callback wiring** (`src/crud/triggers.js`):

```js
store.setTriggerFn('grantPoints', async (args, ctx, { store }) => {
  await store.update('User', { _id: args.userId }, { $inc: { points: args.amount } });
});
store.assertTriggerFnsCovered(defns); // startup: a declared fnRef without an implementation ⇒ ERR_TRIGGER_FN_MISSING
```

**Execution semantics**:

- **Hit test** — an `update` event first checks that the `onFields` values actually changed (a structural deep compare, no-op suppression — an unchanged value does not fire) → then the `when` guard (`eq/ne/gt/gte/lt/lte/in/and/or/not`); `insert` has no `before` and skips the field-level check; `remove` uses the archived (pre-delete) document as root. System fields (`createdAt` / `updatedAt` / `deletedAt`) are excluded from the trigger probe projection, so their changes never fire.
- **Placeholders** — `{{root.*}}` (post-change value) / `{{before.*}}` (pre-change value) / `{{now}}` undergo whole-value substitution only; embedding a placeholder inside a string raises `ERR_TRIGGER_PLACEHOLDER` — no silent drift.
- **De-duplication** — within one top-level call, `(step.name, _id)` runs at most once.
- **Callbacks** — `impl(args, ctx, { store })`; `store.*` inside the callback hits the current transaction connection → the same transaction as the source write.
- **Scheduled (cron)** — the `schedule` event is enumerated by the host scheduler plugin (`src/scheduler/index.js`) and reuses the same trigger chain; only `{{now}}` is allowed as a placeholder.

**Boundaries**: single-source real transaction / a cross-source write declares `nonAtomic` / cross-source writes inside `store.session()` fail closed (see [Transaction boundary](#transaction-boundary)); **no cascading** (a trigger write does not fire further triggers); `updateMany` does not support field-level triggers (explicitly refused, no silent degradation); the command step `op: "upsert"` is a registration-time `Err`.

## Transactional capabilities

Capabilities aimed at transactional workloads (orders, inventory — write contention plus
complex reads). Full details, semantics and the explicit-error list:
**[doc/transaction-capabilities.md](doc/transaction-capabilities.md)** ·
[中文](doc/transaction-capabilities.zh-CN.md).

- **Relation predicates in mutations** — `updateMany('Inventory', { product: { category: 'meat' } }, { $inc: { stock: 10 } })`: condition keys matching a declared relation become a semi/anti-join, normalized into a preCommand (aggregate fetching `_id`s) plus `_id $in`.
- **`$group by` one-relation paths** — `by: ['product.category']` compiles to `$lookup`+`$unwind` (Mongo) / `LEFT JOIN` (SQL); `many` paths fail explicitly (fan-out breaks count semantics).
- **Autoincrement PKs** — `_id: { type: 'int', strategy: 'autoincrement' }`; PG/SQLite read back via `INSERT…RETURNING`, MySQL via insertId; MongoDB and `insertMany` fail explicitly with `AUTOINCREMENT_NOT_SUPPORTED` (no silent ObjectId substitution).
- **Index DDL** — `schema.indexes` (MongoDB shape) → `CREATE [UNIQUE] INDEX idx_<table>_<cols>` in `ddl.generate`, byte-identical across MySQL/PostgreSQL/SQLite.
- **Declarative migration** — `ddl.diffDefs(old, new)` + `ddl.generateMigration(backend, old, new)`: whitelist-only (add table/column/index, type widening), per-dialect SQL, pure functions; destructive changes fail with `MIGRATION_UNSUPPORTED`.

## Workflow orchestration (first batch)

Express "orchestration of multi-step data operations" as data: a workflow definition (defn) is pure
JSON isomorphic to a schema defn, and each run is persisted to the built-in schema `__workflowRun`
(queryable with plain GQL — zero new observability endpoints). Execution generalizes the existing
mutation step-sequence mechanism: linear steps + per-step `when` guards + fail-fast. The engine
lives in the host layer (`src/workflow.js`), core unchanged; aligned with
`nodejs-store/src/workflow.js` (byte-identical outputs guarded by parity anchor tests).

```python
from py_store import workflow

store.registerWorkflow({
    'name': 'placeOrder',
    'run': ['admin', 'ops'],              # three-tier whitelists read/write/run (run falls back to write)
    'steps': [
        {'op': 'query', 'as': 'inv',
         'gql': 'Inventory($condition:@c0){_id, stock}',
         'params': {'c0': {'productId': '{{input.productId}}', 'warehouse': '{{input.warehouse}}'}}},
        {'op': 'fail', 'when': {'exists': '{{inv._id}}', 'is': None}, 'message': '库存记录不存在'},
        {'op': 'fail', 'when': {'lt': '{{inv.stock}}', 'than': '{{input.qty}}'}, 'message': '库存不足'},
        {'op': 'mutation', 'model': 'Inventory',
         'data': {'_id': '{{inv._id}}', 'stock': '{{dec:{{inv.stock}},{{input.qty}}}}'}},
    ],
})

run = await store.runWorkflow('placeOrder', { productId: 'p1', warehouse: 'w1', qty: 30 })
# run['status'] ∈ succeeded | failed | rejected | drySucceeded | dryFailed
# Uniform contract: business failures never raise; the error lives in run['error']
# (set only on failure; always null on success — never `||`-masked downstream)
```

- **Step whitelist** (three kinds; anything else fails registration with `WORKFLOW_UNSUPPORTED`):
  `query` (result must be unique — >1 row is an explicit error), `mutation` (store.mutation /
  upsert), `fail` (explicit business assertion). Optional `when` guards (exists / is / eq / ne /
  lt / lte / gt / gte) record `skipped` explicitly — never silently skipped.
- **Placeholders**: `{{input.<path>}}`, `{{<as>.<path>}}` (forward references only),
  `{{dec:<a>,<b>}}`; full-string replacement keeps the value type. No placeholders inside gql
  (bind via params — injection safety); no array-index path segments.
- **Permissions**: three-tier role whitelists embedded in the defn (same RBAC semantics: admin /
  super_admin bypass, guest denied, internal bypass); runs inherit the caller's Context and every
  step goes through core permission checks — no superuser. `require_context(true)` rejects
  context-less runs (fail-secure wins over dry-run); rejected runs are persisted for audit.
- **Atomicity**: a single-source run is atomic across steps (outer `run_atomic` wraps the whole
  loop, inner mutations nest into it); multi-source / prescan-failed runs execute sequentially and
  emit feedback events (`workflow_non_atomic` / `workflow_prescan_failed`) — never silent. The run
  record (running → terminal) is committed outside the business transaction so failed runs stay
  queryable after rollback.
- **dry-run**: `store.runWorkflow(name, input, { dryRun: true })` — query steps execute for real (read-only
  safe); mutation / fail are recorded as `wouldRun` (`drySucceeded | dryFailed`).
- **Run persistence**: `__workflowRun` is bootstrapped on import (idempotent); SQL backends need a
  one-time `ddl.generate(backend, ['__workflowRun'])` (Mongo creates the collection on first write).
  Its `write` whitelist is explicitly empty (GQL tampering with run audit is rejected by R2).

### Explicitly not in the first batch (detected → error; boundaries shipped with the same weight as features)

| Not supported | Why | Escape hatch |
|---|---|---|
| Loops / parallel / sub-workflows / human approval | DAG & wait semantics explode; linear + `when` covers the first batch | orchestrate in host code via the store API |
| Auto compensation (Saga) / auto retry | Inverse-operation burden; steps have no automatic idempotency | inspect run records and handle explicitly |
| Per-step host callbacks | Arbitrary code breaks whitelist governance | schema computes (read) / host code (write) |
| Workflow defn persistence / hot reload | Depends on schema versioning (next on the roadmap) | defn stays code-side JSON + register, like schemas today |
| Timers / event triggers | Scheduling is a resident-IO concern, orthogonal to pure orchestration | call `runWorkflow` from the application layer |
| Placeholders inside gql / array-index paths | Injection surface / per-row iteration semantics | params binding / host-code orchestration |

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
Yes. Locate a schema by `(source, database, schema, collection)` and pass a `{ source, database, schema }` route override per request. Treat `routeOverride` as trusted server-side input only.

**Does it run migrations?**
No. `syncSchema()` only *reads* physical structure via introspection (introspect → merge overlay → register). Schema changes / DDL are your migration tool's job. If you want a starting point, `store.generateDdl(backend)` renders `CREATE TABLE` text from the registered schemas — but it is pure text generation: it never runs or writes DDL.

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

## Framework usage contract

- Definition layer (data): models / permissions / workflows / interfaces are always pure JSON — publishable, rollbackable, hot-reloadable.
- Callback layer (code): datasource IO, computed-column implementations, external calls, transactions — declared via `fnRef` and injected at startup; not serializable, must never be persisted.
- Observability layer: every degradation / interception / fallback event lands in `__feedback` (queryable via GQL) — never silent.

## License

[MIT](LICENSE)
