-- manager-transaction · SQLite 物理表（DROP 省略：harness 每轮 DELETE 清库）
-- 注意：auto_orders 的自增主键是「阶段2 目标态」的手工预置（当前引擎不生成 DDL 自增列，
-- 用例 T2-01 借它实测 autoincrement schema 的宿主侧行为；阶段2 落地后应由 ddl 生成器产出）。
DROP TABLE IF EXISTS users;
CREATE TABLE users (_id TEXT PRIMARY KEY, name TEXT, createdBy TEXT, __present TEXT);
DROP TABLE IF EXISTS products;
CREATE TABLE products (_id TEXT PRIMARY KEY, name TEXT, category TEXT, price REAL, createdBy TEXT, __present TEXT);
DROP TABLE IF EXISTS inventories;
CREATE TABLE inventories (_id TEXT PRIMARY KEY, productId TEXT, warehouse TEXT, stock INTEGER, warnLine INTEGER, createdBy TEXT, __present TEXT);
DROP TABLE IF EXISTS orders;
CREATE TABLE orders (_id TEXT PRIMARY KEY, orderNo TEXT, buyerId TEXT, status TEXT, createdBy TEXT, __present TEXT);
DROP TABLE IF EXISTS order_items;
CREATE TABLE order_items (_id TEXT PRIMARY KEY, orderId TEXT, productId TEXT, quantity INTEGER, unitPrice REAL, createdBy TEXT, __present TEXT);
DROP TABLE IF EXISTS auto_orders;
CREATE TABLE auto_orders (_id INTEGER PRIMARY KEY AUTOINCREMENT, orderNo TEXT, amount REAL, __present TEXT);
DROP TABLE IF EXISTS users_deleted;
CREATE TABLE users_deleted (_id TEXT PRIMARY KEY, name TEXT, createdBy TEXT, __present TEXT, deletedAt INTEGER);
DROP TABLE IF EXISTS products_deleted;
CREATE TABLE products_deleted (_id TEXT PRIMARY KEY, name TEXT, category TEXT, price REAL, createdBy TEXT, __present TEXT, deletedAt INTEGER);
DROP TABLE IF EXISTS inventories_deleted;
CREATE TABLE inventories_deleted (_id TEXT PRIMARY KEY, productId TEXT, warehouse TEXT, stock INTEGER, warnLine INTEGER, createdBy TEXT, __present TEXT, deletedAt INTEGER);
DROP TABLE IF EXISTS orders_deleted;
CREATE TABLE orders_deleted (_id TEXT PRIMARY KEY, orderNo TEXT, buyerId TEXT, status TEXT, createdBy TEXT, __present TEXT, deletedAt INTEGER);
DROP TABLE IF EXISTS order_items_deleted;
CREATE TABLE order_items_deleted (_id TEXT PRIMARY KEY, orderId TEXT, productId TEXT, quantity INTEGER, unitPrice REAL, createdBy TEXT, __present TEXT, deletedAt INTEGER);
DROP TABLE IF EXISTS auto_orders_deleted;
CREATE TABLE auto_orders_deleted (_id, orderNo TEXT, amount REAL, __present TEXT, deletedAt INTEGER);
