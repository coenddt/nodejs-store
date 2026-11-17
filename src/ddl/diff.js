'use strict';

/**
 * schema 声明式迁移的 diff 层（D4-4 零语义拆分自 ddl.js）：新旧 def 对比 →
 * `{ changes, errors }`，后端无关、纯函数。与拆分前逐字同语义。
 */

const { TYPES, NON_COLUMN, declaredType } = require('./base');

/** 类型放宽映射（首批）：值域安全扩大的单向变更；跨大类不在映射内 → Err */
const WIDEN = {
  int: ['long', 'float', 'double'],
  long: ['float', 'double'],
  float: ['double'],
};

/** _id 主键 diff：类型与 strategy 变更均不支持（错误文案与原实现逐字一致） */
function _diffFieldId(oldFields, nf, errors) {
  const of = oldFields._id;
  if (of !== undefined && declaredType(of) !== declaredType(nf)) {
    errors.push(`_id 主键类型变更不支持（${declaredType(of)} → ${declaredType(nf)}）`);
  }
  const oStrat = of && typeof of === 'object' ? of.strategy : undefined;
  const nStrat = nf && typeof nf === 'object' ? nf.strategy : undefined;
  if (oStrat !== nStrat) {
    errors.push(`_id 主键策略变更不支持（${JSON.stringify(oStrat)} → ${JSON.stringify(nStrat)}）`);
  }
}

/** 新列 diff：类型未知记错误；否则记 addColumn（continue → return 同序等价） */
function _diffNewField(name, nf, nfType, changes, errors) {
  if (!Object.prototype.hasOwnProperty.call(TYPES, nfType) && !NON_COLUMN.includes(nfType)
      && nfType !== 'vector') {
    errors.push(`新列 "${name}" 类型 ${JSON.stringify(nfType)} 未知`);
    return;
  }
  changes.push({
    op: 'addColumn', name,
    field: nf && typeof nf === 'object' ? nf : { type: nf },
  });
}

/** 读 vector 字段元数据：dim（缺省 undefined）/ metric（缺省 cosine） */
function _vectorMetaOf(f) {
  return {
    dim: f && typeof f === 'object' ? f.dim : undefined,
    metric: (f && typeof f === 'object' && f.metric) || 'cosine',
  };
}

/** vector 同型字段的 dim / metric 元数据比对（默认 cosine；元数据变更不支持） */
function _diffVectorMeta(name, of, nf, errors) {
  const { dim: od, metric: om } = _vectorMetaOf(of);
  const { dim: nd, metric: nm } = _vectorMetaOf(nf);
  if (od !== nd || om !== nm) {
    errors.push(
      `字段 "${name}" 的 vector 元数据变更不支持（dim ${JSON.stringify(od)} → ${JSON.stringify(nd)}，`
      + `metric ${JSON.stringify(om)} → ${JSON.stringify(nm)}）；需显式重建列与向量索引`);
  }
}

/** 同名两侧字段类型 diff：同型（vector 再比元数据）→ 返回；放宽记 widenColumn；否则记错误 */
function _diffFieldType(of, nf, name, changes, errors) {
  const ofType = declaredType(of);
  const nfType = declaredType(nf);
  if (ofType === nfType) {
    if (nfType === 'vector') _diffVectorMeta(name, of, nf, errors);
    return;
  }
  if (nfType && (WIDEN[ofType] || []).includes(nfType)) {
    changes.push({ op: 'widenColumn', name, from: ofType, to: nfType });
  } else {
    errors.push(
      `字段 "${name}" 类型 ${JSON.stringify(ofType)} → ${JSON.stringify(nfType)} 非放宽变更`
      + '（首批仅支持单向放宽：int→long/float/double、long→float/double、float→double）');
  }
}

/** 删除字段 diff：old 有 new 无 → 破坏性变更记错误 */
function _diffRemovedFields(oldFields, newFields, errors) {
  for (const name of Object.keys(oldFields)) {
    if (!(name in newFields)) {
      errors.push(`删除字段 "${name}" 不支持（破坏性变更；请显式走数据迁移脚本）`);
    }
  }
}

/** 索引 diff：new 侧新出现的索引记 addIndex。相等判定用稳定序列化（键序无关 + JS 数字
 * 语义），对齐 py diff_defs 的 stable_stringify：JSON.stringify 键序敏感会让「同键不同序」
 * 误判为新增索引（P9）。 */
function _diffIndexes(oldDefn, newDefn, changes) {
  const indexKeys = (defn) => (defn.indexes || [])
    .filter((ix) => ix && typeof ix === 'object' && ix.keys
      && typeof ix.keys === 'object' && Object.keys(ix.keys).length);
  const { _stableStringify } = require('../metadef');
  const oldIdx = new Set(indexKeys(oldDefn).map(_stableStringify));
  for (const ix of indexKeys(newDefn)) {
    if (!oldIdx.has(_stableStringify(ix))) {
      changes.push({ op: 'addIndex', index: ix });
    }
  }
}

/** collection 改名 diff：不一致记错误（破坏性变更） */
function _assertCollectionUnchanged(oldDefn, newDefn, errors) {
  const oldColl = oldDefn.collection || oldDefn.name;
  const newColl = newDefn.collection || newDefn.name;
  if (oldColl !== newColl) {
    errors.push(`collection 改名不支持（${JSON.stringify(oldColl)} → ${JSON.stringify(newColl)}；破坏性变更）`);
  }
}

/** 新旧 schema def 对比 → { changes, errors }（后端无关，纯函数；白名单外记入 errors） */
function diffDefs(oldDefn, newDefn) {
  const changes = [];
  const errors = [];
  const oldFields = (oldDefn && oldDefn.fields) || {};
  const newFields = newDefn.fields || {};

  if (oldDefn === null || oldDefn === undefined) {
    return { changes: [{ op: 'addTable', defn: newDefn }], errors };
  }

  for (const [name, nf] of Object.entries(newFields)) {
    if (name === '_id') {
      _diffFieldId(oldFields, nf, errors);
      continue;
    }
    if (!(name in oldFields)) {
      _diffNewField(name, nf, declaredType(nf), changes, errors);
      continue;
    }
    _diffFieldType(oldFields[name], nf, name, changes, errors);
  }
  _diffRemovedFields(oldFields, newFields, errors);
  _diffIndexes(oldDefn, newDefn, changes);
  _assertCollectionUnchanged(oldDefn, newDefn, errors);
  return { changes, errors };
}

module.exports = { diffDefs };
