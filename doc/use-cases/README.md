# Use cases

Scenario walkthroughs for nodejs-store.

| Scenario | What it shows |
| --- | --- |
| [01 — Multi-tenant SaaS](01-multi-tenant-saas.md) | Bind a schema to `(source, namespace, collection)` and re-target each request with a `{ source, namespace }` route override. |
| [02 — AI data-QA agent](02-ai-data-qa-agent.md) | Compile and validate a GQL plan with `buildPipeline()` before executing it, and capture degraded / non-pushdownable paths with `setFeedbackSink()`. |
| [03 — MongoDB → PostgreSQL migration](03-mongodb-to-postgres-migration.md) | Run the same schema and the same GQL against MongoDB then PostgreSQL, changing only the `init()` datasource; introspect the physical structure read-only with `syncSchema()`. |
| [04 — Admin CRUD backend](04-admin-crud-backend.md) | Schema-driven CRUD with computed columns, soft-delete archives, role whitelists + the `creator` pseudo-role, and `queryWithCount` pagination. |
| [05 — Avoiding N+1 reads](05-avoiding-n-plus-one-reads.md) | Replace a parent-then-children loop with one nested GQL read — a single `$lookup` aggregation on MongoDB, a single `LEFT JOIN` statement on SQL — and see when the planner uses a two-phase read instead. |
| [06 — Serverless and connection reuse](06-serverless-and-connection-reuse.md) | Hoist `init()` and schema registration, keep the driver client warm across invocations, and isolate each request with `setContext` plus fail-secure `setRequireContext(true)`. |

Back to the [root README](../../README.md).
