-- resource-hub · SQLite 物理表（内存库；列名为物理 snake_case，含 __present 三态哨兵）
-- 说明：SQL 后端由 core dialect 生成物理名（camelCase→snake_case），并要求 __present 哨兵列；
--       内容寻址 _id=sha1；三张资源表 + 业务表各自归档表（store.remove 走归档 + 删除）。

CREATE TABLE IF NOT EXISTS resources (
  _id TEXT PRIMARY KEY,
  sha1 TEXT NOT NULL,
  file_name TEXT,
  mime TEXT,
  size INTEGER,
  kind TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resources_sha1 ON resources (sha1);
CREATE TABLE IF NOT EXISTS resources_deleted (
  _id TEXT PRIMARY KEY,
  sha1 TEXT NOT NULL,
  file_name TEXT,
  mime TEXT,
  size INTEGER,
  kind TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS resource_locations (
  _id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  "key" TEXT NOT NULL,
  status TEXT,
  priority INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resloc_resource_backend ON resource_locations (resource_id, backend);
CREATE TABLE IF NOT EXISTS resource_locations_deleted (
  _id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  "key" TEXT NOT NULL,
  status TEXT,
  priority INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS resource_bindings (
  _id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  business_table TEXT NOT NULL,
  business_id TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resbind_triple ON resource_bindings (resource_id, business_table, business_id);
CREATE TABLE IF NOT EXISTS resource_bindings_deleted (
  _id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  business_table TEXT NOT NULL,
  business_id TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS docs (
  _id TEXT PRIMARY KEY,
  title TEXT,
  cover_id TEXT,
  attachment_id TEXT,
  created_by TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT
);
CREATE TABLE IF NOT EXISTS docs_deleted (
  _id TEXT PRIMARY KEY,
  title TEXT,
  cover_id TEXT,
  attachment_id TEXT,
  created_by TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  __present TEXT,
  deleted_at INTEGER
);
