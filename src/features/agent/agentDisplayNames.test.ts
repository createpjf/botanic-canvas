import assert from 'node:assert/strict'
import test from 'node:test'
import type { BotanicAgentArtifact, BotanicAgentRun } from '../../domain/agent.ts'
import { agentArtifactDisplayName, agentTaskDisplayName } from './agentDisplayNames.ts'

const run = {
  id: 'run-1', createdAt: 1788663270609,
  plan: { title: '新图', summary: '根据文字描述直接生成 2 张图片。', prompt: '绿色银杏叶放在米白背景上。柔和自然光。' },
  branches: [{ id: 'branch-1', jobIds: ['job-1', 'job-retry'] }],
} as BotanicAgentRun
const result = (number: number): BotanicAgentArtifact => ({
  id: `generation:job-1:job-1-output-${number}`, kind: 'image', label: '新图',
  metadata: { branchId: 'branch-1', jobId: 'job-1', prompt: run.plan.prompt },
  provenance: { actionId: 'generation:job-1', toolName: 'image_generation', runId: run.id },
})

test('通用任务名展示固定计划内容；多图编号不随分页、筛选和补图顺序变化', () => {
  assert.equal(agentTaskDisplayName(run), '绿色银杏叶放在米白背景上');
  const second = result(2)
  assert.equal(agentArtifactDisplayName(second, run), '绿色银杏叶放在米白背景上 · 02')
  assert.deepEqual([second, result(1)].map(a => agentArtifactDisplayName(a, run)), [
    '绿色银杏叶放在米白背景上 · 02', '绿色银杏叶放在米白背景上 · 01',
  ])
  assert.equal(agentArtifactDisplayName(second), '绿色银杏叶放在米白背景上 · 02')
  assert.equal(run.plan.title, '新图')
  assert.equal(second.label, '新图')
  assert.equal(agentArtifactDisplayName({ ...result(1), label: '生成候选 1', metadata: { ...result(1).metadata, jobId: 'job-retry' } }, run), '绿色银杏叶放在米白背景上 · 补图 1 · 01')
})

test('保留自定义名称与英文单词；缺少计划安全回落，不显示技术ID', () => {
  assert.equal(agentArtifactDisplayName({ ...result(1), label: 'Spring Campaign — Final 01' }, run), 'Spring Campaign — Final 01')
  assert.equal(agentTaskDisplayName({ ...run, plan: { ...run.plan, title: 'Generate', prompt: 'A green leaf on an ivory background. Soft light.' } }, 'en'), 'A green leaf on an ivory background')
  assert.equal(agentArtifactDisplayName({ ...result(1), metadata: undefined }, undefined, 'en'), 'Generated result · 01')
  assert.match(agentTaskDisplayName({ ...run, plan: { ...run.plan, title: '', summary: '', prompt: '' } }), /^生成任务 · /)
})
