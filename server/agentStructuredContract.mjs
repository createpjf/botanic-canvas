// @ts-check

/**
 * Agent/MCP 共用的受限结构化契约。
 *
 * 这里有意只实现业务工具需要的 JSON Schema 子集。`$ref`、组合 Schema、正则等能力
 * 会扩大验证器本身的攻击面，也容易让「声明看似严格、实际投影结果不同」；遇到未支持
 * 关键字直接拒绝，比静默忽略更安全。
 */

export const AGENT_STRUCTURED_CONTRACT_LIMITS = Object.freeze({
  maxDepth: 6,
  maxSchemaFields: 64,
  maxObjectFields: 64,
  maxTotalObjectFields: 128,
  maxArrayItems: 64,
  maxTotalArrayItems: 256,
  maxValueNodes: 512,
  maxStringLength: 16_000,
  maxEnumValues: 32,
})

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/
const FORBIDDEN_FIELD_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const SCHEMA_KEYS = Object.freeze({
  object: new Set(['type', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']),
  array: new Set(['type', 'items', 'minItems', 'maxItems']),
  string: new Set(['type', 'minLength', 'maxLength', 'enum']),
  number: new Set(['type', 'minimum', 'maximum']),
  integer: new Set(['type', 'minimum', 'maximum']),
  boolean: new Set(['type']),
  null: new Set(['type']),
})

/**
 * @typedef {{
 *   type: 'object',
 *   properties: Readonly<Record<string, AgentStructuredSchema>>,
 *   required: readonly string[],
 *   additionalProperties: boolean,
 *   minProperties: number,
 *   maxProperties: number,
 * }} AgentStructuredObjectSchema
 */

/**
 * @typedef {{ type: 'array', items: AgentStructuredSchema, minItems: number, maxItems: number }
 *   | { type: 'string', minLength: number, maxLength: number, enum?: readonly string[] }
 *   | { type: 'number' | 'integer', minimum?: number, maximum?: number }
 *   | { type: 'boolean' | 'null' }} AgentStructuredLeafSchema
 */

/** @typedef {AgentStructuredObjectSchema | AgentStructuredLeafSchema} AgentStructuredSchema */

export class AgentStructuredContractError extends Error {
  /** @param {string} code @param {string} message @param {number} [statusCode] */
  constructor(code, message, statusCode = 422) {
    super(message)
    this.name = 'AgentStructuredContractError'
    this.code = code
    this.statusCode = statusCode
    this.outcomeKnown = true
  }
}

/** @param {unknown} value */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? /** @type {Record<string, any>} */ (value)
    : undefined
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return /** @type {Readonly<T>} */ (value)
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** @param {string} message @returns {never} */
function invalidSchema(message) {
  throw new AgentStructuredContractError('AGENT_STRUCTURED_SCHEMA_INVALID', message, 400)
}

/** @param {string} message @returns {never} */
function invalidValue(message) {
  throw new AgentStructuredContractError('AGENT_STRUCTURED_VALUE_INVALID', message, 422)
}

/**
 * @param {unknown} value @param {number} fallback @param {number} minimum
 * @param {number} maximum @param {string} label @returns {number}
 */
function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalidSchema(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`)
  }
  return value
}

/** @param {Record<string, any>} source @param {string} type @param {string} path */
function assertSupportedKeys(source, type, path) {
  const supported = SCHEMA_KEYS[type]
  for (const key of Object.keys(source)) {
    if (!supported?.has(key)) invalidSchema(`${path}.${key} 不是受支持的 Schema 关键字。`)
  }
}

/** @param {unknown} value @param {string} path @returns {string} */
function schemaFieldName(value, path) {
  if (typeof value !== 'string' || !FIELD_NAME.test(value) || FORBIDDEN_FIELD_NAMES.has(value)) {
    invalidSchema(`${path} 的字段名无效。`)
  }
  return value
}

/**
 * @param {unknown} raw
 * @param {{ depth: number, fields: number }} state
 * @param {string} path
 * @returns {AgentStructuredSchema}
 */
function normalizeSchema(raw, state, path) {
  const source = record(raw)
  if (!source) invalidSchema(`${path} 必须是对象 Schema。`)
  if (state.depth > AGENT_STRUCTURED_CONTRACT_LIMITS.maxDepth) {
    invalidSchema(`${path} 超过最大 Schema 深度。`)
  }
  const type = source.type
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    invalidSchema(`${path}.type 不受支持。`)
  }
  assertSupportedKeys(source, type, path)

  if (type === 'object') {
    const rawProperties = source.properties === undefined ? {} : record(source.properties)
    if (!rawProperties) invalidSchema(`${path}.properties 必须是对象。`)
    const propertyNames = Object.keys(rawProperties).sort()
    state.fields += propertyNames.length
    if (state.fields > AGENT_STRUCTURED_CONTRACT_LIMITS.maxSchemaFields) {
      invalidSchema('结构化契约字段总数过多。')
    }
    if (propertyNames.length > AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields) {
      invalidSchema(`${path}.properties 字段过多。`)
    }
    /** @type {Record<string, AgentStructuredSchema>} */
    const properties = {}
    for (const rawName of propertyNames) {
      const name = schemaFieldName(rawName, `${path}.properties`)
      properties[name] = normalizeSchema(rawProperties[name], {
        depth: state.depth + 1,
        fields: state.fields,
      }, `${path}.properties.${name}`)
      // 子层累计字段要带回当前层，防止用多个兄弟节点绕过总量上限。
      state.fields += countSchemaFields(properties[name])
      if (state.fields > AGENT_STRUCTURED_CONTRACT_LIMITS.maxSchemaFields) {
        invalidSchema('结构化契约字段总数过多。')
      }
    }
    const rawRequired = source.required ?? []
    if (!Array.isArray(rawRequired)) invalidSchema(`${path}.required 必须是数组。`)
    const required = [...new Set(rawRequired.map((entry) => schemaFieldName(entry, `${path}.required`)))].sort()
    if (required.length !== rawRequired.length || required.some((name) => !Object.hasOwn(properties, name))) {
      invalidSchema(`${path}.required 必须是无重复的已声明字段。`)
    }
    if (source.additionalProperties !== undefined && typeof source.additionalProperties !== 'boolean') {
      invalidSchema(`${path}.additionalProperties 只支持布尔值。`)
    }
    const additionalProperties = source.additionalProperties === true
    const maximumDefault = additionalProperties
      ? AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields
      : propertyNames.length
    const minProperties = boundedInteger(
      source.minProperties,
      0,
      0,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields,
      `${path}.minProperties`,
    )
    const maxProperties = boundedInteger(
      source.maxProperties,
      maximumDefault,
      0,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields,
      `${path}.maxProperties`,
    )
    if (minProperties > maxProperties || required.length > maxProperties) {
      invalidSchema(`${path} 的对象字段上下限互相冲突。`)
    }
    return /** @type {AgentStructuredObjectSchema} */ ({
      type,
      properties: deepFreeze(properties),
      required: Object.freeze(required),
      additionalProperties,
      minProperties,
      maxProperties,
    })
  }

  if (type === 'array') {
    if (source.items === undefined) invalidSchema(`${path}.items 不能为空。`)
    const minItems = boundedInteger(
      source.minItems,
      0,
      0,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxArrayItems,
      `${path}.minItems`,
    )
    const maxItems = boundedInteger(
      source.maxItems,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxArrayItems,
      0,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxArrayItems,
      `${path}.maxItems`,
    )
    if (minItems > maxItems) invalidSchema(`${path} 的数组长度上下限互相冲突。`)
    return { type, items: normalizeSchema(source.items, { depth: state.depth + 1, fields: state.fields }, `${path}.items`), minItems, maxItems }
  }

  if (type === 'string') {
    const minLength = boundedInteger(
      source.minLength,
      0,
      0,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxStringLength,
      `${path}.minLength`,
    )
    const maxLength = boundedInteger(
      source.maxLength,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxStringLength,
      0,
      AGENT_STRUCTURED_CONTRACT_LIMITS.maxStringLength,
      `${path}.maxLength`,
    )
    if (minLength > maxLength) invalidSchema(`${path} 的字符串长度上下限互相冲突。`)
    let enumValues
    if (source.enum !== undefined) {
      if (!Array.isArray(source.enum) || !source.enum.length
        || source.enum.length > AGENT_STRUCTURED_CONTRACT_LIMITS.maxEnumValues
        || source.enum.some((entry) => typeof entry !== 'string'
          || entry.length < minLength || entry.length > maxLength)) {
        invalidSchema(`${path}.enum 无效。`)
      }
      enumValues = [...new Set(source.enum)].sort()
      if (enumValues.length !== source.enum.length) invalidSchema(`${path}.enum 不能重复。`)
    }
    return {
      type,
      minLength,
      maxLength,
      ...(enumValues ? { enum: Object.freeze(enumValues) } : {}),
    }
  }

  if (type === 'number' || type === 'integer') {
    const minimum = source.minimum
    const maximum = source.maximum
    if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isFinite(minimum))) {
      invalidSchema(`${path}.minimum 必须是有限数字。`)
    }
    if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum))) {
      invalidSchema(`${path}.maximum 必须是有限数字。`)
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      invalidSchema(`${path} 的数字上下限互相冲突。`)
    }
    return {
      type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
    }
  }

  return { type }
}

/** @param {AgentStructuredSchema} schema */
function countSchemaFields(schema) {
  if (schema.type === 'object') {
    return Object.values(schema.properties).reduce((total, child) => total + 1 + countSchemaFields(child), 0)
  }
  if (schema.type === 'array') return countSchemaFields(schema.items)
  return 0
}

/**
 * 归一并冻结根对象 Schema。等价声明得到稳定顺序，供 capability hash 使用。
 *
 * @param {unknown} raw
 * @param {{ label?: string }} [options]
 * @returns {Readonly<AgentStructuredObjectSchema>}
 */
export function normalizeAgentStructuredObjectSchema(raw, options) {
  const label = typeof options?.label === 'string' && options.label.trim()
    ? options.label.trim().slice(0, 80)
    : '结构化契约'
  const normalized = normalizeSchema(raw, { depth: 0, fields: 0 }, label)
  if (normalized.type !== 'object') invalidSchema(`${label} 的根类型必须是 object。`)
  return /** @type {Readonly<AgentStructuredObjectSchema>} */ (deepFreeze(normalized))
}

/** @param {string} path @param {string} key */
function valuePath(path, key) {
  return FIELD_NAME.test(key) ? `${path}.${key}` : `${path}[字段]`
}

/** @param {{ nodes: number }} state @param {number} depth @param {string} path */
function enterValue(state, depth, path) {
  state.nodes += 1
  if (state.nodes > AGENT_STRUCTURED_CONTRACT_LIMITS.maxValueNodes) {
    invalidValue('结构化值节点总数过多。')
  }
  if (depth > AGENT_STRUCTURED_CONTRACT_LIMITS.maxDepth) invalidValue(`${path} 嵌套过深。`)
}

/**
 * @param {unknown} value
 * @param {{ nodes: number, fields: number, arrayItems: number, ancestors: Set<object> }} state
 * @param {number} depth
 * @param {string} path
 * @returns {any}
 */
function projectGenericJson(value, state, depth, path) {
  enterValue(state, depth, path)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidValue(`${path} 必须是有限数字。`)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > AGENT_STRUCTURED_CONTRACT_LIMITS.maxStringLength) invalidValue(`${path} 字符串过长。`)
    return value
  }
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) invalidValue(`${path} 不能包含循环引用。`)
    if (value.length > AGENT_STRUCTURED_CONTRACT_LIMITS.maxArrayItems) invalidValue(`${path} 数组项过多。`)
    state.arrayItems += value.length
    if (state.arrayItems > AGENT_STRUCTURED_CONTRACT_LIMITS.maxTotalArrayItems) {
      invalidValue('结构化值数组项总数过多。')
    }
    state.ancestors.add(value)
    try {
      return value.map((entry, index) => projectGenericJson(entry, state, depth + 1, `${path}[${index}]`))
    } finally {
      state.ancestors.delete(value)
    }
  }
  const source = record(value)
  if (!source) invalidValue(`${path} 只允许 JSON 值。`)
  if (state.ancestors.has(source)) invalidValue(`${path} 不能包含循环引用。`)
  const keys = Object.keys(source)
  if (keys.length > AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields) invalidValue(`${path} 字段过多。`)
  state.fields += keys.length
  if (state.fields > AGENT_STRUCTURED_CONTRACT_LIMITS.maxTotalObjectFields) {
    invalidValue('结构化值字段总数过多。')
  }
  state.ancestors.add(source)
  try {
    return Object.fromEntries(keys.sort().map((key) => {
      if (key.length > 80 || /[\u0000-\u001f]/u.test(key) || FORBIDDEN_FIELD_NAMES.has(key)) {
        invalidValue(`${path} 含无效字段名。`)
      }
      return [key, projectGenericJson(source[key], state, depth + 1, valuePath(path, key))]
    }))
  } finally {
    state.ancestors.delete(source)
  }
}

/**
 * @param {AgentStructuredSchema} schema
 * @param {unknown} value
 * @param {{ nodes: number, fields: number, arrayItems: number, ancestors: Set<object> }} state
 * @param {number} depth
 * @param {string} path
 * @returns {any}
 */
function projectValue(schema, value, state, depth, path) {
  enterValue(state, depth, path)
  if (schema.type === 'object') {
    const source = record(value)
    if (!source) invalidValue(`${path} 必须是对象。`)
    if (state.ancestors.has(source)) invalidValue(`${path} 不能包含循环引用。`)
    const sourceKeys = Object.keys(source)
    if (sourceKeys.length > AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields) invalidValue(`${path} 字段过多。`)
    state.fields += sourceKeys.length
    if (state.fields > AGENT_STRUCTURED_CONTRACT_LIMITS.maxTotalObjectFields) {
      invalidValue('结构化值字段总数过多。')
    }
    for (const name of schema.required) {
      if (!Object.hasOwn(source, name)) invalidValue(`${valuePath(path, name)} 缺失。`)
    }
    state.ancestors.add(source)
    try {
      /** @type {[string, any][]} */
      const entries = []
      for (const name of Object.keys(schema.properties)) {
        if (!Object.hasOwn(source, name)) continue
        entries.push([name, projectValue(schema.properties[name], source[name], state, depth + 1, valuePath(path, name))])
      }
      if (schema.additionalProperties) {
        for (const name of sourceKeys.sort()) {
          if (Object.hasOwn(schema.properties, name)) continue
          if (name.length > 80 || /[\u0000-\u001f]/u.test(name) || FORBIDDEN_FIELD_NAMES.has(name)) {
            invalidValue(`${path} 含无效字段名。`)
          }
          entries.push([name, projectGenericJson(source[name], state, depth + 1, valuePath(path, name))])
        }
      }
      if (entries.length < schema.minProperties || entries.length > schema.maxProperties) {
        invalidValue(`${path} 投影后的字段数量不符合契约。`)
      }
      return Object.fromEntries(entries)
    } finally {
      state.ancestors.delete(source)
    }
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) invalidValue(`${path} 必须是数组。`)
    if (state.ancestors.has(value)) invalidValue(`${path} 不能包含循环引用。`)
    if (value.length < schema.minItems || value.length > schema.maxItems) {
      invalidValue(`${path} 数组长度不符合契约。`)
    }
    state.arrayItems += value.length
    if (state.arrayItems > AGENT_STRUCTURED_CONTRACT_LIMITS.maxTotalArrayItems) {
      invalidValue('结构化值数组项总数过多。')
    }
    state.ancestors.add(value)
    try {
      return value.map((entry, index) => projectValue(schema.items, entry, state, depth + 1, `${path}[${index}]`))
    } finally {
      state.ancestors.delete(value)
    }
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') invalidValue(`${path} 必须是字符串。`)
    if (value.length < schema.minLength || value.length > schema.maxLength) {
      invalidValue(`${path} 字符串长度不符合契约。`)
    }
    if (schema.enum && !schema.enum.includes(value)) invalidValue(`${path} 不在允许取值内。`)
    return value
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (schema.type === 'integer' && !Number.isInteger(value))) {
      invalidValue(`${path} 必须是${schema.type === 'integer' ? '整数' : '有限数字'}。`)
    }
    if (schema.minimum !== undefined && value < schema.minimum) invalidValue(`${path} 小于最小值。`)
    if (schema.maximum !== undefined && value > schema.maximum) invalidValue(`${path} 大于最大值。`)
    return value
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') invalidValue(`${path} 必须是布尔值。`)
    return value
  }
  if (value !== null) invalidValue(`${path} 必须是 null。`)
  return null
}

/**
 * 校验并投影结构化值。未声明字段在 closed object 中被丢弃；open object 仍受统一
 * 深度、字段、数组和字符串硬上限保护。返回全新 JSON 值，不复用调用方引用。
 *
 * @param {AgentStructuredObjectSchema} schema
 * @param {unknown} value
 * @param {{ label?: string }} [options]
 * @returns {Record<string, any>}
 */
export function projectAgentStructuredObject(schema, value, options) {
  if (!schema || schema.type !== 'object' || !Object.isFrozen(schema)) {
    invalidSchema('结构化值投影必须使用已归一冻结的对象 Schema。')
  }
  const label = typeof options?.label === 'string' && options.label.trim()
    ? options.label.trim().slice(0, 80)
    : 'value'
  return projectValue(schema, value, {
    nodes: 0,
    fields: 0,
    arrayItems: 0,
    ancestors: new Set(),
  }, 0, label)
}
