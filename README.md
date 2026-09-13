# nodejs-store

A lightweight multi-backend data layer for Node.js — define your models as pure JSON schemas, query with GQL tree syntax, and get role-based access control out of the box. One unified MongoDB-style dialect runs on **MongoDB, MySQL, SQLite and PostgreSQL**.

This is the Node.js port of [`py-store`](https://github.com/coenddt/py-store) — same schemas, same GQL, same semantics, camelCase API. Both are thin hosts over the shared Rust core in [`rust-store`](https://github.com/coenddt/rust-store).

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
- **Read-time defaults & computed columns** — writes store only user data; reads fill defaults and run `fn`/`asyncFn` computes.
- **GQL tree queries → one native query** — nested relations resolve in a single query; never hand-write `$lookup` again.
- **Smart mutation** — `mutation()` auto-detects upsert by `_id` + unique index and recursively fills relation children.
- **Soft-delete built in** — every schema auto-registers a `<Model>Deleted` archive collection/table; `remove()` archives before deleting.
- **Permission context** — `AsyncLocalStorage`-based roles (`super_admin`/`admin`/`guest`/`creator`...), schema/field-level read/write whitelists, automatic owner-condition injection.
- **Async-first** — built on the `mongodb` Node.js driver and a shared Rust core with SQL dialects.

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

## GQL syntax

```text
Model($condition:@c0,$sort:@s1,$skip:@sk,$limit:@l1) {
  field1, field2, obj.subField,
  Relation($condition:@c2,$sort:@s3,$limit:@l2) { f3, Nested { f4 } }
}
```

- Values come from the params object: `{ c0: {...}, s1: {...} }`.
- Object sub-fields use dot notation; relations are declared in the schema (`type: 'many' | 'one'`) and resolved automatically — **do not hand-write `$lookup`**.
- `$pipeline` passes a raw aggregation through as-is (no compute/defaults/permission trimming) — use with care; prefer `store.aggregate(model, pipeline)` for group/sum needs.

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
const rows   = await store.aggregate('Post', pipeline);   // native aggregation
```

Notes:

- `null`/`undefined` values are stripped before persisting; `_id` cannot be changed via `update`.
- `createdAt`/`updatedAt` (ms) are framework-maintained — do not set them manually.
- `queryWithCount` accepts `page`/`pageSize` (recommended) or the traditional `$skip`/`$limit` params.

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
    itemCount: { type: 'int', lookup: { $size: { $ifNull: ['$items', []] } } },
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

## Advanced API

Everything below is reachable from the exported `store` singleton or the modules it
re-exports. Options prefixed with `?` are optional.

### `store.buildPipeline(gql, params?)`

Low-level parse — compiles GQL to the command plan **without executing it**, returning
`{ tokens, ast, pipeline, projection }`. Useful for debugging query shape, asserting
pushdown behaviour, or building custom tooling. Permissions / computes are **not** applied here.

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

### `store.setAllowUserPipeline(allow = true)`

Registry-level guard for user-supplied `$pipeline` passthrough. Default is **allow**
(backward compatible); AI / 问数 hosts should call `store.setAllowUserPipeline(false)` as
defense in depth. `store.setRequireContext(...)` (fail-secure mode) is documented under
[Fail-secure mode](#fail-secure-mode-opt-in).

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

### Low-level modules

The package re-exports its building blocks for advanced hosts:

```js
const {
  init, store, Store,
  aggregate,                    // standalone aggregate(schemaName, pipeline, routeOverride)
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

## License

[MIT](LICENSE)
