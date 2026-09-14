# Admin CRUD backend

## The problem

You are building an internal admin tool: list, view, edit and archive records for a handful of
models. The work is repetitive — every model needs list pagination with a total count, a
detail view, guarded writes, a delete that can be undone, and some derived columns (counts,
totals) that the UI shows but that are not stored in the table. On top of that, different staff
roles should see and do different things, and an editor should only touch their own records.

## Why nodejs-store

- **Schema-driven CRUD.** A model is pure JSON (`fields`, `relations`, `computes`, `indexes`,
  `read`/`write`). From it you get `insert` / `update` / `updateMany` / `remove` / `exists` /
  `count` plus GQL reads without hand-writing SQL or an ODM.
- **Computed columns.** `fn` computes are evaluated at read time; `agg` computes roll a relation
  up (for example `{ $count: 'items' }`). Writes store only user data.
- **Soft delete built in.** Every schema auto-registers a `<Model>Deleted` archive
  collection/table (`<collection>_deleted`), and `remove()` archives before deleting.
- **Role whitelists + the `creator` pseudo-role.** Schema-level `read`/`write` lists gate a role
  set, and `creator` resolves to `doc.createdBy === ctx.userId`, adding automatic ownership
  checks and owner-condition injection.
- **Pagination with a hard cap.** `queryWithCount` accepts `page`/`pageSize` and returns
  `{ items, total, hasMore, page, pageSize }`; `pageSize` is capped at 5000 to prevent
  accidental full-table dumps.
- **Empty-condition writes are rejected.** `updateMany` / `remove` with `{}`, `null` or
  `{ "$and": [] }` fails outright instead of falling through to a full-table write.

## Walkthrough

```js
const { store, PermissionError } = require('nodejs-store');

store.register({
  name: 'Course',
  collection: 'courses',
  idPrefix: 'c',
  timestamps: true,
  fields: {
    title: { type: 'string', default: '' },
    status: { type: 'string', default: 'draft' },
    price: { type: 'float', default: 0 },
    createdBy: { type: 'string' },
  },
  relations: {
    lessons: { model: 'Lesson', type: 'many', localField: '_id', foreignField: 'courseId' },
  },
  computes: {
    lessonCount: { type: 'int', agg: { $count: 'lessons' } },
    revenue: { type: 'float', depends: ['price'], fn: (d) => d.price * 1.2 },
  },
  indexes: [{ keys: { status: 1, createdAt: -1 } }],
  read: ['admin', 'editor', 'creator'],
  write: ['admin', 'editor', 'creator'],
});

// Once per request (middleware layer).
store.setContext({ userId: req.user.id, roles: req.user.roles });

// List — page/pageSize are read from the params object; pageSize is capped at 5000.
const page = await store.queryWithCount(
  'Course($condition:@c0,$sort:@s0){ _id, title, status, lessonCount, revenue }',
  { c0: { status: 'published' }, s0: { createdAt: -1 }, page: 0, pageSize: 50 },
);
// page = { items, total, hasMore, page, pageSize }

// Update — plain fields become a $set; '$'-prefixed keys pass through as operators.
await store.update('Course', { _id: id }, { status: 'published' });
await store.update('Course', { _id: id }, { $inc: { enrolledCount: 1 } });

// Soft delete — archives to courses_deleted first (upsert-by-_id), then deletes.
const r = await store.remove('Course', { _id: id });
// r = { deletedCount, archivedCount }

// Empty conditions never reach the database.
await store.remove('Course', {}); // rejected instead of deleting the whole table
```

## Pitfalls

- **Empty-condition writes are rejected, not ignored.** `remove('Course', {})`,
  `updateMany('Course', {}, ...)` and `{ "$and": [] }` throw; this is a guard against full-table
  writes, so always pass an explicit condition.
- **`pageSize` is capped at 5000.** Larger values are clamped; do not rely on a single request
  to export a whole table.
- **Framework-maintained fields.** `createdAt` / `updatedAt` (ms) are maintained by the
  framework — do not set them manually — and `_id` cannot be changed via `update`.
- **Fail-open by default.** With no context set, permission checks are disabled (backward
  compatible). For an internal admin, call `store.setRequireContext(true)` so a missing context
  throws `ERR_NO_CONTEXT:...` instead of silently passing every check; internal jobs then declare
  themselves with `store.runAsInternal(...)`.
- **`guest` can never write**, and denied access throws `PermissionError` (`status = 403`) — catch
  it to render a 403 rather than a 500.
- **Archive naming follows `collection`.** The archive table for `courses` is `courses_deleted`;
  if you override `collection`, the archive name changes with it.

## See also

- [Query & write API](../../README.md#query--write-api)
- [Permission context](../../README.md#permission-context)
- [Schema reference](../../README.md#schema-reference)
- [01 — Multi-tenant SaaS](01-multi-tenant-saas.md)
- [Root README](../../README.md)
