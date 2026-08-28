import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_STRUCTURED_CONTRACT_LIMITS,
  normalizeAgentStructuredObjectSchema,
  projectAgentStructuredObject,
} from './agentStructuredContract.mjs'

test('结构化契约归一排序并深冻结，closed object 只投影声明字段', () => {
  const schema = normalizeAgentStructuredObjectSchema({
    required: ['title', 'mode'],
    properties: {
      title: { maxLength: 20, minLength: 1, type: 'string' },
      mode: { enum: ['video', 'image'], type: 'string' },
      options: {
        type: 'object',
        properties: { count: { maximum: 8, minimum: 1, type: 'integer' } },
      },
    },
    additionalProperties: false,
    type: 'object',
  })

  assert.equal(Object.isFrozen(schema), true)
  assert.equal(Object.isFrozen(schema.properties), true)
  assert.equal(Object.isFrozen(schema.properties.options), true)
  assert.deepEqual(Object.keys(schema.properties), ['mode', 'options', 'title'])
  assert.deepEqual(schema.properties.mode.enum, ['image', 'video'])
  const source = {
    title: '夏季 Campaign',
    mode: 'image',
    options: { count: 2, private: 'drop' },
    providerSecret: 'drop',
  }
  assert.deepEqual(projectAgentStructuredObject(schema, source), {
    mode: 'image',
    options: { count: 2 },
    title: '夏季 Campaign',
  })
  assert.equal(source.options.private, 'drop')
})

test('结构化契约拒绝未支持关键字、非法 required、非 object 根和过深 Schema', () => {
  assert.throws(() => normalizeAgentStructuredObjectSchema({
    type: 'object', oneOf: [],
  }), (error) => error.code === 'AGENT_STRUCTURED_SCHEMA_INVALID')
  assert.throws(() => normalizeAgentStructuredObjectSchema({
    type: 'object', required: ['missing'], properties: {},
  }), /required/u)
  assert.throws(() => normalizeAgentStructuredObjectSchema({ type: 'array', items: { type: 'string' } }), /根类型/u)

  let nested = { type: 'string' }
  for (let index = 0; index < AGENT_STRUCTURED_CONTRACT_LIMITS.maxDepth + 1; index += 1) {
    nested = { type: 'object', properties: { child: nested } }
  }
  assert.throws(() => normalizeAgentStructuredObjectSchema(nested), /深度/u)
})

test('结构化契约在归一阶段限制字段、数组与字符串声明上限', () => {
  assert.throws(() => normalizeAgentStructuredObjectSchema({
    type: 'object',
    properties: Object.fromEntries(Array.from(
      { length: AGENT_STRUCTURED_CONTRACT_LIMITS.maxSchemaFields + 1 },
      (_, index) => [`field_${index}`, { type: 'string' }],
    )),
  }), /字段/u)
  assert.throws(() => normalizeAgentStructuredObjectSchema({
    type: 'object',
    properties: {
      values: {
        type: 'array',
        maxItems: AGENT_STRUCTURED_CONTRACT_LIMITS.maxArrayItems + 1,
        items: { type: 'string' },
      },
    },
  }), /maxItems/u)
  assert.throws(() => normalizeAgentStructuredObjectSchema({
    type: 'object',
    properties: {
      value: { type: 'string', maxLength: AGENT_STRUCTURED_CONTRACT_LIMITS.maxStringLength + 1 },
    },
  }), /maxLength/u)
})

test('结构化值严格校验 required/type/enum/长度，不做隐式数字转换', () => {
  const schema = normalizeAgentStructuredObjectSchema({
    type: 'object',
    required: ['count', 'mode', 'labels'],
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 3 },
      mode: { type: 'string', enum: ['safe'] },
      labels: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', maxLength: 4 } },
    },
  })
  assert.throws(() => projectAgentStructuredObject(schema, { mode: 'safe', labels: ['a'], count: '2' }), /整数/u)
  assert.throws(() => projectAgentStructuredObject(schema, { mode: 'unsafe', labels: ['a'], count: 2 }), /允许取值/u)
  assert.throws(() => projectAgentStructuredObject(schema, { mode: 'safe', labels: [], count: 2 }), /数组长度/u)
  assert.throws(() => projectAgentStructuredObject(schema, { mode: 'safe', labels: ['longer'], count: 2 }), /字符串长度/u)
  assert.throws(() => projectAgentStructuredObject(schema, { mode: 'safe', count: 2 }), /labels 缺失/u)
})

test('open object 兼容旧工具但仍限制循环、非 JSON、深度和总量', () => {
  const schema = normalizeAgentStructuredObjectSchema({ type: 'object', additionalProperties: true })
  assert.deepEqual(projectAgentStructuredObject(schema, {
    query: '海边',
    nested: { ok: true },
    values: [1, null, false],
  }), {
    nested: { ok: true },
    query: '海边',
    values: [1, null, false],
  })

  const cycle = {}
  cycle.self = cycle
  assert.throws(() => projectAgentStructuredObject(schema, cycle), /循环引用/u)
  assert.throws(() => projectAgentStructuredObject(schema, { createdAt: new Date() }), /JSON 值/u)
  assert.throws(() => projectAgentStructuredObject(schema, {
    values: Array.from({ length: AGENT_STRUCTURED_CONTRACT_LIMITS.maxArrayItems + 1 }, () => 1),
  }), /数组项过多/u)
  const manyFields = Object.fromEntries(Array.from(
    { length: AGENT_STRUCTURED_CONTRACT_LIMITS.maxObjectFields },
    (_, index) => [`field_${index}`, index],
  ))
  assert.throws(() => projectAgentStructuredObject(schema, {
    first: manyFields,
    second: manyFields,
  }), /字段总数/u)

  let nested = 'leaf'
  for (let index = 0; index < AGENT_STRUCTURED_CONTRACT_LIMITS.maxDepth + 1; index += 1) {
    nested = { child: nested }
  }
  assert.throws(() => projectAgentStructuredObject(schema, nested), /嵌套过深/u)
})
