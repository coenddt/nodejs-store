-- SQLite 物理表（内存库，无 token）。object/array 字段不建列。SQLite 标识符大小写不敏感。
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
  name TEXT, email TEXT, role TEXT, avatar TEXT,
  createdBy TEXT, createdAt INTEGER, updatedAt INTEGER,
  __present TEXT
);
CREATE TABLE users_deleted (
  _id TEXT PRIMARY KEY,
  name TEXT, email TEXT, role TEXT, avatar TEXT,
  createdBy TEXT, createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER,
  __present TEXT
);

CREATE TABLE categories (
  _id TEXT PRIMARY KEY,
  name TEXT, parentId TEXT, sort INTEGER, createdBy TEXT,
  __present TEXT
);
CREATE TABLE categories_deleted (
  _id TEXT PRIMARY KEY,
  name TEXT, parentId TEXT, sort INTEGER, createdBy TEXT,
  deletedAt INTEGER, __present TEXT
);

CREATE TABLE courses (
  _id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, status TEXT, price REAL,
  enrolledCount INTEGER, rating REAL, secret TEXT,
  categoryId TEXT, createdBy TEXT, createdAt INTEGER, updatedAt INTEGER,
  __present TEXT
);
CREATE TABLE courses_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT, summary TEXT, status TEXT, price REAL,
  enrolledCount INTEGER, rating REAL, secret TEXT,
  categoryId TEXT, createdBy TEXT, createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER,
  __present TEXT
);

CREATE TABLE lessons (
  _id TEXT PRIMARY KEY,
  courseId TEXT, parentId TEXT, title TEXT, seq INTEGER,
  duration INTEGER, videoUrl TEXT, free INTEGER, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER,
  __present TEXT
);
CREATE TABLE lessons_deleted (
  _id TEXT PRIMARY KEY,
  courseId TEXT, parentId TEXT, title TEXT, seq INTEGER,
  duration INTEGER, videoUrl TEXT, free INTEGER, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER,
  __present TEXT
);

CREATE TABLE enrollments (
  _id TEXT PRIMARY KEY,
  userId TEXT, courseId TEXT, amount REAL,
  paid INTEGER, paidAt INTEGER, status TEXT, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER,
  __present TEXT
);
CREATE TABLE enrollments_deleted (
  _id TEXT PRIMARY KEY,
  userId TEXT, courseId TEXT, amount REAL,
  paid INTEGER, paidAt INTEGER, status TEXT, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER,
  __present TEXT
);

CREATE TABLE reviews (
  _id TEXT PRIMARY KEY,
  courseId TEXT, userId TEXT, score INTEGER, content TEXT, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER,
  __present TEXT
);
CREATE TABLE reviews_deleted (
  _id TEXT PRIMARY KEY,
  courseId TEXT, userId TEXT, score INTEGER, content TEXT, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER,
  __present TEXT
);

CREATE TABLE study_notes (
  _id TEXT PRIMARY KEY,
  title TEXT, content TEXT, courseId TEXT, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER,
  __present TEXT
);
CREATE TABLE study_notes_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT, content TEXT, courseId TEXT, createdBy TEXT,
  createdAt INTEGER, updatedAt INTEGER, deletedAt INTEGER,
  __present TEXT
);

CREATE TABLE audit_logs (
  _id TEXT PRIMARY KEY,
  actorId TEXT, action TEXT, target TEXT, at INTEGER,
  __present TEXT
);
CREATE TABLE audit_logs_deleted (
  _id TEXT PRIMARY KEY,
  actorId TEXT, action TEXT, target TEXT, at INTEGER, deletedAt INTEGER,
  __present TEXT
);

-- ── 探针表（E-11/E-12/D-06）──
DROP TABLE IF EXISTS probe_computes;
DROP TABLE IF EXISTS probe_notes;
DROP TABLE IF EXISTS probe_memos;
DROP TABLE IF EXISTS probe_holders;
DROP TABLE IF EXISTS probe_grades;
CREATE TABLE probe_grades (
  _id TEXT PRIMARY KEY, score INTEGER, createdBy TEXT, __present TEXT
);
CREATE TABLE probe_holders (
  _id TEXT PRIMARY KEY, label TEXT, gradeId TEXT, createdBy TEXT, __present TEXT
);
CREATE TABLE probe_memos (
  _id TEXT PRIMARY KEY, noteId TEXT, body TEXT, createdBy TEXT, __present TEXT
);
CREATE TABLE probe_notes (
  _id TEXT PRIMARY KEY, label TEXT, createdBy TEXT, __present TEXT
);
CREATE TABLE probe_computes (
  _id TEXT PRIMARY KEY, label TEXT, secret TEXT, createdBy TEXT, __present TEXT
);