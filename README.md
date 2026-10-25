# nodejs-store

**One data layer for MongoDB, MySQL, SQLite, PostgreSQL and local disk — define models as pure JSON, query them with a MongoDB-style GQL tree syntax, and get role-based access control, computed columns and soft-delete out of the box.**

![npm version](https://img.shields.io/npm/v/nodejs-store)
![license](https://img.shields.io/npm/l/nodejs-store)
![node](https://img.shields.io/node/v/nodejs-store)
![backends](https://img.shields.io/badge/backends-MongoDB%20%7C%20MySQL%20%7C%20SQLite%20%7C%20PostgreSQL%20%7C%20Local-blue)
![query dialect](https://img.shields.io/badge/query%20dialect-GQL%20(MongoDB--flavoured)-green)

`nodejs-store` lets a Node.js service talk to MongoDB (native aggregation), MySQL, PostgreSQL, SQLite and local disk through a **single schema definition and a single query dialect**. Nested relations compile to **one native query per backend** — you never hand-write `$lookup` or raw SQL.

> Also looking for the Python version? See [`py-store`](https://github.com/coenddt/py-store) (pip `storepy`). Both are thin hosts over the shared Rust engine [`rust-store`](https://github.com/coenddt/rust-store).
>
> **Store family on Gitee:** [`rust-store`](https://gitee.com/coenddt/rust-store) (shared Rust core) · [`nodejs-store`](https://gitee.com/coenddt/nodejs-store) (this repo — Node.js host, npm `nodejs-store`) · [`py-store`](https://gitee.com/coenddt/py-store) (Python host, pip `storepy`)
>
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
- [Vector search](#vector-search)
- [Advanced API](#advanced-api)
- [Transactions](#transaction-boundary)
- [Triggers](#triggers)
- [Transactional capabilities](#transactional-capabilities)
- [Scenario examples](#scenario-examples)
- [Performance](#performance)
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

- **You want a full ORM with a migration engine.** `nodejs-store` is a *data layer*, not a full migration tool. It can **read** a SQL backend's physical structure (`syncSchema` → introspection) but it never invents DDL on its own. It does ship a whitelist migration **orchestrator** — `store.migrate()` diffs two def versions, renders per-dialect SQL and applies it transactionally with a `__schemaMigration` version trail (see "Schema migration (orchestrator)") — and an optional `generateDdl()` that renders `CREATE TABLE` text from your registered schemas (pure text, it never connects to the database by itself). Beyond the whitelist (add table/column/index, type widening), pair it with your migration tool of choice.
- **You need a type-safe generated client.** Schemas are runtime JSON, not TypeScript types. You get flexibility and cross-language parity (same schema runs in Node and Python), not compile-time type inference.
- **You only ever use one database and rarely join.** A plain driver (or a single-database ODM/ORM) will be simpler.
- **You need raw aggregation escape hatches.** `$pipeline` passthrough was deliberately removed; `store.aggregate()` exists only as a strictly **opt-in** alias (disabled by default). Use `$condition` / `$group` / `$having` / relations; anything that cannot be safely translated fails **explicitly** rather than silently.
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
| Migration / DDL engine | ➖ (introspection read-only; whitelist `migrate()` orchestrator; optional `generateDdl` text) | ➖ | ✅ | ✅ | ✅ |
| Static type generation | ➖ (runtime JSON, cross-language parity) | ➖ | ✅ | ⚠️ (decorators + TS) | ✅ |
| Shared native core across Node & Python | ✅ (Rust `rust-store`) | ➖ | ➖ | ➖ | ➖ |

### How it differs from specific libraries

Positioning only, based on those projects' public documentation at the time of writing — verify against your own requirements.

- **vs Mongoose** — Mongoose is MongoDB-only. `nodejs-store` uses a similar MongoDB-style query syntax (`$gt`, `$or`, `$set`, `$inc`) but the same query also runs unchanged against MySQL, SQLite and PostgreSQL.
- **vs `mongoosql-core`** — the closest in spirit: it also runs Mongoose-style queries on MongoDB, PostgreSQL and MySQL. `nodejs-store` additionally targets SQLite, ships schema-level permissions (role/field whitelists plus `creator` owner-condition injection), read-time computed columns (`fn` / `asyncFn` / relation-`agg`), an auto-provisioned `<Model>Deleted` soft-delete archive, and shares one Rust engine with a Python host so Node.js and Python cannot drift apart.
- **vs `unsql`** — `unsql` generates SQL from plain JavaScript objects for MySQL, PostgreSQL and SQLite. It does not target MongoDB, and it is a query/CRUD helper rather than a schema-driven data layer with permissions and computed columns.
- **vs Prisma** — Prisma is a schema DSL plus generated client with a migration engine and compile-time types. `nodejs-store` is a runtime JSON schema with no inline migration engine — introspection only *reads* physical structure, `generateDdl()` only *renders* text, and `migrate()` orchestrates whitelist-only changes (add column/index/table, widening) with a version trail — and no type generation — in exchange for one query dialect spanning a document store and three relational stores.
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
- Null vs missing is a deliberate three-state contract: `{ field: null }` matches an **explicit null only**; `{ field: { $eq: null } }` matches **null or missing**; `{ field: { $exists: false } }` matches **missing only**.

### Upgrading from 4.x to 5.0

> **Breaking:** user `$pipeline` passthrough was removed — a GQL containing `$pipeline` now fails at parse time (`ERR_GQL_PARSE:`) instead of being silently ignored.

- **Reserved field names are gone.** `type` / `read` / `write` / `fields` / `localField` / `foreignField` are valid field names in 5.0.0; on 4.8.0 registering them raised `ERR_NAME_CONFLICT`. Only `_id` and `_score` remain literal reserved names.
- **`store.aggregate()` did not exist in 4.8.0.** It is restored in 5.0.0 as a strictly opt-in escape hatch (see [Transactions and raw SQL](#transactions-and-raw-sql)): disabled by default (`ERR_NATIVE_AGGREGATE_DISABLED`), enabled with `init(conn, { allowNativeAggregate: true })`.
- **Null vs missing follows a three-state contract.** Audit the intended form in existing queries: use `{ $eq: null }` for "null or missing", a bare `null` for "explicit null only", and `{ $exists: false }` for "missing only".
- **`$group` accumulators are still `$count` / `$sum` / `$avg` / `$min` / `$max`.** `$sum: { $cond }`, `$addToSet` and `$last` fail explicitly; rewrite those queries or move the logic to the application layer.

## Aggregation

Normalized aggregation lives **inside GQL** — no separate query API and no raw pipeline on the normal path. Raw aggregation is reachable only through explicit escape hatches: `store.aggregate()` (opt-in), `executeNative()` and `executeRaw()`.

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

- Whitelisted operators: `$count` / `$sum` / `$avg` / `$min` / `$max`. This set is closed: `$sum: { $cond }`, `$addToSet` and `$last` are not supported and fail explicitly.
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
- `store.aggregate(schemaName, pipeline, options = null)` is the schema-name twin of `executeNative` (restored in 5.0.0; it does not exist in 4.8.0) — an **opt-in** escape hatch that resolves `schemaName → (datasource, collection)` and delegates to the exact same execution path (session injection and connection reuse included; no extra driver connection). Disabled by default: calls throw `ERR_NATIVE_AGGREGATE_DISABLED` until the service inits with `init(conn, { allowNativeAggregate: true })`. It injects **no permission filtering** and does **no computes re-hydration** — the caller owns both (same escape-hatch semantics as the old mongo-store `aggregate`). The pipeline is passed through unchecked: `$match` / `$group` / `$lookup` / `$facet` all work; `$merge` / `$out` are not blocked but require you to open a transaction yourself. Unknown schema names throw `ERR_AGGREGATE_SCHEMA`.

### Concurrency primitives

Declarative task-claiming and compare-and-swap on top of the same plan → Mongo-command pipeline — the patterns that previously required a raw-SQL escape hatch (`FOR UPDATE SKIP LOCKED` via `executeRaw`) now have first-class methods, so outbox dispatching and leader election no longer need bare SQL:

```js
const got = await store.claim('Job', { status: 'pending', runAt: { $lte: now } },
  { claimedBy: 'worker-1', status: 'claimed', leaseUntil: now + 30_000 },
  { limit: 10, sort: [['runAt', 1]] });   // returns the claimed rows (their latest values)

const { matched, modified } = await store.compareAndSet('Leader',
  { _id: 'leader-1', term: 7 },           // current-state guard: the CAS condition
  { term: 8, holder: 'node-a' });         // the write to apply when it matches

await store.renewLease('Leader',
  { _id: 'leader-1', holder: 'node-a' },  // ownership condition: only the holder renews
  { leaseUntil: now + 30_000 });
```

- `store.claim(schemaName, filter, update, { limit = 1, sort = null, routeOverride } = {})` atomically claims up to `limit` rows matching `filter` and applies `update` to exactly those rows in one transaction (`atomic_commands`: every command lands on the same connection, in order). Returns the claimed rows. PostgreSQL uses `SELECT … FOR UPDATE SKIP LOCKED` so concurrent claimers skip locked rows instead of blocking; SQLite compiles the same plan into a single `UPDATE … RETURNING`; **MySQL has no `SKIP LOCKED`-equivalent in one statement for this plan, so the core compiles it as two steps on one connection** (`SELECT _id … FOR UPDATE` → `UPDATE _id IN (…)`), still atomic within the transaction but contenders queue on the lock rather than skipping.
- `store.compareAndSet(schemaName, filter, update, { routeOverride } = {})` applies `update` only when `filter` still matches the current state; it returns `{ matched, modified }` (both counts). **MySQL matched semantics**: the core pre-reads the matching rows with a locking `SELECT` and drives the `UPDATE` by the returned primary keys, so `matched` is the number of pre-read rows — not MySQL's default "rows changed" count. `renewLease` is `compareAndSet` by another name: the lease-ownership condition (`holder` / `claimedBy`) is part of `filter`, supplied by the caller.
- Lease bookkeeping fields (`claimedBy` / `leaseUntil` / …) are **caller-owned schema fields**, not built-ins: declare them on the schema, and expiry/cleanup is a plain query on your side.
- SQL sources only. A Mongo source throws with code `concurrencyPrimitivesSqlOnly` — Mongo has no `SKIP LOCKED`-style claim primitive, and faking one with `findOneAndUpdate` loops would not be atomic under concurrency (explicit refusal, no silent degradation).

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
- Declared `schema.indexes` render as `CREATE [UNIQUE] INDEX idx_<table>_<cols>` (byte-identical across MySQL / PostgreSQL / SQLite). At runtime SQL backends still keep indexes as metadata — the store never executes DDL against the database.
- MySQL `__present` is `VARCHAR(255)`; a schema whose present-token string would overflow emits a `ddlPresentOverflow` feedback event rather than failing silently.

### Schema migration (orchestrator)

`store.migrate({ backend, source, defs, oldDefs, driver, tenant, env })` orchestrates the whitelist
migration physically: diff two def versions → per-dialect SQL (`generateMigration`) → execute in one
transaction per table → record a version row in the built-in `__schemaMigration` table.

```js
const r = await store.migrate({
  backend: 'sqlite', source: 'default',
  defs: { Note: noteV2 },        // {name: defn}, same shape as persistDef
  oldDefs: null,                 // null → introspect (needs `driver`: the native driver instance,
                                 //        same convention as syncSchema — the connection view does
                                 //        not expose it); or pass oldDefs explicitly to skip it
  driver: db,
});
// r = { applied: [{name, from, to, version}], skipped: [{name, reason}] }
```

- **Idempotent** — the latest `__schemaMigration` row for the same `(tenant, env, backend, name)`
  is hash-compared (SHA-1 of the stable-serialized defn) *before* diffing; an identical rerun is
  reported as `skipped: [{name, reason: 'unchanged'}]` and touches nothing.
- **Whitelist-only** — add table / add column / add index / type widening. Anything else throws
  `MigrationUnsupported` (a `MetaDefError` subclass) whose message carries a fixed two-step recipe:
  *"白名单外变更请分两版走：先加新列并回填，确认切换后再于下一版删除旧列"* — no auto-execution, no auto-rollback.
- **Atomic per table** — the SQL statements and the version row commit or roll back together; a
  mid-way failure leaves no orphan version row. A multi-table batch is *not* one cross-table
  transaction — reconcile by `applied` / `skipped` and re-run.
- **Diff runs in the physical namespace** — introspected keys are physical (`view_count`, snake_case
  on SQL backends) and physical names are not reversible, so the target defn is translated through
  the same single-point physical-name function before diffing; introspection-inferred granularity
  (e.g. SQLite `INTEGER` → `number`) is aligned so a re-run is never mis-read as a change. Type
  widening (`int→long` etc.) produces DDL on MySQL/PostgreSQL; on SQLite numeric columns have no
  physical difference, so it reports unchanged.

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
    bidders: { type: 'array', default: [] },              // array field — inline agg target
  },
  relations: {
    items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' },
  },
  computes: {
    total: { type: 'float', depends: ['amount'], fn: (d) => d.amount * 1.1 },
    itemCount: { type: 'int', agg: { $count: 'items' } },                 // relation agg
    biddersCount: { type: 'int', depends: ['bidders'], agg: { $size: 'bidders' } },
    maxBid: { type: 'float', depends: ['bidders'], agg: { $max: 'bidders.amount' } },
    bidderCount: { type: 'int', depends: ['bidders'], agg: { $countDistinct: 'bidders.bidderId' } },
  },
  indexes: [
    { keys: { status: 1 } },
    { keys: { code: 1 }, options: { unique: true } },
  ],
  read: ['editor', 'viewer'],        // optional schema-level role whitelists
  write: ['editor'],
  ownerKey: '_id',                   // optional ownership key for the `creator` pseudo-role; default 'createdBy'
}
```

Types: `string | int | long | float | double | boolean | array | object | date | any`.

Boundary rules worth knowing up front (all **fail explicitly**, never silently degrade):

- Filtering on array fields directly, on a whole object field, or on object dot-paths is rejected on every backend — model cross-entity semantics as `relations` instead.
- Relation predicates support **one level** of relation; paths like `orders.items.price` are rejected.
- An unreadable relation is an error, not a silent `false`.

### Inline array aggregation

An `agg` whose first path segment is a declared **array field** (not a relation) aggregates
over the document's own array — compiled into the same pipeline, no extra query phase:

| Operator | Path | Empty array / missing field |
|---|---|---|
| `$size` | the array field itself | `0` |
| `$sum` | `array.element` | `0` |
| `$avg` / `$max` / `$min` | `array.element` | `null` |
| `$countDistinct` | `array.element` | `0` — counts distinct non-null values |

Rules (violations fail at registration, never silently degrade):

- `depends` must include the first path segment field.
- One level of array element only: `bidders.amount` is valid; nesting further into arrays is rejected.
- `$count` stays relation-only — use `$size` for arrays.
- Available on MongoDB and the local (in-process) evaluator; SQL backends reject it explicitly.

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

Two logical names in one schema that canonicalize equal (`orderTotal` vs `order_total`) is an error `ERR_NAME_CONFLICT:` and the service does not start (never silently overwritten). The `fields` key space is fully open — no field name is reserved: contract keys (`type`, `default`, ...) live inside a field's definition object at a different level, so `fields: { type: { type: "string" } }` is valid. Literal reserved names are only `_id` (framework primary key) and `_score` (vector score column).
<!-- SPEC:NAMING-STYLE:END -->

<!-- SPEC:FNREF:BEGIN -->
### Computed columns: `fnRef` binding by composite name + canonical match

Computed columns live at the schema top level, `computes: { <key>: { type, fn | asyncFn | agg, fnRef?, depends?, read? } }` (`fn` / `asyncFn` / `agg` are mutually exclusive).

- The logical `fnRef` defaults to `<schema.name>.<computed-column key>` (generated, never hand-written); since `name` is globally unique, the `fnRef` is globally unique too.
- Host implementations bind by canonicalization: both the implementation's name in the host language style and the schema's logical `fnRef` are canonicalized to token sequences and compared. So Node's `orderAmountLabel` and Python's `order_amount_label` bind to the same logical computed column.
- Reusing one implementation across schemas: write an explicit shared name (e.g. `"fnRef": "common.moneyLabel"`); naming goes from required to optional.
- Every declared `fnRef` must have an implementation, otherwise the service fails to start with `ERR_FN_MISSING`.
<!-- SPEC:FNREF:END -->

## Vector search

Vectors are ordinary field values with a declared dimension and metric: you produce the
embedding, the store persists it, ranks by it and returns the score. No embedding model is
bundled.

### Schema declaration

```js
{
  name: 'Artwork',
  collection: 'artworks',
  fields: {
    title: { type: 'string', default: '' },
    caption: { type: 'string', default: '' },
    embedding: { type: 'vector', dim: 1024, metric: 'cosine' },  // 'cosine' | 'l2' | 'ip'
    embeddingHash: { type: 'string', default: '' },               // optional: reindex digest
  },
  indexes: [
    // Declares intent for a native approximate index (pgvector / Atlas Search).
    { keys: { embedding: 'vector' }, options: { metric: 'cosine', method: 'hnsw' } },
  ],
}
```

- `type: 'vector'` requires an integer `dim` and one of `metric: 'cosine' | 'l2' | 'ip'`;
  an invalid `dim` or `metric` fails at registration time, not at query time.
- Two different ceilings apply. **Storage** accepts up to 16000 dimensions. **Native indexing**
  is lower and backend-specific: pgvector HNSW / IVFFlat accepts up to 2000, MongoDB Atlas
  `vectorSearch` up to 4096. DDL generation rejects an index above the backend ceiling instead
  of silently skipping it.
- A vector index item is a single field: `{ keys: { <field>: 'vector' }, options: { ... } }`.
  Options are `metric`, `method` (`hnsw` | `ivfflat` | `flat`) and, for Atlas, `indexName`.
- Rows whose vector is `null` (including pre-migration rows) are simply not scored.

### Query operator

```js
const rows = await store.query(
  'Artwork($condition:@c){ _id, title, _score }',
  { c: { embedding: { $near: { $vector: [0.12, -0.03 /* ... */], $limit: 10 } } } },
);
```

- `$near` takes exactly three keys: `$vector` (required query vector), `$limit` (required
  TopK, positive integer) and `$minScore` (optional floor on `_score`). Any other key is rejected.
- `metric` is fixed by the field declaration; it is not a `$near` parameter. All metrics are
  normalized to "higher is more similar": `cosine` = cosine similarity, `ip` = inner product,
  `l2` = `1 / (1 + euclidean distance)`.
- Filters live next to the operator under the same `$condition`, e.g.
  `{ status: 'public', embedding: { $near: { ... } } }`.
- `_score` is opt-in: project it explicitly. A query without `$near` never returns a `_score` key.
- A vector whose length differs from `dim`, an all-zero query vector and a missing `$limit` are
  errors on every backend.

### Degradation semantics

`store.capabilities().vector` is the static capability report:
`{ supported, native, backend, metrics, maxDim }`.

- `native: true` means the target can run an approximate index (pgvector installed, or a declared
  Atlas Search vector index). `native` is a **static** property of the target; it never changes
  because one query had to fall back.
- Without a native index — MySQL, SQLite without `vec0`, self-hosted MongoDB without an Atlas
  Search index, and the embedded `local` / `memory` carriers — the query still runs as an
  **exact application-side scan**, and the host records a `vector_degraded` degradation event.
  Degradation is observable, never silent.
- PostgreSQL with a filter (anything besides `$near` under `$condition`) falls back to an exact
  scan: a pgvector approximate index is post-filtering and would break ACL / TopK correctness.
- Read degradation three ways: `store.degradedStatus()` inside `store.withDegradedScope(fn)`,
  the `vector_degraded` event on the feedback channel, and the `x-store-degraded` response header
  in `store-api`. Events carry `type / code / layer / backend / field / metric / message / hint`.

### Migration

- Existing tables are never altered implicitly. Add the column explicitly and re-register the
  field: `generateMigration(...)` emits `ALTER TABLE ... ADD COLUMN embedding vector(1024)`
  (a `DEFAULT` on a vector column is rejected; existing rows stay `null` until backfilled).
- Changing `dim` or `metric` of an existing field is not a supported migration — rebuild the
  column and its index on purpose.
- Backfill with
  `store.reindexVectors(schema, { field, hashField, sourceFields, embed })`: it pages by `_id`
  (anchored, no `skip`), digests `sourceFields` with `sha256`, and only re-embeds rows whose
  digest changed. `force: true` re-embeds everything; `dryRun: true` reports without calling
  `embed`. The vector and the digest are written in the same update.
- For incremental embedding, `store.registerVectorReindex(cfg)` installs the
  `<Schema>.vectorReindex` trigger so one row can be refreshed on demand.
- DDL generation only prints the index statement; the store never executes it. On big tables run
  it out of band (`CREATE INDEX CONCURRENTLY` on PostgreSQL).

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

## Resource storage (named credential pools)

Content-addressed blob storage beside the CRUD path: `resource.put / open / remove / url` fan bytes out to a provider registry (`local` directory, `s3`; register more via `registerProvider` / `store.registerResourceProvider`) while metadata lands in three plain CRUD schemas (`Resource` / `ResourceLocation` / `ResourceBinding`).

```python
const resource = require('nodejs-store/resource');

resource.configure({"store": store, "pools": {
    "sys": {"providers": [{"kind": "s3", "options": {...sys creds...}}]},
    "biz": {"providers": [{"kind": "s3", "options": {...biz creds...}}]},
}})
const out = await resource.put({ bytes: data, fileName: 'a.pdf', pool: 'biz' });
```

- **Named credential pools**: the `pools` config shape builds one isolated provider set per name — the same `kind` can appear in two pools with different credentials without overwriting each other. Every accessor takes `pool=...` (`put` / `open` / `remove` / `url`); `pool=None` means the default pool, and an unknown pool name raises `ValueError` (no silent fallback to the default pool). `resource.poolNames()` lists the configured pools.
- **Backward compatible**: the legacy `{"providers": [...]}` shape is exactly the default pool `"default"` — existing config keeps working unchanged. The two shapes are mutually exclusive: passing both `providers` and `pools` raises `ValueError` (no silent merge). `schema` / `fields` / `store` / `url` / `sign` stay global and cannot be set per pool (a per-pool occurrence raises).
- **`resource.createProvider(kind, options)` is a stable public API**: it returns `{"kind", "put", "get", "remove", "exists"}` (callables) or raises `ValueError` on an unknown kind. Services that previously reached into the internal factory and built their own cache (e.g. manager-side storage adapters) should migrate to this export plus the `pool=` parameter — the module-level `_pool` variable remains only as a default-pool alias and is no longer the supported surface.

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

## Scenario examples

Concrete, runnable scenarios that show where the data layer earns its place — each as
**Scenario → Code → Result → Why it wins**, argued against the hand-written alternative
(raw driver, hand-rolled SQL, an ORM).

### 1. Define a model as JSON, then query it — no ORM boilerplate

**Scenario.** You need a `Post` model with defaults, a derived label and an index. With an ORM
you write an entity/class, a migration and a generated client; here you write one JSON object and
start querying.

```js
const { init, store, local } = require('nodejs-store');

await init({ default: local.connect({ dir: './data' }) });  // or any Mongo / SQL connection

store.register({
  name: 'Post',
  collection: 'posts',
  idPrefix: 'PT',
  timestamps: true,
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
  },
  computes: {
    statusLabel: { type: 'string', depends: ['status'], fn: (d) => d.status.toUpperCase() },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

await store.insert('Post', { title: 'Hello' });
const items = await store.query(
  'Post($condition:@c0,$sort:@s1,$limit:@l1){ title, status, statusLabel }',
  { c0: { status: 'draft' }, s1: { createdAt: -1 }, l1: 20 },
);
```

**Result.**
```js
// items = [{ title: 'Hello', status: 'draft', statusLabel: 'DRAFT' }]
```
The stored document holds only the user data (`title`, `status`, plus framework `_id` / `createdAt`
/ `updatedAt`); `statusLabel` is computed at read time.

**Why it wins.** One JSON object replaces the entity/class + migration + generated client of a
typical ORM, and there is no `title` column or getter to declare twice: defaults are filled on read
and the computed column runs on read, so writes never carry derived data. Because the model is
data rather than code, it is also publishable, diffable and hot-reloadable.

### 2. Switch backends without touching business code

**Scenario.** You ship on MongoDB in development, but the production tenant wants PostgreSQL. You do
not want a second data-access layer.

```js
const { init, store } = require('nodejs-store');

// One schema, no backend-specific fields.
store.register({
  name: 'Order',
  collection: 'orders',
  idPrefix: 'OD',
  timestamps: true,
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    amount: { type: 'float', default: 0 },
  },
  computes: { total: { type: 'float', depends: ['amount'], fn: (d) => d.amount * 1.1 } },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

const gql = 'Order($condition:@c0,$sort:@s0){ _id, title, status, total }';
const params = { c0: { status: 'open' }, s0: { createdAt: -1 } };

// Development: MongoDB — one aggregation pipeline.
await init({ default: mongoDb });
const fromMongo = await store.query(gql, params);

// Production: PostgreSQL — only the datasource changes; the GQL is identical.
await init({ default: { kind: 'postgres', exec: pgPool } });
const fromPostgres = await store.query(gql, params);
```

**Result.** Both calls return the same document shape `[{ _id, title, status, total }]`; the Mongo
read is one aggregation pipeline (`$match` / `$sort`), the PostgreSQL read one parameterized
`SELECT ... ORDER BY`. See [`doc/use-cases/03`](doc/use-cases/03-mongodb-to-postgres-migration.md).

**Why it wins.** With Prisma / TypeORM you maintain two clients/entities; with a raw driver you
rewrite the query. Here the backend is just the `init()` argument — the schema carries no
backend-specific field and the same GQL string is planned and executed against either. You can run
both databases side by side during a phased cut-over, and
`store.syncSchema({ backend, driver, overlay })` reads an existing SQL structure into the same
registry so your permissions/computes merge on top.

### 3. One GQL read instead of an N+1 loop

**Scenario.** An endpoint lists a page of orders and, for each one, its items. The naive version
loops.

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
  );   // 20 parents → 21 round trips
}
```

Declare the relation once in the schema, ask for it in the same read:

```js
store.register({
  name: 'Order',
  collection: 'orders',
  timestamps: true,
  fields: { code: { type: 'string', default: '' }, status: { type: 'string', default: 'draft' } },
  relations: { items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' } },
});
store.register({
  name: 'OrderItem',
  collection: 'order_items',
  fields: { orderId: { type: 'string' }, sku: { type: 'string', default: '' }, qty: { type: 'int', default: 1 } },
});

const orders = await store.query(
  'Order($condition:@c0,$sort:@s0){ _id, code, items($sort:@s1,$limit:@l1){ sku, qty } }',
  { c0: { status: 'open' }, s0: { createdAt: -1 }, s1: { qty: -1 }, l1: 5 },
);
```

**Result.** One call returns nested documents:
```js
// orders = [{ _id, code, items: [{ sku, qty }, ...] }, ...]
```
On MongoDB this is one `aggregate()` (`$lookup` with a per-parent `$sort`/`$limit`); on SQL it is one
`SELECT` with a `LEFT JOIN` applying `ROW_NUMBER() OVER (PARTITION BY "orderId" ORDER BY "qty" DESC) <= 5`.

**Why it wins.** The child query is declared once (`relations`) and resolved as part of the parent
read, so it cannot drift from the parent query and there is nothing to hand-write. Both levels share
the same `$condition`/`$sort`/`$skip`/`$limit` semantics, and permissions/computed columns resolve
per level. The number of executions is fixed, independent of page size — no N+1. (A root `$skip`/
`$limit` alongside a relation uses a bounded two-phase shape — two executions, still not N+1.)

### 4. Row-level access: different roles see different rows

**Scenario.** Editors should only see and edit courses they created; admins see everything; guests
can never write.

```js
const { store, PermissionError } = require('nodejs-store');

store.register({
  name: 'Course',
  collection: 'courses',
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    createdBy: { type: 'string' },
  },
  read: ['admin', 'editor', 'creator'],
  write: ['admin', 'editor', 'creator'],
});

// Once per request (middleware layer).
store.setContext({ userId: req.user.id, roles: req.user.roles });

// editor with userId 'u1':
const mine = await store.query('Course($condition:@c0){ _id, title, status }', { c0: {} });
// → the owner condition { createdBy: 'u1' } is injected automatically
```

**Result.** Because the schema grants `creator`, queries get a `createdBy` condition injected, so an
editor sees only their own rows; `update` / `remove` on a row they do not own throws `PermissionError`
(`status = 403`). `guest` writes are refused outright, and `admin` / `super_admin` bypass the whitelists.

**Why it wins.** Row-level ownership is a schema declaration (`creator` in the `read`/`write` lists)
plus one context set per request — there is no per-handler `WHERE createdBy = ?` to remember or forget
and no per-endpoint `if (user.role)` ladder. The `AsyncLocalStorage`-based context flows through nested
calls, so any query issued inside the request (even from a helper) gets the same owner injection.
Denied access is a typed `PermissionError` (map it to HTTP 403), not a silent empty result.

### 5. Computed columns you write once and read anywhere

**Scenario.** The UI needs a course's lesson count and a marked-up revenue, but you do not want to
store derived values or recompute them in every endpoint.

```js
store.register({
  name: 'Course',
  collection: 'courses',
  fields: { price: { type: 'float', default: 0 }, status: { type: 'string', default: 'draft' } },
  relations: { lessons: { model: 'Lesson', type: 'many', localField: '_id', foreignField: 'courseId' } },
  computes: {
    revenue: { type: 'float', depends: ['price'], fn: (d) => d.price * 1.2 },   // scalar fn
    lessonCount: { type: 'int', agg: { $count: 'lessons' } },                  // relation agg
  },
});

const rows = await store.query('Course($condition:@c0){ _id, price, revenue, lessonCount }', { c0: {} });
```

**Result.**
```js
// rows = [{ _id, price: 100, revenue: 120, lessonCount: 7 }, ...]
```
`lessonCount` is `0` for a course with no lessons; only `price` / `status` are stored.

**Why it wins.** Declared once in the schema, `revenue` / `lessonCount` are requestable by name from
any GQL and reused across endpoints — no per-endpoint recomputation, no denormalized column to keep
in sync. The scalar `fn` runs at read time from its `depends`; the relation `agg` rolls the related
rows up inside the same query without fanning the parent out. Writes stay clean because derived
values are never persisted. Implementations bind by canonical `fnRef`, so a host function and the
schema agree without hand-written names (see the `fnRef` note in
[Schema reference](#schema-reference)).

### 6. Aggregation instead of hand-written SQL reports

**Scenario.** A dashboard needs "number of courses and total price per status, only statuses with
more than one course, highest total first".

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

**Result.**
```js
// rows = [{ status: 'published', n: 12, total: 4800 }, ...]
```

**Why it wins.** Normalized aggregation lives inside GQL — no raw pipeline on the normal path
(raw aggregation is only the opt-in `store.aggregate()` / `executeNative()` / `executeRaw()`
escape hatch), no per-dialect report SQL. The same query is pushed down to all five backends (MongoDB
aggregation stages / SQL `GROUP BY ... HAVING`), with a fixed execution order (`$condition` →
`$group` → `$having` → `$sort` → `$skip`/`$limit` → projection) and a whitelisted operator set
(`$count` / `$sum` / `$avg` / `$min` / `$max`). To filter parents by an aggregate over a relation
("products with more than 3 orders") use a relation aggregate predicate — a semi/anti-join that
compiles to `EXISTS`/`NOT EXISTS` on SQL and `$lookup`+`$match` on MongoDB without fanning out:

```js
await store.query('Product($condition:@c0){ _id, name }', {
  c0: { $and: [{ status: 'onSale' }, { orders: { $count: { $gt: 3 } } }] },
});
```

### 7. Ask a question in natural language — `store.ask` + `describeForAi`

**Scenario.** Support staff want to ask "Total amount of my last 10 orders?" without a query builder.

```js
const { llm, store } = require('nodejs-store');

llm.registerLlm('deepseek', llm.makeOpenaiCompat({
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: process.env.DEEPSEEK_API_KEY,
}));

const result = await store.ask('Total amount of my last 10 orders?', {
  llm: 'deepseek',
  ctx: { userId: 'u1', roles: ['viewer'] },   // server-side context; required
});
console.log(result.data);                 // query result rows
console.log(result.attempts.at(-1).gql);  // the GQL the model produced
```

**Result.** `result` is an `AskResult` `{ data, attempts, events }`; `data` holds the rows and
`attempts.at(-1)` holds `{ llmRaw, gql, params, rows }`. If the model cannot produce a valid,
permitted query within `maxRetries` rounds, `store.ask` throws `AskExhausted` (carrying
`.attempts` / `.events`) rather than returning empty data.

**Why it wins.** `describeForAi(ctx)` feeds the model a permission-filtered schema summary — a
`viewer` never sees the models/fields it cannot read, archive tables are dropped, and ops details
(indexes / datasource / location) never enter the prompt. The guardrails (read-only `text2query`
profile, context enforcement, row/depth caps, route override disabled) are hardcoded server-side and
unreachable from the model — LLM output is treated as untrusted input. A failed round is fed back
structurally and retried, so a bad generation is never silently turned into an empty result set.
Compare this with hand-rolling a prompt, a validator and a read-only SQL guard per endpoint.

### 8. A hermetic disk source for tests

**Scenario.** You want the full GQL / relations / aggregation semantics in unit tests with no running
database.

```js
const { init, local, store } = require('nodejs-store');

await init({ default: local.connect({ dir: './.tmp/store-test' }) });

store.register({ name: 'Post', collection: 'posts', fields: { title: { type: 'string', default: '' } } });
await store.insert('Post', { title: 'a' });
const rows = await store.query('Post{ _id, title }', {});
```

**Result.** Each collection is a JSON file under `dir` (e.g. `./.tmp/store-test/posts.json`); reads
return the same document shape as any backend and the same GQL runs unchanged — no server, no native
DB engine.

**Why it wins.** The `local` source is a real backend among the five, so tests exercise the actual
core semantics (relations, `$group`, permissions) without provisioning MongoDB/PostgreSQL, and the
same test file runs against a real backend by swapping only `init()`. Its guardrails are explicit: a
hard cap of 100,000 documents per collection (never silent truncation), single process only, and
declaring `indexes` emits a `local_indexes_ignored` feedback event (it is a sequential-scan store).

### 9. Orchestrate a multi-step business action as a workflow

**Scenario.** "Place an order" is a multi-step action — look up inventory, assert it exists and is
sufficient, then decrement it — and business failures must not throw.

```js
store.registerWorkflow({
  name: 'placeOrder',
  run: ['admin', 'ops'],
  steps: [
    { op: 'query', as: 'inv',
      gql: 'Inventory($condition:@c0){ _id, stock }',
      params: { c0: { productId: '{{input.productId}}', warehouse: '{{input.warehouse}}' } } },
    { op: 'fail', when: { exists: '{{inv._id}}', is: null }, message: '库存记录不存在' },
    { op: 'fail', when: { lt: '{{inv.stock}}', than: '{{input.qty}}' }, message: '库存不足' },
    { op: 'mutation', model: 'Inventory',
      data: { _id: '{{inv._id}}', stock: '{{dec:{{inv.stock}},{{input.qty}}}}' } },
  ],
});

const run = await store.runWorkflow('placeOrder', { productId: 'p1', warehouse: 'w1', qty: 30 });
```

**Result.**
```js
// run = { _id, workflow: 'placeOrder', status: 'succeeded' | 'failed' | 'rejected', steps, error, stepIndex, ... }
```
A business failure is expressed as `run.status === 'failed'` with a human-readable `run.error` and the
failing `stepIndex` — it is not thrown. On a single source the whole step loop is atomic, and the run
record is persisted to the built-in `__workflowRun` schema, queryable with plain GQL.

**Why it wins.** The multi-step action is pure JSON, isomorphic to a schema defn — publishable,
versionable and auditable rather than a long procedural handler. Placeholders (`{{input.*}}`,
`{{<as>.*}}`, `{{dec:a,b}}`) keep injection out of gql (params are bound, not string-built), `when`
guards record `skipped` explicitly (never silently skipped), and the three-tier `read`/`write`/`run`
whitelists reuse the same RBAC semantics. `store.runWorkflow(name, input, { dryRun: true })` runs
queries for real but records mutations/failures as `wouldRun`. What is deliberately out of scope
(loops, human approval, auto-retry) fails registration with `WORKFLOW_UNSUPPORTED` rather than
silently degrading.

### 10. Fail-secure at the request layer

**Scenario.** An internal API must never serve a request that forgot to set the user context — a
missing context should fail, not silently pass every permission check.

```js
store.setRequireContext(true);

// Every query/write without a context now throws:
await store.query('Post{ _id, title }', {});
// → throws `ERR_NO_CONTEXT:...`

// Trusted internal jobs declare themselves explicitly:
await store.runAsInternal(() => store.remove('Post', { _id: pid }));
```

To flip every security switch at once, use the single entry point:
```js
store.secureMode({ adminRoles: ['internal'] });
// turns on: context required + unconfigured whitelist closed + definition-registration gate
```

**Result.** A context-less request fails fast with `ERR_NO_CONTEXT:...`; `runAsInternal` marks the
call `{ internal: true }` (semantically distinct from a missing context) and always passes.
`store.secureMode()` returns `{ secure: true }`; `store.relaxMode()` restores the default fail-open
(for local scripts/tests only).

**Why it wins.** "No context" has two meanings — a system call and a caller that forgot the context.
Default fail-open would silently treat the second as the first and pass every check; one
`setRequireContext(true)` (or `secureMode`) makes the distinction explicit and fail-closed. There is
no per-handler guard to remember, because enforcement lives in the data layer, at the single chokepoint
every query/write goes through — and internal jobs stay possible via an explicit `runAsInternal`.

### 11. One store over MongoDB + MySQL — cross-source relations

**Scenario.** Users live in MongoDB, their orders in MySQL (different teams, different lifecycles).
The API needs "user with their orders" in one call.

```js
const { init, store, executors } = require('nodejs-store');

store.register({
  name: 'User', collection: 'users', datasource: 'mongo_main', timestamps: true,
  fields: { name: { type: 'string', default: '' } },
  relations: { orders: { model: 'Order', type: 'many', localField: '_id', foreignField: 'userId' } },
});
store.register({
  name: 'Order', collection: 'orders', datasource: 'mysql_main', timestamps: true,
  fields: {
    userId: { type: 'string' },
    code: { type: 'string', default: '' },
    amount: { type: 'float', default: 0 },
  },
});

await init({
  mongo_main: mongoDb,                                    // MongoClient().db() instance
  mysql_main: executors.createConnection('mysql', pool),  // mysql2/promise pool
});

const rows = await store.queryFederated(
  'User($condition:@c0){ _id, name, orders{ code, amount } }',
  { c0: {} },
);
```

**Result.** One call returns the joined shape:
```js
// rows = [{ _id, name, orders: [{ code, amount }, ...] }, ...]
```
Each source is fetched with its own native query (Mongo aggregation / MySQL SELECT) and joined in
memory; SQL↔SQL cross-database relations push down natively instead (`"db_a"."t" JOIN "db_b"."t"`).

**Why it wins.** A cross-source relation is declared exactly like a same-source one — the
hand-written alternative is two drivers plus a manual in-JS join (and the N+1 it tends to grow).
The boundary is declared too: a cross-source *write* without a session cannot be atomic, so it runs
sequentially and emits a `non_atomic_write` feedback event rather than pretending
(see [Transaction boundary](#transaction-boundary)).

### 12. Money transfer: transactions + raw SQL in the same scope

**Scenario.** Debit one account and credit another. Both must commit or neither, and the debit read
must lock the row.

```js
const { init, store, executors } = require('nodejs-store');
await init({ default: executors.createConnection('mysql', pool) });

await store.transaction('default', async () => {
  const { rows } = await store.executeRaw(
    'default', 'SELECT balance FROM account WHERE _id = :id FOR UPDATE', { id: 'acc_a' });
  if (!rows.length || rows[0].balance < 100) throw new Error('insufficient funds');
  await store.executeRaw(
    'default', 'UPDATE account SET balance = balance - :amt WHERE _id = :id', { amt: 100, id: 'acc_a' });
  await store.executeRaw(
    'default', 'UPDATE account SET balance = balance + :amt WHERE _id = :id', { amt: 100, id: 'acc_b' });
});
```

**Result.** All three statements land on one transaction connection — commit on normal exit,
rollback on the thrown business error. Named `:name` params compile to each dialect's native
placeholders (`?` / `$1..$n`), same-name reuse included, so the SQL string is never hand-concatenated.

**Why it wins.** The raw-SQL escape hatch does not drop you out of the transaction: `executeRaw`
and CRUD calls inside `transaction(source, fn)` share the same connection, so a `FOR UPDATE` lock
mixes freely with schema-driven writes. Degradations are declared, never faked: Mongo standalone
emits `mongo_transaction_unsupported`, executors without `withTransaction` emit
`transaction_not_atomic`, and nested same-source scopes open savepoints (an inner failure rolls back
only that scope). With a raw driver you thread a connection object through every helper by hand.

### 13. Session (Unit of Work): many writes, one exit

**Scenario.** Placing an order writes three things — the order, the inventory decrement, the ledger
bump. They form one unit of work; partial success is a bug.

```js
await store.session(async (s) => {
  await s.insert('Order', { code: 'A1', userId: 'u1', amount: 100 });
  await s.update('Inventory', { productId: 'p1', warehouse: 'w1' }, { $inc: { stock: -1 } });
  await s.executeRaw('default', 'UPDATE ledger SET ops = ops + 1', null, true);
});
// any throw above → the whole session rolls back; nothing commits half-done
```

**Result.** Every command in the callback lands on one transaction connection of that source and
commits once at exit. A session that writes to ≥2 datasources fails closed — everything rolls back
and `NonAtomicWriteError` is thrown on exit (no distributed transaction, no half-done unit).

**Why it wins.** The unit of work is ambient: helpers called inside the callback join the same
transaction without a connection object being passed around (the same context mechanism the
permission layer uses). Lazy transaction start means a session with no commands never checks out a
connection; nested sessions open savepoints, so an inner failure rolls back only the inner scope
while the outer continues. The hand-rolled version is "remember to pass `conn` into every function" —
the version that forgets one helper is how partial writes ship.

### 14. DDL from schemas: a starting point for your migration tool

**Scenario.** Models are defined as JSON; you want the matching `CREATE TABLE` text to hand to your
migration tool — or to spin up the same tables in a test container — without giving the library
write access to the database.

```js
store.register({
  name: 'Course', collection: 'courses', idPrefix: 'c_', timestamps: true,
  fields: {
    _id: { type: 'string' },
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    price: { type: 'float', default: 0 },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
});

const text  = store.generateDdl('sqlite');              // every registered model
const mysql = store.generateDdl('mysql', ['Course']);   // just one
```

**Result.** Pure text, one dialect per call. For SQLite:
```sql
CREATE TABLE "courses" (
  "_id" TEXT PRIMARY KEY,
  "title" TEXT,
  "status" TEXT,
  "price" REAL,
  "created_at" INTEGER,
  "updated_at" INTEGER,
  "__present" TEXT
);

CREATE INDEX "idx_courses_status_created_at" ON "courses" ("status" ASC, "created_at" DESC)
```

**Why it wins.** `generateDdl(backend, names)` is the inverse of `syncSchema()`: one registered def
→ one `CREATE TABLE` (+ `CREATE INDEX` for declared indexes), rendered for mysql / postgres / sqlite.
It never connects to or writes to the database — the text is yours to review, version and run with
the migration tool of your choice. Declare `_id` explicitly (plus `idPrefix` if the store mints ids)
— SQL rendering needs it; the `<Model>Deleted` archive tables render like any other registered def.

### 15. Declarative triggers as audit

**Scenario.** Every status change and every delete on `Order` must be audited — in the same
transaction as the write itself, with no per-handler calls to remember.

```js
store.register({
  name: 'Order', collection: 'orders', idPrefix: 'o_', timestamps: false,
  fields: { amount: { type: 'number' }, status: { type: 'string', default: 'draft' } },
  triggers: {
    update: [
      { name: 'audit_status', onFields: ['status'], into: 'AuditLog', op: 'insert',
        data: { _id: '{{now}}', kind: 'status', ref: '{{root._id}}',
                prev: '{{before.status}}', next: '{{root.status}}' } },
    ],
    remove: [
      { name: 'audit_remove', into: 'AuditLog', op: 'insert',
        data: { _id: '{{now}}', kind: 'remove', ref: '{{before._id}}' } },
    ],
  },
});
store.register({
  name: 'AuditLog', collection: 'audit_log', idPrefix: 'a_', timestamps: false,
  fields: { kind: { type: 'string' }, ref: { type: 'string' },
            prev: { type: 'string' }, next: { type: 'string' } },
});
```

**Result.** `store.update('Order', { _id }, { status: 'paid' })` plans the write and its trigger
steps together, and the host runs them in the same atomic envelope: an `AuditLog` row
`{ kind: 'status', ref: <orderId>, prev: 'draft', next: 'paid' }` is inserted — or nothing is, if
the write itself fails.

**Why it wins.** The audit is data declared next to the model: `onFields` deep-compares so an
unchanged value never fires; `{{before.*}}` / `{{root.*}}` / `{{now}}` substitute whole values only
(embedding one inside a string raises `ERR_TRIGGER_PLACEHOLDER`); the trigger write shares the
transaction with the source write, so "changed but not audited" cannot happen. Imperative cases use
callback triggers (`fnRef` + `store.setTriggerFn`, with `assertTriggerFnsCovered` failing startup if
an implementation is missing). No cascading, and `updateMany` explicitly refuses field-level
triggers — boundaries fail loudly, not silently.

### 16. Soft delete with a queryable archive

**Scenario.** "Delete" must be undoable and auditable: the row leaves the main table but stays
queryable for the recycle-bin endpoint and the audit export.

```js
store.register({
  name: 'Course', collection: 'courses', idPrefix: 'c_', timestamps: true,
  fields: { title: { type: 'string', default: '' }, price: { type: 'float', default: 0 } },
});

const r = await store.remove('Course', { _id: 'c_001' });
// r = { deletedCount: 1, archivedCount: 1 }  — the row moved to courses_deleted (+ deletedAt)

// The archive is a first-class schema: plain GQL, same semantics as any model.
const tombstones = await store.query(
  'CourseDeleted($condition:@c0,$sort:@s0){ _id, title, price, deletedAt }',
  { c0: {}, s0: { deletedAt: -1 } },
);
```

**Result.** `remove()` archives the matched documents into the auto-provisioned `<Model>Deleted`
table/collection (adding `deletedAt`) and then deletes them. Re-creating the same `_id` later does
not collide — the archive write is upsert-by-`_id`.

**Why it wins.** Every model gets the same audit-friendly delete for free: there is no per-model
"archive table + copy-on-delete trigger" pair to design and no code path that forgets to archive.
The recycle bin is one GQL query over a real schema. And `remove` with an empty condition is
rejected outright, so nobody deletes a whole table by accident.

**Opting out.** A schema that must not keep an archive sets `archive: false` at registration — the
`<Model>Deleted` archive def is then never derived (DDL / migrations skip it too), and `remove()`
deletes without archiving (`archivedCount: 0`, return shape unchanged). For one-shot control pass
`remove(cond, null, { archive: false })` to skip the archive for that call only; later default
calls archive as usual.

### 17. A minimal web service: identity set once per request

**Scenario.** You want a small REST-ish service where permissions are enforced at the data layer —
not re-implemented in every handler.

```js
const express = require('express');   // any framework works; this is the smallest sketch
const { init, store, local } = require('nodejs-store');

await init({ default: local.connect({ dir: './data' }) });

const app = express();
app.use(express.json());

// Once per request: the data layer reads identity from here.
// (authenticated middleware fills req.user; guests keep an explicit guest role)
app.use((req, res, next) => {
  store.setContext({ userId: req.user.id, roles: req.user.roles });
  next();
});

app.get('/courses', async (req, res) => {
  try {
    const page = await store.queryWithCount(
      'Course($condition:@c0,$sort:@s0){ _id, title, price }',
      { c0: {}, s0: { createdAt: -1 }, page: Number(req.query.page) || 0, pageSize: 20 });
    res.json(page);                    // { items, total, hasMore, page, pageSize }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });  // PermissionError carries status 403
  }
});

app.listen(3000);
```

**Result.** One middleware sets `{ userId, roles }`; every `store.*` call inside any handler (and
anything it awaits) is permission-checked against the schema whitelists — `guest` never writes,
`creator` rows are owner-filtered, denials come back as typed errors instead of empty results.

**Why it wins.** Authorization lives at the single chokepoint every query/write passes through, so
"forgot the check in handler X" is structurally impossible — the handler contains no permission code
at all. `PermissionError.status = 403` maps straight to HTTP; `queryWithCount` returns page/total
with a hard `pageSize` cap (5000); and `routeOverride` — the one parameter that can re-target another
tenant — is documented as trusted server-side input, never request data. Koa / Fastify are the same
three lines: set context in middleware, call `store.*`, map errors to responses.

## Performance

Positioning first: nodejs-store's performance model is **push the work into the database, plan once
in Rust, cross the FFI boundary once**. The numbers below come from one development machine — treat
them as order-of-magnitude evidence, not a certified benchmark.

### Measured locally (SQLite, in-memory)

Environment: 2026-10-15, Node v25.1.0, Windows (win32), `better-sqlite3` in-memory database
(synchronous driver, zero network), Rust core `rust-store-node` 4.5.0 (napi-rs). Method: read cases
run once as warm-up then 5 timed runs (median reported); the insert case is a single cold run
(re-inserting the same rows would collide on `_id`); every case asserts result correctness before
timing. Re-running the script moved the two 201-query cases by up to ±25% — magnitudes and ratios
stayed stable.

| Operation | Data volume | Executions | Time | vs baseline |
| --- | --- | --- | --- | --- |
| `insertMany` batch insert (4 chunks × 2,500 rows) | 10,000 rows | 4 statements | ~253 ms (single run) | ≈ 39,500 rows/s |
| Relation tree read — 1 GQL, 200 parents × 10 children | 2,000 child rows | 1 query | ~56 ms (median of 5) | 2.2× faster |
| Hand-written N+1 loop (same data) | 2,000 child rows | 201 queries | ~122 ms (median of 5) | baseline |
| `$group` + `$sum` aggregation (8 groups) | 10,000 rows | 1 query | ~5.3 ms (median of 5) | ~42× faster |
| Full fetch + `reduce` in JS (same data) | 10,000 rows | 1 query + JS loop | ~225 ms (median of 5) | baseline |
| Relation-agg computed column `$count` (200 parents) | 2,000 child rows | 1 query | ~4.1 ms (median of 5) | ~9.9× faster |
| Per-parent `store.count()` loop (same data) | 2,000 child rows | 201 queries | ~41 ms (median of 5) | baseline |

How to read it:

- **On an embedded synchronous driver there is no network**, so N+1 costs "only" 2–3×. Over a real
  network (MongoDB / MySQL / PostgreSQL — one round trip per query) 201 round trips vs 1 multiplies
  by your RTT: at 1 ms per round trip that is ~200 ms of pure waiting vs 0. The structural win is a
  fixed execution count, independent of page size (see
  [Scenario 3](#3-one-gql-read-instead-of-an-n1-loop)).
- **The ~42× on `$group`** is the other half of the model: aggregation compiles to one native
  `GROUP BY ... HAVING`, so 10,000 rows never cross the FFI + JSON-rehydration boundary; the reduce
  version moves all of them into JS first (see
  [Scenario 6](#6-aggregation-instead-of-hand-written-sql-reports)).
- **Insert throughput (~40k rows/s)** includes `_id` minting, timestamps and planning on a single
  SQLite connection. SQLite caps bound variables (~32,767), so a 10,000-row `insertMany` must be
  chunked (~2,500 rows at a time) — a SQLite limitation, not the store's.

### Existing load evidence (four backends)

The repo ships a four-backend load script ([scripts/stress.js](scripts/stress.js)): MongoDB + MySQL
+ PostgreSQL + SQLite under one federated relation, 8 workers × 200 rounds × 5 ops = 8,000
operations. Its 2026-09-12 report ([doc/2026-09-12-压测报告.md](doc/2026-09-12-压测报告.md))
recorded **0 errors, 637.7 QPS overall**, and the cross-3-source federated read at **p50 25 ms /
p95 48 ms** (project dev machine, `LOCAL_CORE=1`; those numbers belong to that environment and were
not reproduced here).

### Why it is fast by design

- **Rust core pushdown.** GQL parsing, permission checks, computed-column planning and dialect
  translation live in Rust (`rust-store-node` via napi-rs): relations compile to one native query per
  backend (`$lookup` / `JOIN` + `ROW_NUMBER`), aggregation to `GROUP BY`/`HAVING`, relation
  predicates to `EXISTS`/`NOT EXISTS` — the database does the work, not JS.
- **Plan once, execute once.** The FFI boundary is crossed for planning (`store.buildPipeline()`
  exposes the compiled `{ tokens, ast, pipeline, projection }` without executing); the host layer
  only does driver IO afterwards.
- **Bounded execution counts.** A parent+relation read is 1 query (2 with root-level paging — the
  bounded two-phase shape), never N+1; per-child `$sort`/`$limit` is applied inside the same
  statement.
- **Read-time computed columns** cost one function call per returned row — not extra queries; the
  `agg` form rolls relations up inside the same query.

### Limits, honestly

- **SQLite is synchronous.** `better-sqlite3` blocks the event loop — for high-concurrency hot paths
  prefer MySQL / PostgreSQL / MongoDB (see [When not to use it](#when-not-to-use-it)).
- **One machine, one backend.** All numbers above are this machine, in-memory SQLite, warm cache.
  MySQL / PostgreSQL / MongoDB server-side numbers: **pending verification — no local server was
  available for this run**; the SQL-side architecture claim (one parameterized statement per read) is
  verifiable on your side via `store.buildPipeline()`.
- **Computed columns scale with result size.** A scalar `fn` runs per returned row — request fewer
  rows or fewer computes if that shows up in a profile.
- **No magic at the driver level.** Connection-pool sizing, SQL indexing (`schema.indexes` stays
  metadata on SQL backends; only Mongo sources get indexes auto-created at `init()`) and query
  design remain yours.

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
Use `store.setContext({ userId, roles })` plus schema-level `read`/`write` whitelists. The `creator` pseudo-role adds automatic ownership checks and owner-condition injection (ownership key defaults to `createdBy`; override per schema with `ownerKey`, e.g. `ownerKey: '_id'` when documents are owned by their own `_id`). `guest` can never write. Turn on `setRequireContext(true)` for fail-secure behaviour.

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

- [`py-store`](https://github.com/coenddt/py-store) ([Gitee](https://gitee.com/coenddt/py-store)) — the Python asyncio twin (pip `storepy`, `from py_store import init, store`).
- [`rust-store`](https://github.com/coenddt/rust-store) ([Gitee](https://gitee.com/coenddt/rust-store)) — the shared Rust core and its `rust-store-node` / `rust-store-py` bindings.
- `text-to-query` — a companion skill that turns natural-language questions into GQL + params for this data layer.

## Framework usage contract

- Definition layer (data): models / permissions / workflows / interfaces are always pure JSON — publishable, rollbackable, hot-reloadable.
- Callback layer (code): datasource IO, computed-column implementations, external calls, transactions — declared via `fnRef` and injected at startup; not serializable, must never be persisted.
- Observability layer: every degradation / interception / fallback event lands in `__feedback` (queryable via GQL) — never silent.

## License

[MIT](LICENSE)
