-- SQLite 物理表（内存库，无 token）。object/array 字段建 JSON 列（TEXT 存 JSON 文本）。SQLite 标识符大小写不敏感。
-- `__present` = 「缺失 vs null 三态」哨兵列：存每行显式存在的标量字段令牌集合（,f1,f2,），
--              读侧据此区分「显式 null（有键）」与「缺失（无键）」（F-07/H-01/A-19）。
DROP TABLE IF EXISTS audit_logs_deleted;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS study_notes_deleted;
DROP TABLE IF EXISTS study_notes;
DROP TABLE IF EXISTS reviews_deleted;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS enrollments_deleted;
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS lessons_deleted;
DROP TABLE IF EXISTS lessons;
DROP TABLE IF EXISTS courses_deleted;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS categories_deleted;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS users_deleted;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  _id TEXT PRIMARY KEY,
  name TEXT, email TEXT, role TEXT, avatar TEXT, profile TEXT,
  created_by TEXT, created_at INTEGER, updated_at INTEGER,
  __present TEXT
);
CREATE TABLE users_deleted (
  _id TEXT PRIMARY KEY,
  name TEXT, email TEXT, role TEXT, avatar TEXT, profile TEXT,
  created_by TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  __present TEXT
);

CREATE TABLE categories (
  _id TEXT PRIMARY KEY,
  name TEXT, parent_id TEXT, sort INTEGER, created_by TEXT,
  __present TEXT
);
CREATE TABLE categories_deleted (
  _id TEXT PRIMARY KEY,
  name TEXT, parent_id TEXT, sort INTEGER, created_by TEXT,
  deleted_at INTEGER, __present TEXT
);

CREATE TABLE courses (
  _id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, status TEXT, price REAL,
  enrolled_count INTEGER, rating REAL, secret TEXT,
  tags TEXT, meta TEXT,
  category_id TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER,
  __present TEXT
);
CREATE TABLE courses_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, status TEXT, price REAL,
  enrolled_count INTEGER, rating REAL, secret TEXT,
  tags TEXT, meta TEXT,
  category_id TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  __present TEXT
);

CREATE TABLE lessons (
  _id TEXT PRIMARY KEY,
  course_id TEXT, parent_id TEXT, title TEXT, seq INTEGER,
  duration INTEGER, video_url TEXT, free INTEGER, created_by TEXT,
  created_at INTEGER, updated_at INTEGER,
  __present TEXT
);
CREATE TABLE lessons_deleted (
  _id TEXT PRIMARY KEY,
  course_id TEXT, parent_id TEXT, title TEXT, seq INTEGER,
  duration INTEGER, video_url TEXT, free INTEGER, created_by TEXT,
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  __present TEXT
);

CREATE TABLE enrollments (
  _id TEXT PRIMARY KEY,
  user_id TEXT, course_id TEXT, amount REAL,
  paid INTEGER, paid_at INTEGER, status TEXT, coupon TEXT, created_by TEXT,
  created_at INTEGER, updated_at INTEGER,
  __present TEXT
);
CREATE TABLE enrollments_deleted (
  _id TEXT PRIMARY KEY,
  user_id TEXT, course_id TEXT, amount REAL,
  paid INTEGER, paid_at INTEGER, status TEXT, coupon TEXT, created_by TEXT,
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  __present TEXT
);

CREATE TABLE reviews (
  _id TEXT PRIMARY KEY,
  course_id TEXT, user_id TEXT, score INTEGER, content TEXT, tags TEXT, created_by TEXT,
  created_at INTEGER, updated_at INTEGER,
  __present TEXT
);
CREATE TABLE reviews_deleted (
  _id TEXT PRIMARY KEY,
  course_id TEXT, user_id TEXT, score INTEGER, content TEXT, tags TEXT, created_by TEXT,
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  __present TEXT
);

CREATE TABLE study_notes (
  _id TEXT PRIMARY KEY,
  title TEXT, content TEXT, course_id TEXT, tags TEXT, meta TEXT, created_by TEXT,
  created_at INTEGER, updated_at INTEGER,
  __present TEXT
);
CREATE TABLE study_notes_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT, content TEXT, course_id TEXT, tags TEXT, meta TEXT, created_by TEXT,
  created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
  __present TEXT
);

CREATE TABLE audit_logs (
  _id TEXT PRIMARY KEY,
  actor_id TEXT, action TEXT, target TEXT, at INTEGER, detail TEXT,
  __present TEXT
);
CREATE TABLE audit_logs_deleted (
  _id TEXT PRIMARY KEY,
  actor_id TEXT, action TEXT, target TEXT, at INTEGER, detail TEXT, deleted_at INTEGER,
  __present TEXT
);

-- ── 探针表（E-11/E-12/D-06）──
DROP TABLE IF EXISTS probe_computes;
DROP TABLE IF EXISTS probe_notes;
DROP TABLE IF EXISTS probe_memos;
DROP TABLE IF EXISTS probe_holders;
DROP TABLE IF EXISTS probe_grades;
CREATE TABLE probe_grades (
  _id TEXT PRIMARY KEY, score INTEGER, created_by TEXT, __present TEXT
);
CREATE TABLE probe_holders (
  _id TEXT PRIMARY KEY, label TEXT, grade_id TEXT, created_by TEXT, __present TEXT
);
CREATE TABLE probe_memos (
  _id TEXT PRIMARY KEY, note_id TEXT, body TEXT, created_by TEXT, __present TEXT
);
CREATE TABLE probe_notes (
  _id TEXT PRIMARY KEY, label TEXT, created_by TEXT, __present TEXT
);
CREATE TABLE probe_computes (
  _id TEXT PRIMARY KEY, label TEXT, secret TEXT, created_by TEXT, __present TEXT
);