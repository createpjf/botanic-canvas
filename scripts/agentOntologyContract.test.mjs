import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createBotanicAgentOperationalToolDefinitions } from '../server/agent/tools/botanicAgentOperationalTools.mjs'

const canvas = readFileSync(new URL('../src/domain/canvas.ts', import.meta.url), 'utf8')
const ontology = readFileSync(new URL('../server/skills/botanic-agent/ONTOLOGY.md', import.meta.url), 'utf8')

/**
 * 模型不需要知道的纯机制字段：版本号、时间戳、视口和「当前选中什么」的本地指针。
 * 写进本体只会让模型以为自己能读到它们，所以显式豁免；每一项都会被下面的测试校验仍然存在，
 * 字段改名时豁免名单不会悄悄失效。
 */
const undocumentedFields = Object.freeze({
  schemaVersion: '文档版本号，迁移用',
  id: '项目 ID，本体里用 project 表达',
  name: '项目名，本体里用 project 表达',
  viewport: '画布视口，属于界面状态',
  activeAgentSessionId: '当前会话指针，系统自己维护',
  activeTemplateId: '当前模板指针，系统自己维护',
  activeVersionId: '当前版本指针，系统自己维护',
  updatedAt: '更新时间戳',
})

function canvasDocumentFields() {
  const start = canvas.indexOf('export type CanvasDocument = {')
  assert.notEqual(start, -1, '找不到 CanvasDocument 定义')
  const end = canvas.indexOf('\n}', start)
  assert.notEqual(end, -1, 'CanvasDocument 定义没有闭合')
  const body = canvas.slice(start, end)
  const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1])
  assert.ok(fields.length > 10, `解析到的字段太少：${fields.length}`)
  return fields
}

test('项目本体覆盖 CanvasDocument 的每个实体字段', () => {
  const missing = canvasDocumentFields()
    .filter((field) => !(field in undocumentedFields))
    .filter((field) => !ontology.includes(`\`${field}\``))
  assert.deepEqual(
    missing,
    [],
    `这些字段在 CanvasDocument 里存在但本体没提：${missing.join('、')}。要么写进 ONTOLOGY.md，要么加进豁免名单并说明原因`,
  )
})

test('本体的豁免名单不会随字段改名失效', () => {
  const fields = new Set(canvasDocumentFields())
  const stale = Object.keys(undocumentedFields).filter((field) => !fields.has(field))
  assert.deepEqual(stale, [], `豁免名单里的字段已经不存在：${stale.join('、')}`)
})

test('本体对检索能力的描述与运维只读工具目录一致，且保持条件式', () => {
  const start = ontology.indexOf('检索能力以本轮工具列表为准')
  assert.notEqual(start, -1, '本体缺少检索能力说明段')
  const paragraph = ontology.slice(start)

  // 运维工具只在注入读取器的链路（回合）存在，对话链路没有。因此本体必须写成
  // 「本轮给出对应工具时可查」的条件式，不得断言这些工具恒在或恒不在 ——
  // 硬枚举「没有检索工具」正是 Epic 4 之后烂掉的那句。
  assert.doesNotMatch(paragraph, /当前没有检索工具/)
  assert.match(paragraph, /本轮/)

  // 全部读取器就位时暴露的工具名必须逐一出现在本体里；新增运维只读工具而没同步
  // ONTOLOGY.md 时这里会失败。文档写规则，工具列表写存在性，两边不许脱节。
  const readers = {
    readRun: async () => undefined,
    readJob: async () => undefined,
    searchArtifacts: async () => [],
    readReviews: async () => [],
    readWorkflowRun: async () => undefined,
    readDeliveries: async () => [],
  }
  const toolNames = createBotanicAgentOperationalToolDefinitions(readers).map((tool) => tool.name)
  assert.ok(toolNames.length >= 6, `运维只读工具少于预期：${toolNames.length}`)
  for (const name of toolNames) {
    assert.match(paragraph, new RegExp(name), `运维工具 ${name} 没有写进本体的检索能力说明`)
  }

  // 仍然没有读取工具的实体必须写明只有系统主动给出时才可知，避免模型声称查过。
  for (const field of ['batchVariationRuns', 'templates', 'history', 'brandKit', 'productionWorkflows']) {
    assert.match(paragraph, new RegExp(`\`${field}\``), `${field} 没有检索工具，必须写明只有系统给出时才可知`)
  }
})
