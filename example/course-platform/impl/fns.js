'use strict';

/**
 * fn / asyncFn 计算列实现（`fns.py` 的 JS 版）；键 = schema.json / probes.js 里的 fnRef。
 *
 * 调用契约（对齐 py-store / Node 宿主 src/schema.js）：
 *   - fn      : `(item) => value`            单行回调，入参为当前文档对象
 *   - asyncFn : `async (items, ctx) => void` Host 读路径尾处理，原地写结果数组
 *
 * 注意：注册前必须把 schema.json 里的 `true` 占位替换为这里的真函数
 * （src/schema.js：`val.fn` → `core.setFn(fnRef, val.fn)`；`val.asyncFn` → `_asyncFns[fnRef]`）。
 */

/** D-01/D-04/D-09：revenue = price * enrolledCount */
function courseRevenue(item) {
  return (item.price || 0) * (item.enrolledCount || 0);
}

/** D-07：跨层级 depends（lessons{duration}）→ 累计课时时长 */
function courseLessonDuration(item) {
  const lessons = item.lessons || [];
  return lessons.reduce((sum, l) => sum + (l.duration || 0), 0);
}

/** D-02/D-05：User.displayName asyncFn 尾处理 */
async function userDisplayName(items) {
  for (const it of items) {
    it.displayName = `${it.name}#${it._id}`;
  }
}

/** D-06 探针：depends 依赖不可读字段 `secret`（read=admin） */
function courseRevenueViaSecret(item) {
  return (item.secret || '').slice(0, 4);
}

const FNS = {
  course_revenue: courseRevenue,
  course_lesson_duration: courseLessonDuration,
  user_display_name: userDisplayName,
  course_revenue_via_secret: courseRevenueViaSecret,
};

module.exports = { FNS, courseRevenue, courseLessonDuration, userDisplayName, courseRevenueViaSecret };
