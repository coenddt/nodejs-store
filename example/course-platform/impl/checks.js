'use strict';

/**
 * `expect.kind = 'raw'` 的自定义断言函数（`checks.py` 的 JS 版）。
 *
 * 统一签名 `async (h, expect) -> { ok: boolean, note: string }`，`h` 提供：
 *   - h.store / h.backend / h.result / h.error / h.events
 *   - h.store 可直接再发查询（当前 ctx 已设定）
 */

const { permission } = require('../../../src');

/** 不带分页的查询参数（剔除 page/pageSize；其余原样保留） */
function _plainParams(params) {
  const plain = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'page' && k !== 'pageSize') plain[k] = v;
  }
  return plain;
}

/** 分页元数据判定：page/pageSize/total/hasMore 任一不符 → 记入 msgs 并返回 false */
function _checkPageMeta(res, page, size, allCount, msgs) {
  let ok = true;
  if (res.page !== page || res.pageSize !== size) {
    ok = false;
    msgs.push(`分页元数据不符 page=${res.page} size=${res.pageSize}`);
  }
  if (res.total !== allCount) {
    ok = false;
    msgs.push(`total=${res.total} 期望 ${allCount}`);
  }
  const expectHasMore = (page + 1) * size < res.total;
  if (res.hasMore !== expectHasMore) {
    ok = false;
    msgs.push(`hasMore=${res.hasMore} 期望 ${expectHasMore}`);
  }
  return ok;
}

/** items 一致性判定：越界项 / 与期望 ids 不符 → 记入 msgs 并返回 false */
function _checkItemIds(res, allItems, expect, msgs) {
  let ok = true;
  const itemIds = res.items.map((i) => i._id).sort();
  const allIds = allItems.map((i) => i._id).sort();
  if (!itemIds.every((id) => allIds.includes(id))) {
    ok = false;
    msgs.push(`items 越界: ${itemIds} 不在 ${allIds}`);
  }
  if (expect.expectedIds) {
    const expIds = [...expect.expectedIds].sort();
    if (JSON.stringify(itemIds) !== JSON.stringify(expIds)) {
      ok = false;
      msgs.push(`items=${itemIds} 期望 ${expIds}`);
    }
  }
  return ok;
}

/** A-18：query_with_count 元数据自洽（items/total/hasMore 与同参 query、count 一致） */
async function checkPage(h, expect) {
  const gql = expect.gql;
  const params = { ...(expect.params || {}) };
  const page = params.page !== undefined ? params.page : 0;
  const size = params.pageSize !== undefined ? params.pageSize : 3;
  const res = await h.store.queryWithCount(gql, params);
  // 不带分页的 query（返回全部命中；owner 注入下即该 ctx 的全部）
  const allItems = await h.store.query(gql, _plainParams(params));
  const msgs = [];
  let ok = _checkPageMeta(res, page, size, allItems.length, msgs);
  if (!_checkItemIds(res, allItems, expect, msgs)) ok = false;
  return { ok, note: msgs.join('；') || 'page 元数据自洽' };
}

/** F-06/H-05：'paid' 值必须是真布尔（不得 SQL 0/1 或字符串） */
async function checkBoolRows(h, expect) {
  const field = expect.field || 'paid';
  const rows = h.result || [];
  for (let i = 0; i < rows.length; i += 1) {
    if (field in rows[i] && typeof rows[i][field] !== 'boolean') {
      return { ok: false, note: `第${i}行 ${field}=${JSON.stringify(rows[i][field])} 非 bool` };
    }
  }
  return { ok: true, note: '均为 bool' };
}

/** F-05：timestamps 字段须为 13 位 ms 数值（>=10^12） */
async function checkMsTimestamp(h, expect) {
  const fields = expect.fields || ['createdAt', 'updatedAt'];
  const rows = h.result || [];
  for (let i = 0; i < rows.length; i += 1) {
    for (const f of fields) {
      const v = rows[i][f];
      if (v === null || v === undefined || typeof v !== 'number' || !(v >= 1e12 && v < 1e14)) {
        return { ok: false, note: `第${i}行 ${f}=${JSON.stringify(v)} 不是 13 位 ms 值` };
      }
    }
  }
  return { ok: true, note: '时间戳为 ms 数值' };
}

/** 单行 int 字段校验：非整数值 → 返回错误 note；合规/缺省 → null */
function _checkIntField(r, i, intField) {
  if (intField in r && r[intField] !== null) {
    if (typeof r[intField] !== 'number' || !Number.isInteger(r[intField])) {
      return `第${i}行 ${intField}=${JSON.stringify(r[intField])} 非 int`;
    }
  }
  return null;
}

/** 单行 float 字段校验：非数值 → 返回错误 note；合规/缺省 → null */
function _checkFloatField(r, i, floatField) {
  if (floatField in r && r[floatField] !== null) {
    if (typeof r[floatField] !== 'number') {
      return `第${i}行 ${floatField}=${JSON.stringify(r[floatField])} 非 float`;
    }
  }
  return null;
}

/** H-04：int/float 类型归一（不得字符串/Decimal） */
async function checkNumericRows(h, expect) {
  const intField = expect.intField || 'enrolledCount';
  const floatField = expect.floatField || 'price';
  const rows = h.result || [];
  for (let i = 0; i < rows.length; i += 1) {
    // 先 int 后 float，与原判定顺序一致（首个错误即返回）
    const bad = _checkIntField(rows[i], i, intField) || _checkFloatField(rows[i], i, floatField);
    if (bad) return { ok: false, note: bad };
  }
  return { ok: true, note: '类型归一' };
}

