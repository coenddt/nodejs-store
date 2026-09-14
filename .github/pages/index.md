---
title: "nodejs-store documentation"
description: "Documentation for nodejs-store — one JSON schema and one MongoDB-style GQL query dialect for MongoDB, MySQL, SQLite and PostgreSQL in Node.js."
---

# nodejs-store

**One data layer for MongoDB, MySQL, SQLite and PostgreSQL — define models as pure JSON, query them with a MongoDB-style GQL tree syntax, and get role-based access control, computed columns and soft-delete out of the box.**

`nodejs-store` lets a Node.js service talk to MongoDB (native aggregation), MySQL, PostgreSQL and SQLite through a **single schema definition and a single query dialect**. Nested relations compile to **one native query per backend** — you never hand-write `$lookup` or raw SQL.

```bash
npm install nodejs-store
```

## Scenario walkthroughs

Six end-to-end walkthroughs, each with runnable code, the mistakes people make, and the exact limits of the engine:

| Scenario | What it covers |
| --- | --- |
| [01 — Multi-tenant SaaS](use-cases/01-multi-tenant-saas.html) | Bind one schema to N tenants with `(source, namespace, collection)` and re-target each request with a trusted route override. |
| [02 — AI data-QA agent](use-cases/02-ai-data-qa-agent.html) | Compile and validate a GQL plan with `buildPipeline()` before executing it; capture degraded paths with `setFeedbackSink()`. |
| [03 — MongoDB → PostgreSQL migration](use-cases/03-mongodb-to-postgres-migration.html) | The same schema and the same GQL against two backends — only the `init()` datasource changes. |
| [04 — Admin CRUD backend](use-cases/04-admin-crud-backend.html) | Schema-driven CRUD with computed columns, soft-delete archives, role whitelists and `queryWithCount` pagination. |
| [05 — Avoiding N+1 reads](use-cases/05-avoiding-n-plus-one-reads.html) | Replace a parent-then-children loop with one nested GQL read, and see when the planner picks a two-phase read instead. |
| [06 — Serverless and connection reuse](use-cases/06-serverless-and-connection-reuse.html) | Hoist `init()` and schema registration, keep the driver client warm, isolate requests with `setContext`. |

## Documentation

- [Full README](readme.html) — architecture, API reference, GQL capabilities, permission model, gotchas.
- [Use-cases index](use-cases/) — the walkthrough list above with summaries.

## Related projects

- [`py-store`](https://github.com/coenddt/py-store) — the Python asyncio host of the same engine (pip `storepy`).
- [`rust-store`](https://github.com/coenddt/rust-store) — the shared Rust core: GQL parsing, permissions, computed columns, command planning and SQL dialect translation.

## Links

- npm: [nodejs-store](https://www.npmjs.com/package/nodejs-store)
- Source: [github.com/coenddt/nodejs-store](https://github.com/coenddt/nodejs-store)
- Machine-readable summary: [llms.txt](llms.txt)
