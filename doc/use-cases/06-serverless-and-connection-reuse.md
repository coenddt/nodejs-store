# Serverless and connection reuse

## The problem

The same models are used from two kinds of process:

- a long-lived server — one Node process that boots once and serves many requests;
- a serverless / edge-style handler — the runtime invokes it on demand, keeps the process (and
  its open sockets) warm across invocations, and may freeze it in between.

The tempting shortcut is to wire the data layer inside the handler: create a driver client, call
`init()`, run the query. That creates a client per invocation, repeats startup work on every
request, and — because the library keeps its connection map in module scope — lets concurrent
invocations overwrite each other's routing. It also leaves per-request permission context
somewhere a warm container can carry into the next invocation.

## Why nodejs-store

Split the responsibilities explicitly:

- **The driver owns the connection.** You create the `MongoClient` / pool and pass it in; the
  library never opens, closes or pools a connection on your behalf. For SQL it wraps the driver
  you built — `executors.createConnection(kind, driver)` requires that backend's driver
  (`query` for a `pg` pool, `execute` for `mysql2/promise`, `prepare` for `better-sqlite3`).
- **The library owns the query plane.** Schema registry, GQL parsing, permission checks,
  computed columns, command planning, SQL translation and result rehydration are process-local
  and stateless per call. The only state it holds is the connections you gave it.

Because of that split, datasource setup and schema registration belong to process startup; only
the permission context is genuinely per request.

## Walkthrough

Module scope — done once per process, and once per warm container on serverless:

```js
// store.js
const { MongoClient } = require('mongodb');
const { init, store, executors } = require('nodejs-store');

// Schemas are pure JSON: register at module load (re-registering the same name is fine).
// `datasource` + `namespace` fix the default location; a request can re-target it later.
store.register({
  name: 'Order',
  collection: 'orders',
  datasource: 'cluster',
  namespace: 'app',
  idPrefix: 'OD',
  timestamps: true,
  fields: {
    code: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    createdBy: { type: 'string' },
  },
  read: ['editor', 'viewer', 'creator'],
  write: ['editor', 'creator'],
});

// Fail-secure once, at startup: from here on a missing context throws instead of passing checks.
store.setRequireContext(true);

// The client and the pool are yours; the library only holds the handles you hand it.
const client = new MongoClient(process.env.MONGO_URL);
const pgPool = createPgPool(); // your pool

let ready = null;
function boot() {
  // Memoised: the first caller connects and inits; later callers reuse the same promise.
  if (!ready) {
    ready = (async () => {
      await client.connect();
      await init({
        cluster: client,                                    // MongoClient: namespace picks the db
        pg: executors.createConnection('postgres', pgPool),
      });
    })();
  }
  return ready;
}

module.exports = { store, boot };
```

Then the handler only does per-request work:

```js
const { store, boot } = require('./store');

async function handler(req) {
  await boot();                 // no-op after the first invocation in this container

  // Per request: set the context from the authenticated session.
  store.setContext({ userId: req.user.id, roles: req.user.roles });

  return store.query(
    'Order($condition:@c0,$sort:@s0,$limit:@l){ _id, code, status }',
    { c0: { createdBy: req.user.id }, s0: { createdAt: -1 }, l: 20 },
  );
}
```

Anything that varies per request and is *not* the context goes through the route override, not
through a fresh `init()`:

```js
// Same process, same connections, different tenant — no rebinding of the connection map.
await store.query(
  'Order($condition:@c0){ _id, code }',
  { c0: { status: 'open' } },
  { source: 'cluster', namespace: `tenant_${req.user.tenantId}` },
);
```

Jobs that must ignore the caller context declare themselves instead of relying on a missing
context, and bounded units of work scope their roles with a callback:

```js
// Cron / queue consumer.
await store.runAsInternal(() => store.remove('Order', { status: 'stale' }));

// Temporarily switch roles for one unit of work (nested-safe; restores the outer context).
const preview = await store.scopedRoles(['viewer'], () => store.query(gql, params));
```

The datasource helpers let a host assert what it configured without touching the driver:

```js
const { datasource } = require('nodejs-store');
datasource.hasConnection('pg');  // is this source in the map?
datasource.isSql('pg');          // true → commands for it go through translate → exec
```

## Pitfalls

- **Do not call `init()` per request.** `init()` sets the process-global connection map and then
  runs index creation as part of startup. Calling it inside a handler rebinds that map for every
  concurrent invocation — under load, requests race on the same module-scope state. Call it once
  (module scope, or behind a memoised `boot()`), and use the `{ source, namespace }` route
  override for anything that varies per request.
- **Module scope is process scope, not request scope.** The schema registry, the connection map
  and the context storage are module-level singletons, and a warm container keeps them between
  invocations — that is what makes reuse work. Registration is safe to repeat (re-registering the
  same schema name overwrites it), but two *different* schema names must not claim the same
  `(source, namespace, collection)` triple; that collision throws rather than silently
  mis-routing.
- **`setContext` is not callback-scoped.** It uses `AsyncLocalStorage.enterWith`, so it applies
  to the remainder of the current async execution and everything spawned from it. Set it at the
  top of each request and never at module scope; for a bounded piece of work — or to change roles
  temporarily — use `scopedRoles(roles, fn)` / `runAsInternal(fn)`, which wrap a callback with
  `AsyncLocalStorage.run` and restore the previous context when it returns.
- **Fail-open is the default.** With no context set, permission checks are disabled. On a
  serverless deployment call `store.setRequireContext(true)` once at startup so a forgotten
  context throws `ERR_NO_CONTEXT:...` instead of silently passing every check; `runAsInternal` is
  then the explicit way for internal jobs to opt out.
- **The library does not own lifecycle.** It stores the `db` handle / `MongoClient` / SQL
  descriptor you passed and calls the driver per command; it never calls `connect()` or
  `close()`, and it does not create pools. Recycling or closing a client in a warm container is
  your decision and does not require re-registering schemas — `init()` with the new handle is
  enough.
- **A `db` handle and a `MongoClient` are not interchangeable.** A Mongo `db` instance cannot
  cross databases, so commands targeting it must carry `namespace: null`; a `MongoClient` must be
  paired with a `namespace` (the database name). Mixing them up throws instead of guessing.
- **One-shot runtimes.** If the runtime cannot keep a process — and therefore its sockets — alive
  between invocations, connection reuse does not apply and a per-invocation client is
  unavoidable. The library requires Node.js 18+ and uses the native drivers, so it needs a
  runtime that can hold the driver's transport.
- **Index creation is Mongo-only and non-fatal.** Startup index creation runs against Mongo
  sources only (SQL `indexes` are metadata); a source that is not yet in the connection map is
  skipped, and an index that fails to create does not abort `init()` — it is reported through
  the feedback channel.

## See also

- [Multi-datasource connections](../../README.md#multi-datasource-connections)
- [Permission context](../../README.md#permission-context)
- [Transaction boundary](../../README.md#transaction-boundary)
- [01 — Multi-tenant SaaS](01-multi-tenant-saas.md)
- [Root README](../../README.md)
