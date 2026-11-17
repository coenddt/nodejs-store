'use strict';

/**
 * DDL 生成（schema def → CREATE TABLE 文本；纯函数，不连库、不回写）
 *
 * 与 core 契约严格对齐（schema→DDL 单向映射）：
 *   - 标量字段按声明类型建列；object/array 字段建 **JSON 列**（MySQL `JSON` / PG `jsonb` /
 *     SQLite `TEXT`，同 core dialect::Backend::json_type_name）——落单列存 JSON 文本，
 *     读侧由 core row::parse_json_col 还原为嵌套对象，跨后端对齐 Mongo 嵌套文档；
 *   - 每表必建 __present 哨兵列（形态 ,f1,f2,；同 core write/insert.rs::present_value）；
 *   - timestamps !== false → 追加 createdAt / updatedAt（同 core schema/registry.rs::add_timestamp_fields）；
 *   - 归档表 <collection>_deleted 由 registry 自动派生，本模块按已注册 def 逐表生成（不特判）；
 *   - schema.indexes（Mongo 形态 {keys: {f: 1|-1}, options/inline}）→ CREATE [UNIQUE] INDEX
 *     （阶段 3 索引落地；原「仅元数据不建索引」铁律 6 子项按用户裁决放开，见
 *     common-store/事务型能力增补执行文档.md 附录 D）。与 py_store/ddl.py 逐字节对齐。
 *
 * 生成器只产出文本、不执行 —— 不违反铁律 6（绝不写 DDL 回库）。
 * 对齐 py_store/ddl.py（两端输出逐字节一致）。
 *
 * D4-4 零语义拆分：基础层（常量 / 标识符翻译 / 向量）下沉 ./ddl/base，建表层
 * （内建列 / 列元组 / 索引 / CREATE TABLE）下沉 ./ddl/table，迁移 diff 下沉
 * ./ddl/diff，迁移语句生成与归档补建下沉 ./ddl/migrate，生成入口下沉
 * ./ddl/generate；本文件仅作门面转发，导出面（键名 / 键序 / 语义）与拆分前逐字一致。
 */

const { pname, ptable } = require('./ddl/base');
const { builtinFieldNames, ownerField } = require('./ddl/table');
const { diffDefs } = require('./ddl/diff');
const {
  archiveDefnOf,
  generateMigration,
  archiveDDL,
  implicitColumnDDL,
} = require('./ddl/migrate');
const { generate } = require('./ddl/generate');

module.exports = {
  generate, diffDefs, generateMigration, pname, ptable, builtinFieldNames, ownerField,
  archiveDDL, archiveDefnOf, implicitColumnDDL,
};
