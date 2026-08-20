import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

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

test('没有检索工具的实体必须在本体里写明读不到，避免模型声称查过', () => {
  const paragraph = ontology.slice(ontology.indexOf('只读工具只覆盖'))
  assert.ok(paragraph, '本体缺少只读工具覆盖范围说明')
  for (const field of ['generationJobs', 'agentRuns', 'templates', 'deliveries', 'productionWorkflows']) {
    assert.match(paragraph, new RegExp(`\`${field}\``), `${field} 没有检索工具，必须写明读不到`)
  }
})
