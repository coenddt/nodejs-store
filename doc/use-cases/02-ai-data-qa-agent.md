# AI data-QA agent

## The problem

You want users to ask questions in natural language — "which products have more than three
orders?" — and get real rows back. An LLM can translate the question into a query, but you
cannot run whatever the model produced blindly: a query that cannot be pushed down to the
target backend, or that fans out across sources, must be caught *before* execution, and every
degraded path must be visible instead of silently returning wrong or partial data.

You also need the generated query to be inspectable, so you can show it to the user or assert
its shape in tests.

## Why nodejs-store

- **`store.buildPipeline(gql, params?)`** compiles GQL into the command plan **without
  executing it**, returning `{ tokens, ast, pipeline, projection }`. This is the compile-and-
  validate step for a generated query: you can assert the plan's shape, check which backend it
  targets, and surface it to the user *before* a single row is read.
- Queries are written in **one deterministic dialect** (`$condition` / `$sort` / `$group` /
  `$having` / relation blocks), so the natural-language → GQL layer only has to emit one
  string format regardless of backend.
- **`store.setFeedbackSink(fn)`** takes over the unified feedback channel for fallback /
  degradation / interception events. Non-pushdownable commands also throw
  `PushdownUnsupportedError`.

The natural-language → GQL translation itself is out of scope for this library — it is what the
companion `text-to-query` skill produces. nodejs-store is the layer that compiles, plans and
executes that GQL.

## Walkthrough

```js
const { store, PushdownUnsupportedError } = require('nodejs-store');

// 1. Route every fallback / degradation / interception event into your own logger.
//    Pass null to restore the default stderr printer.
store.setFeedbackSink((e) => logger.warn({ code: e.code, layer: e.layer }, e.hint));
// event shape: { type, code, layer, message, hint, ... }
//   type   federation_degraded | sql_pushdown_unsupported | ...
//   code   crossSourceSort | pushdownUnsupported | ...
//   layer  federation | dialect | ...

// 2. The natural-language layer (see the text-to-query skill) turns the question
//    into a GQL string plus its params.
const gql = 'Product($condition:@c0,$sort:@s0){ _id, name }';
const params = { c0: { status: 'onSale', orders: { $count: { $gt: 3 } } }, s0: { name: 1 } };

// 3. Compile & validate the plan WITHOUT executing it.
const plan = store.buildPipeline(gql, params);
// plan = { tokens, ast, pipeline, projection }
if (!plan.pipeline || plan.pipeline.length === 0) {
  throw new Error('the generated query did not compile to a command');
}

// 4. Execute the same GQL through the normal path, where permissions and
//    computed columns are applied and pushdown failures are explicit.
try {
  const rows = await store.query(gql, params, { source: 'pg_a' });
  return { gql, rows };
} catch (err) {
  if (err instanceof PushdownUnsupportedError) {
    // A sql_pushdown_unsupported feedback event was already emitted above.
    return { gql, rows: [], reason: 'query cannot be pushed down to this backend' };
  }
  throw err;
}
```

## Pitfalls

- **`buildPipeline` applies no permissions and no computed columns.** A plan that compiles is
  *not* authorization: always run the query through `store.query` (or `queryOne` /
  `queryWithCount`) so RBAC and computes are applied.
- **A successful parse is not a successful execution.** `buildPipeline` only builds the plan;
  pushdown failures surface at execution time as `PushdownUnsupportedError` **and** as a
  `sql_pushdown_unsupported` feedback event.
- **Feedback events are not thrown errors.** `federation_degraded` (cross-source
  pagination/sort degradation) and other events arrive through the sink; if you do not install
  a sink they go to stderr. Set the sink once at startup so nothing is missed.
- **`buildPipeline` runs no IO**, so it cannot tell you whether the target backend is reachable
  or whether the data exists — only that the query shape is valid.

## See also

- [`store.buildPipeline`](../../README.md#storebuildpipelinegql-params)
- [`store.setFeedbackSink`](../../README.md#storesetfeedbacksinkfn)
- [Aggregation](../../README.md#aggregation)
- [Root README](../../README.md)
