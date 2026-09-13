-- MySQL 物理表（固定 example 库，无 token）。object/array 字段不建列（引擎跳过，行为需
-- 由用例显式断言 Err/unsupported，不得静默丢条件）。归档表 <collection>_deleted。
-- `__present` = 「缺失 vs null 三态」哨兵列（F-07/H-01/A-19）：存每行显式存在的标量字段
-- 令牌集合（,f1,f2,），读侧据此区分「显式 null（有键）」与「缺失（无键）」。
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
  _id VARCHAR(64) NOT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  role VARCHAR(255),
  avatar VARCHAR(255),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE users_deleted (
  _id VARCHAR(64) NOT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  role VARCHAR(255),
  avatar VARCHAR(255),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE categories (
  _id VARCHAR(64) NOT NULL,
  name VARCHAR(255),
  parentId VARCHAR(64),
  sort INT,
  createdBy VARCHAR(64),
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE categories_deleted (
  _id VARCHAR(64) NOT NULL,
  name VARCHAR(255),
  parentId VARCHAR(64),
  sort INT,
  createdBy VARCHAR(64),
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE courses (
  _id VARCHAR(64) NOT NULL,
  title VARCHAR(255),
  summary VARCHAR(255),
  status VARCHAR(64),
  price DOUBLE,
  enrolledCount INT,
  rating DOUBLE,
  secret VARCHAR(255),
  categoryId VARCHAR(64),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE courses_deleted (
  _id VARCHAR(64) NOT NULL,
  title VARCHAR(255),
  summary VARCHAR(255),
  status VARCHAR(64),
  price DOUBLE,
  enrolledCount INT,
  rating DOUBLE,
  secret VARCHAR(255),
  categoryId VARCHAR(64),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lessons (
  _id VARCHAR(64) NOT NULL,
  courseId VARCHAR(64),
  parentId VARCHAR(64),
  title VARCHAR(255),
  seq INT,
  duration INT,
  videoUrl VARCHAR(255),
  free TINYINT(1),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE lessons_deleted (
  _id VARCHAR(64) NOT NULL,
  courseId VARCHAR(64),
  parentId VARCHAR(64),
  title VARCHAR(255),
  seq INT,
  duration INT,
  videoUrl VARCHAR(255),
  free TINYINT(1),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE enrollments (
  _id VARCHAR(64) NOT NULL,
  userId VARCHAR(64),
  courseId VARCHAR(64),
  amount DOUBLE,
  paid TINYINT(1),
  paidAt BIGINT,
  status VARCHAR(64),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE enrollments_deleted (
  _id VARCHAR(64) NOT NULL,
  userId VARCHAR(64),
  courseId VARCHAR(64),
  amount DOUBLE,
  paid TINYINT(1),
  paidAt BIGINT,
  status VARCHAR(64),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE reviews (
  _id VARCHAR(64) NOT NULL,
  courseId VARCHAR(64),
  userId VARCHAR(64),
  score INT,
  content VARCHAR(255),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE reviews_deleted (
  _id VARCHAR(64) NOT NULL,
  courseId VARCHAR(64),
  userId VARCHAR(64),
  score INT,
  content VARCHAR(255),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE study_notes (
  _id VARCHAR(64) NOT NULL,
  title VARCHAR(255),
  content VARCHAR(255),
  courseId VARCHAR(64),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE study_notes_deleted (
  _id VARCHAR(64) NOT NULL,
  title VARCHAR(255),
  content VARCHAR(255),
  courseId VARCHAR(64),
  createdBy VARCHAR(64),
  createdAt BIGINT,
  updatedAt BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_logs (
  _id VARCHAR(64) NOT NULL,
  actorId VARCHAR(64),
  action VARCHAR(64),
  target VARCHAR(64),
  at BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE audit_logs_deleted (
  _id VARCHAR(64) NOT NULL,
  actorId VARCHAR(64),
  action VARCHAR(64),
  target VARCHAR(64),
  at BIGINT,
  deletedAt BIGINT,
  __present VARCHAR(255),
  PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 探针表（E-11/E-12/D-06）──
DROP TABLE IF EXISTS probe_computes;
DROP TABLE IF EXISTS probe_notes;
DROP TABLE IF EXISTS probe_memos;
DROP TABLE IF EXISTS probe_holders;
DROP TABLE IF EXISTS probe_grades;
CREATE TABLE probe_grades (
  _id VARCHAR(64) NOT NULL, score INT, createdBy VARCHAR(64), __present VARCHAR(255), PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE probe_holders (
  _id VARCHAR(64) NOT NULL, label VARCHAR(255), gradeId VARCHAR(64), createdBy VARCHAR(64), __present VARCHAR(255), PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE probe_memos (
  _id VARCHAR(64) NOT NULL, noteId VARCHAR(64), body VARCHAR(255), createdBy VARCHAR(64), __present VARCHAR(255), PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE probe_notes (
  _id VARCHAR(64) NOT NULL, label VARCHAR(255), createdBy VARCHAR(64), __present VARCHAR(255), PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE probe_computes (
  _id VARCHAR(64) NOT NULL, label VARCHAR(255), secret VARCHAR(255), createdBy VARCHAR(64), __present VARCHAR(255), PRIMARY KEY (_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;