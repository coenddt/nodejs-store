# Use cases

Scenario walkthroughs for nodejs-store.

| Scenario | What it shows |
| --- | --- |
| [01 — Multi-tenant SaaS](01-multi-tenant-saas.md) | Bind a schema to `(source, namespace, collection)` and re-target each request with a `{ source, namespace }` route override. |
| [02 — AI data-QA agent](02-ai-data-qa-agent.md) | Compile and validate a GQL plan with `buildPipeline()` before executing it, and capture degraded / non-pushdownable paths with `setFeedbackSink()`. |
| [03 — MongoDB → PostgreSQL migration](03-mongodb-to-postgres-migration.md) | Run the same schema and the same GQL against MongoDB then PostgreSQL, changing only the `init()` datasource; introspect the physical structure read-only with `syncSchema()`. |
| [04 — Admin CRUD backend](04-admin-crud-backend.md) | Schema-driven CRUD with computed columns, soft-delete archives, role whitelists + the `creator` pseudo-role, and `queryWithCount` pagination. |

Back to the [root README](../../README.md).
