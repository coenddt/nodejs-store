'use strict';

/**
 * ID 供给（Host 随机源） —— 与 core `needs_new_id` 语义对齐
 *
 * core 无随机源：需要新 _id 时由 Host 按序供给，本模块负责生成与遍历。
 * 随机段使用 crypto 强随机源 8 位 base36（约 41 bit 熵）：Math.random 仅 4 位
 * （36^4 ≈ 168 万组合），insertMany 同毫秒批量生成时碰撞概率不可忽略（CWE-338）。
 */

const crypto = require('node:crypto');

const { get: _getSchema } = require('../schema');

const _ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 按 schema.idPrefix 生成唯一 ID（时间戳36进制 + crypto 随机8位） */
function _generateId(schema) {
  const ts = Date.now().toString(36).toUpperCase();
  let rnd = '';
  for (let i = 0; i < 8; i++) {
    // crypto.randomInt 内部拒绝采样，无取模偏差
    rnd += _ID_CHARS[crypto.randomInt(_ID_CHARS.length)];
  }
  return schema.idPrefix + ts + rnd.toUpperCase();
}

/** 对齐 core `is_truthy`（字符串仅判空，不 trim） */
function _truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

/**
 * 预生成 mutation 的 ID 池：按数据树逐节点判断是否需要新 _id
 * （与 core `needs_new_id` 一致：无有效 _id 且 schema 配了 idPrefix），
 * 保证游标消费顺序与节点顺序对齐（父子 schema 前缀不同也能取对 ID）。
 */
function _newIdPool(schemaName, data) {
  const pool = [];
  const walk = (name, node) => {
    const s = _getSchema(name);
    if (!_truthy(node?._id) && s.idPrefix) {
      pool.push(_generateId(s));
    }
    for (const [key, val] of Object.entries(node || {})) {
      const rel = s.relations[key];
      if (!rel || val === null || val === undefined) continue;
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child !== null && child !== undefined) walk(rel.model, child);
        }
      } else {
        walk(rel.model, val);
      }
    }
  };
  walk(schemaName, data);
  return pool;
}

module.exports = { _generateId, _truthy, _newIdPool };
