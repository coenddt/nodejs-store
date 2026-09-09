# mongo-store-js

A lightweight MongoDB data layer for Node.js — define your models as pure JSON schemas, query with GQL tree syntax that compiles to a single `$lookup` aggregation, and get role-based access control out of the box.

This is the Node.js port of [`mongo-store-py`](https://github.com/coenddt/mongo-store-py) — same schemas, same GQL, same semantics, camelCase API.

## Features

- **Pure JSON schemas, zero code** — a model is just an object: fields, relations, computes, indexes.
- **Read-time defaults & computed columns** — writes store only user data; reads fill defaults and run `fn`/`asyncFn` computes.
- **GQL tree queries → one `$lookup`** — nested relations resolve via a single aggregation pipeline; never hand-write `$lookup` again.
- **Smart mutation** — `mutation()` auto-detects upsert by `_id` + unique index and recursively fills relation children.
- **Soft-delete built in** — every schema auto-registers a `<Model>Deleted` archive collection; `remove()` archives before deleting.
- **Permission context** — `AsyncLocalStorage`-based roles (`super_admin`/`admin`/`guest`/`creator`...), schema/field-level read/write whitelists, automatic owner-condition injection.
- **Async-first** — built on the official `mongodb` Node.js driver (`mongodb >= 6`).

## Installation

```bash
npm install mongo-store-js
```

Requires Node.js 18+ and MongoDB.

## Quick start

```js
const { MongoClient } = require('mongodb');
const { init, store } = require('mongo-store-js');

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

## License

[MIT](LICENSE)
