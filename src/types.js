'use strict';

/**
 * 类型系统 — 类型 → 零值映射
 */

const TYPE_MAP = {
  string: '',
  int: 0,
  long: 0,
  float: 0,
  double: 0,
  boolean: false,
  array: 'array', // 工厂标记：每次返回新实例
  object: 'object', // 工厂标记：每次返回新实例
  date: null,
  any: null,
};

/** 获取指定类型的零值 */
function getDefault(fieldType) {
  if (!Object.prototype.hasOwnProperty.call(TYPE_MAP, fieldType)) {
    return null;
  }
  const value = TYPE_MAP[fieldType];
  // array/object 需要每次返回新实例，避免多个文档共享同一引用
  if (value === 'array') return [];
  if (value === 'object') return {};
  return value;
}

function isNumeric(fieldType) {
  return fieldType === 'int' || fieldType === 'long' || fieldType === 'float' || fieldType === 'double';
}

function isPrimitive(fieldType) {
  return (
    fieldType === 'string' ||
    fieldType === 'int' ||
    fieldType === 'long' ||
    fieldType === 'float' ||
    fieldType === 'double' ||
    fieldType === 'boolean'
  );
}

module.exports = { TYPE_MAP, getDefault, isNumeric, isPrimitive };
