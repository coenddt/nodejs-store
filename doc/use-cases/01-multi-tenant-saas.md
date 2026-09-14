# Multi-tenant SaaS

## The problem

You run one product for many tenants. Each tenant should live in its own logical database — a
database per tenant on MongoDB, or a schema per tenant on PostgreSQL — and no tenant may ever
read another tenant's rows. The obvious first answer is "one data layer per tenant", which
means one connection, one model class and one query builder per tenant: the codebase grows
with your customer list.

You also want the same models to work whether a tenant is hosted on MongoDB or on PostgreSQL,
and you still need row-level access control and soft delete for every model.

## Why nodejs-store

A schema in nodejs-store is located by the triple `(source, namespace, collection)`. The
`source` is a connection key registered with `init({...})`; the `namespace` is the database
(PG schema, MySQL database, Mongo db name) inside that connection; the `collection` is the
table/collection name.

That means:

- You define **one** schema. Binding it to `datasource`/`namespace` fixes where it lives by
  default.
- Any query or write accepts a **route override** — a `{ source, namespace }` object passed as
  the last argument — that re-targets the command at execution time. One schema definition
  serves N tenants.
- Permission checks and computed columns are still evaluated against the **structural** schema,
  so tenant routing does not weaken the access rules.
- The triple must be globally unique across the registry; a duplicate registration throws
  instead of silently mis-routing.

## Walkthrough

```js
const { MongoClient } = require('mongodb');
const { init, store, executors } = require('nodejs-store');

const client = new MongoClient('mongodb://localhost:27017');
await client.connect();

// Two sources: one Mongo cluster (many tenant databases) and one PostgreSQL source.
await init({
  cluster: client,
  pg_cluster: executors.createConnection('postgres', pgPool), // { kind, exec }
});

// One schema definition. `datasource` binds the default source; a schema without
// `namespace` uses the connection default.
store.register({
  name: 'Order',
  collection: 'orders',
  idPrefix: 'OD',
  datasource: 'cluster',
  timestamps: true,
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    amount: { type: 'float', default: 0 },
    createdBy: { type: 'string' },
  },
  relations: {
    items: { model: 'OrderItem', type: 'many', localField: '_id', foreignField: 'orderId' },
  },
  computes: {
    itemCount: { type: 'int', agg: { $count: 'items' } },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
  read: ['editor', 'viewer', 'creator'],
  write: ['editor', 'creator'],
});

store.register({
  name: 'OrderItem',
  collection: 'order_items',
  idPrefix: 'OI',
  datasource: 'cluster',
  timestamps: true,
  fields: {
    orderId: { type: 'string' },
    qty: { type: 'int', default: 1 },
    createdBy: { type: 'string' },
  },
});

// Per request, first set the permission context, then derive the route from
// trusted server-side session state — never from raw request input.
store.setContext({ userId: req.user.id, roles: req.user.roles });

const route = { source: 'cluster', namespace: `tenant_${req.user.tenantId}` };

const openOrders = await store.query(
  'Order($condition:@c0,$sort:@s0,$limit:@l0){ _id, title, status, itemCount }',
  { c0: { status: 'open' }, s0: { createdAt: -1 }, l0: 20 },
  route,
);

const created = await store.insert(
  'Order',
  { title: 'PO-2026-001', status: 'open', amount: 1200, createdBy: req.user.id },
  route,
);

// A tenant hosted on PostgreSQL is the same call with a different route.
const pgOrders = await store.query(
  'Order($condition:@c0){ _id, title, status }',
  { c0: { status: 'open' } },
  { source: 'pg_cluster', namespace: `tenant_${req.user.tenantId}` },
);
```

## Pitfalls

- **`routeOverride` is a trusted server-side parameter.** It carries no origin check. Passing
  raw request data into it (for example `{ namespace: req.query.ns }`) lets a caller re-target
  another tenant's `source` / `namespace` — a CWE-639 authorization-bypass surface. Derive the
  route from the authenticated session, never from user input.
- **Global uniqueness of `(source, namespace, collection)`.** Registering two schemas with the
  same triple throws rather than silently mis-routing. Give each tenant-bound model a distinct
  `namespace`/`collection`.
- **Permissions and computes follow the structural schema, not the override.** The route only
  changes *where* the command runs; `read`/`write` whitelists and computed columns are unchanged.
- **Cross-source limits.** SQL cross-namespace joins are pushed down natively; only Mongo
  cross-database relations fall back to in-memory federation.

## See also

- [Multi-datasource connections](../../README.md#multi-datasource-connections)
- [Permission context](../../README.md#permission-context)
- [04 — Admin CRUD backend](04-admin-crud-backend.md)
- [Root README](../../README.md)
