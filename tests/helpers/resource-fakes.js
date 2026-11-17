'use strict';

/**
 * resource 域测试桩（resource-pools / resource 两文件共用，D4-2 去重）。
 *
 * fakeStore 方法体与原两份手写逐字等价（行为含：insert 返回 data 本体、
 * query 按 ResourceLocation + resourceId 过滤、remove 按 resourceId 或 _id 定位）。
 */

/** ResourceLocation 存储桩：rows 数组 + 按资源 id 定位 */
function fakeStore() {
  const rows = [];
  return {
    _rows: rows,
    async exists(schema, cond) { return rows.some((r) => r._schema === schema && r._id === cond._id); },
    async insert(schema, data) { rows.push({ _schema: schema, ...data }); return data; },
    async insertMany(schema, docs) { docs.forEach((d) => rows.push({ _schema: schema, ...d })); return docs; },
    async query(gql, params) { const id = params.c0.resourceId; return rows.filter((r) => r._schema === 'ResourceLocation' && r.resourceId === id); },
    async queryOne(gql, params) { return rows.find((r) => r._schema === 'Resource' && r._id === params.c0._id) || null; },
    async remove(schema, cond) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i]._schema === schema && (cond.resourceId ? rows[i].resourceId === cond.resourceId : rows[i]._id === cond._id)) rows.splice(i, 1); return { deletedCount: 1 }; },
  };
}

module.exports = { fakeStore };
