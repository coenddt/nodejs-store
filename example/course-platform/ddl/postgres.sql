-- PostgreSQL 物理表（固定 example 库，无 token）。object/array 字段建 jsonb 列（存 JSON 文本）。
-- PG 标识符区分大小写：mixed-case 列一律双引号（与 core dialect_translate 的引号策略一致）。
-- `__present`（全小写、不引号）= 「缺失 vs null 三态」哨兵列（F-07/H-01/A-19）：存每行
-- 显式存在的标量字段令牌集合（,f1,f2,），读侧据此区分「显式 null（有键）」与「缺失（无键）」。
DROP TABLE IF EXISTS audit_logs_deleted CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS study_notes_deleted CASCADE;
DROP TABLE IF EXISTS study_notes CASCADE;
DROP TABLE IF EXISTS reviews_deleted CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS enrollments_deleted CASCADE;
DROP TABLE IF EXISTS enrollments CASCADE;
DROP TABLE IF EXISTS lessons_deleted CASCADE;
DROP TABLE IF EXISTS lessons CASCADE;
DROP TABLE IF EXISTS courses_deleted CASCADE;
DROP TABLE IF EXISTS courses CASCADE;
DROP TABLE IF EXISTS categories_deleted CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS users_deleted CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
  _id TEXT PRIMARY KEY,
  name TEXT, email TEXT, role TEXT, avatar TEXT, profile jsonb,
  "created_by" TEXT, "created_at" BIGINT, "updated_at" BIGINT,
  __present TEXT
);
CREATE TABLE users_deleted (
  _id TEXT PRIMARY KEY,
  name TEXT, email TEXT, role TEXT, avatar TEXT, profile jsonb,
  "created_by" TEXT, "created_at" BIGINT, "updated_at" BIGINT, "deleted_at" BIGINT,
  __present TEXT
);

CREATE TABLE categories (
  _id TEXT PRIMARY KEY,
  name TEXT, "parent_id" TEXT, sort INTEGER, "created_by" TEXT,
  __present TEXT
);
CREATE TABLE categories_deleted (
  _id TEXT PRIMARY KEY,
  name TEXT, "parent_id" TEXT, sort INTEGER, "created_by" TEXT,
  "deleted_at" BIGINT, __present TEXT
);

CREATE TABLE courses (
  _id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, status TEXT, price DOUBLE PRECISION,
  "enrolled_count" INTEGER, rating DOUBLE PRECISION, secret TEXT,
  tags jsonb, meta jsonb,
  "category_id" TEXT, "created_by" TEXT, "created_at" BIGINT, "updated_at" BIGINT,
  __present TEXT
);
CREATE TABLE courses_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, status TEXT, price DOUBLE PRECISION,
  "enrolled_count" INTEGER, rating DOUBLE PRECISION, secret TEXT,
  tags jsonb, meta jsonb,
  "category_id" TEXT, "created_by" TEXT, "created_at" BIGINT, "updated_at" BIGINT, "deleted_at" BIGINT,
  __present TEXT
);

CREATE TABLE lessons (
  _id TEXT PRIMARY KEY,
  "course_id" TEXT, "parent_id" TEXT, title TEXT, seq INTEGER,
  duration INTEGER, "video_url" TEXT, free BOOLEAN, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT,
  __present TEXT
);
CREATE TABLE lessons_deleted (
  _id TEXT PRIMARY KEY,
  "course_id" TEXT, "parent_id" TEXT, title TEXT, seq INTEGER,
  duration INTEGER, "video_url" TEXT, free BOOLEAN, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT, "deleted_at" BIGINT,
  __present TEXT
);

CREATE TABLE enrollments (
  _id TEXT PRIMARY KEY,
  "user_id" TEXT, "course_id" TEXT, amount DOUBLE PRECISION,
  paid BOOLEAN, "paid_at" BIGINT, status TEXT, coupon jsonb, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT,
  __present TEXT
);
CREATE TABLE enrollments_deleted (
  _id TEXT PRIMARY KEY,
  "user_id" TEXT, "course_id" TEXT, amount DOUBLE PRECISION,
  paid BOOLEAN, "paid_at" BIGINT, status TEXT, coupon jsonb, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT, "deleted_at" BIGINT,
  __present TEXT
);

CREATE TABLE reviews (
  _id TEXT PRIMARY KEY,
  "course_id" TEXT, "user_id" TEXT, score INTEGER, content TEXT, tags jsonb, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT,
  __present TEXT
);
CREATE TABLE reviews_deleted (
  _id TEXT PRIMARY KEY,
  "course_id" TEXT, "user_id" TEXT, score INTEGER, content TEXT, tags jsonb, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT, "deleted_at" BIGINT,
  __present TEXT
);

CREATE TABLE study_notes (
  _id TEXT PRIMARY KEY,
  title TEXT, content TEXT, "course_id" TEXT, tags jsonb, meta jsonb, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT,
  __present TEXT
);
CREATE TABLE study_notes_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT, content TEXT, "course_id" TEXT, tags jsonb, meta jsonb, "created_by" TEXT,
  "created_at" BIGINT, "updated_at" BIGINT, "deleted_at" BIGINT,
  __present TEXT
);

CREATE TABLE audit_logs (
  _id TEXT PRIMARY KEY,
  "actor_id" TEXT, action TEXT, target TEXT, at BIGINT, detail jsonb,
  __present TEXT
);
CREATE TABLE audit_logs_deleted (
  _id TEXT PRIMARY KEY,
  "actor_id" TEXT, action TEXT, target TEXT, at BIGINT, detail jsonb, "deleted_at" BIGINT,
  __present TEXT
);

-- ── 探针表（E-11/E-12/D-06）──
DROP TABLE IF EXISTS probe_computes CASCADE;
DROP TABLE IF EXISTS probe_notes CASCADE;
DROP TABLE IF EXISTS probe_memos CASCADE;
DROP TABLE IF EXISTS probe_holders CASCADE;
DROP TABLE IF EXISTS probe_grades CASCADE;
CREATE TABLE probe_grades (
  _id TEXT PRIMARY KEY, score INTEGER, "created_by" TEXT, __present TEXT
);
CREATE TABLE probe_holders (
  _id TEXT PRIMARY KEY, label TEXT, "grade_id" TEXT, "created_by" TEXT, __present TEXT
);
CREATE TABLE probe_memos (
  _id TEXT PRIMARY KEY, "note_id" TEXT, body TEXT, "created_by" TEXT, __present TEXT
);
CREATE TABLE probe_notes (
  _id TEXT PRIMARY KEY, label TEXT, "created_by" TEXT, __present TEXT
);
CREATE TABLE probe_computes (
  _id TEXT PRIMARY KEY, label TEXT, secret TEXT, "created_by" TEXT, __present TEXT
);