/** D-06：secret 键及 secret 值都不得在结果中透出；整体 Err（显式拒绝）也视为通过 */
async function checkNoSecret(h, expect) {
  const field = expect.field || 'secret';
  const secret = expect.secret;
  if (h.error !== null && h.error !== undefined) {
    return { ok: true, note: '计算列因依赖不可读被显式拒绝' };
  }
  const rows = h.result || [];
  for (let i = 0; i < rows.length; i += 1) {
    if (field in rows[i]) {
      return { ok: false, note: `第${i}行泄漏了不可读字段 ${field}=${JSON.stringify(rows[i][field])}` };
    }
    if (secret && JSON.stringify(rows[i]).includes(secret)) {
      return { ok: false, note: `第${i}行泄漏了 secret 值片段` };
    }
  }
  return { ok: true, note: 'secret 未泄漏' };
}

/** E-14：super_admin / admin / internal 三种 ctx 都应能读 AuditLog（read=admin） */
async function checkPrivilegedRoles(h, expect) {
  const gql = expect.gql;
  const bad = [];
  const setup = [
    [{ userId: 'sys', roles: ['super_admin'] }, 'super_admin'],
    [{ userId: 'sys', roles: ['admin'] }, 'admin'],
    [{ internal: true }, 'internal'],
  ];
  for (const [ctx, label] of setup) {
    permission.setContext(ctx);
    try {
      await h.store.query(gql);
    } catch (e) {
      bad.push(`${label}: ${e && e.message ? e.message : e}`);
    }
  }
  if (bad.length) return { ok: false, note: `特权角色被拒: ${bad.join('；')}` };
  return { ok: true, note: '全部特权角色放行' };
}

/** E-13：无 ctx 时 fail-open 放行；开启 require_context 后无 ctx 抛 ERR_NO_CONTEXT */
async function checkRequireContext(h, expect) {
  const gql = expect.gql;
  permission.setContext(undefined);
  try {
    await h.store.query(gql); // fail-open：应放行
  } catch (e) {
    return { ok: false, note: `fail-open 下无 ctx 查询竟失败: ${e && e.message ? e.message : e}` };
  }
  h.store.setRequireContext(true);
  permission.setContext(undefined);
  try {
    await h.store.query(gql);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e instanceof h.store.NoContextError) {
      return { ok: true, note: '开启强制后无 ctx 被拒（NoContextError）' };
    }
    return { ok: false, note: `开启强制后抛的非 NoContextError 错误: ${msg}` };
  }
  return { ok: false, note: '开启 require_context 后无 ctx 竟放行（fail-secure 失效）' };
}

/** 被裁剪字段允许的形态：缺省 / null / 空数组 / 空对象；非数组非空对象即视为泄漏 */
function _isTrimmedEmpty(v) {
  return v === undefined || v === null
    || (Array.isArray(v) && v.length === 0)
    || (!Array.isArray(v) && typeof v === 'object' && Object.keys(v).length === 0);
}

/** E-05/E-11：字段（关系）因权限被裁剪 —— 允许不出现或为空，不得返回数据本身 */
async function checkRelationTrim(h, expect) {
  const field = expect.field;
  const rows = h.result || [];
  for (let i = 0; i < rows.length; i += 1) {
    const v = rows[i][field];
    if (field in rows[i] && !_isTrimmedEmpty(v)) {
      return { ok: false, note: `第${i}行泄漏了不可见字段 ${field}=${JSON.stringify(v)}` };
    }
  }
  return { ok: true, note: `${field} 未泄漏` };
}

/** E-16：u1 试图 update 属于 u2 的 StudyNote n2 —— 必须被拒或 0 行，不得改动 */
async function checkWriteOwner(h) {
  permission.setContext({ userId: 'u1', roles: ['student'] });
  try {
    await h.store.update('StudyNote', { _id: 'n2' }, { title: 'hacked' });
  } catch {
    return { ok: true, note: '越权 update 被拒（403）' };
  }
  permission.setContext({ userId: 'u2', roles: ['admin'] });
  const rows = await h.store.query('StudyNote($condition:@c0){_id, title}', { c0: { _id: 'n2' } });
  if (rows && rows.length && rows[0].title === 'hacked') {
    return { ok: false, note: '越权改写了 u2 的 StudyNote' };
  }
  return { ok: true, note: 'update 未生效（0 行/被忽略）' };
}

const CHECKS = {
  check_page: checkPage,
  check_bool_rows: checkBoolRows,
  check_ms_timestamp: checkMsTimestamp,
  check_numeric_rows: checkNumericRows,
  check_no_secret: checkNoSecret,
  check_privileged_roles: checkPrivilegedRoles,
  check_require_context: checkRequireContext,
  check_relation_trim: checkRelationTrim,
  check_write_owner: checkWriteOwner,
};

module.exports = {
  CHECKS,
  checkPage,
  checkBoolRows,
  checkMsTimestamp,
  checkNumericRows,
  checkNoSecret,
  checkPrivilegedRoles,
  checkRequireContext,
  checkRelationTrim,
  checkWriteOwner,
};
