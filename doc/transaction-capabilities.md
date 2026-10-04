# Transaction capabilities

Scope: the write / transactional boundary of the data layer, with a focus on how **location**
(cross-database, and on PostgreSQL cross-schema) affects atomicity.

## Within a single connection

- **SQL (MySQL / PostgreSQL / SQLite)** — one connection owns one transaction. Because a
  MySQL database, a PostgreSQL database (which holds several schemas) and an SQLite
  attached database are all reached over that same connection, a write that spans several
  databases (and, on PostgreSQL, several schemas) inside one connection lands in **one
  transaction**: it commits or rolls back as a unit. PostgreSQL lets a single transaction
  address several schemas of the same database directly; MySQL reaches several databases
  as `db.table`; SQLite reaches attached databases as `db.table`.
- **MongoDB** — a multi-document / cross-database write is transactional only on a replica
  set (or sharded cluster). The source is probed at runtime; on a standalone deployment or
  a failed probe the operation runs as-is (non-atomic) and emits one
  `mongo_transaction_unsupported` (`deployment: standalone|unknown`) feedback event.

## Across connections (multiple sources)

There is **no cross-source (distributed) transaction** — no 2PC, no Saga. A write that
spans more than one connection is therefore:

- **explicitly rejected** where the API already owns an atomic scope (e.g. a `session`
  writing to ≥2 sources rolls everything back and throws `NonAtomicWriteError`), or
- **degraded with a feedback event** where the call is a plain write that cannot be
  refused without breaking backward compatibility (executed source by source, in order,
  and one `non_atomic_write` / `nonAtomic` event names the sources involved).

Either way the non-atomic boundary is declared — it is **never silent**.

## Summary

| Write spans | Atomic? | Mechanism |
|---|---|---|
| One SQL connection, cross-database / cross-PG-schema | yes | one transaction on that connection |
| One MongoDB connection (replica set / sharded) | yes | session transaction (runtime-probed) |
| One MongoDB connection (standalone / probe failed) | no | runs as-is + `mongo_transaction_unsupported` event |
| Multiple connections | no | explicit rejection (`NonAtomicWriteError`) or degradation + `non_atomic_write` event |
