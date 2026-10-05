'use strict';

/**
 * 业务实体删除时的资源三级级联（数据驱动版）：
 *   1. 删当前业务的全部 binding；
 *   2. 对每个资源：其他业务还引用？→ 保留；否则其他文件名同 sha1？→ 保留字节；否则彻底删。
 * 说明：sha1 相同即同一 `Resource._id`（内容寻址），故「其他文件名」在内容寻址下与
 * 「其他引用」同表判定；此处保留三级语义以便未来改为 `fileName::sha1` 主键时零改。
 */
async function cascadeByBusiness(store, resource, { businessTable, businessId }) {
  const schema = resource.DEFAULT_SCHEMA;
  const bindings = await store.query(
    `${schema.binding}($condition: @c0) { _id, resourceId }`,
    { c0: { businessTable, businessId: String(businessId) } },
  );
  const summary = { total: bindings.length, kept: 0, removed: 0 };
  for (const b of bindings) {
    await store.remove(schema.binding, { _id: b._id });
    const others = await store.query(
      `${schema.binding}($condition: @c0) { _id }`,
      { c0: { resourceId: b.resourceId } },
    );
    if (others.length > 0) { summary.kept += 1; continue; }
    await resource.remove(b.resourceId);
    summary.removed += 1;
  }
  return summary;
}

module.exports = { cascadeByBusiness };
