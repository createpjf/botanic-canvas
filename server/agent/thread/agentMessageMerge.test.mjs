// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeAgentMessageForWrite } from './agentMessageMerge.mjs'

test('同一确认已回答后晚到 pending 不重开，时钟领先的 pending 也不能拒收答案', () => {
  const pending = { id: 'question-message', role: 'assistant', kind: 'question', status: 'pending', createdAt: 1, updatedAt: 100,
    question: { id: 'question-1', fields: [{ id: 'resolution', defaultValue: '2K' }] } }
  const answered = { ...pending, status: 'answered', updatedAt: 20,
    question: { id: 'question-1', fields: [{ id: 'resolution', defaultValue: '1K' }] } }
  const accepted = mergeAgentMessageForWrite(pending, answered).message
  assert.equal(accepted.status, 'answered')
  assert.equal(accepted.question.fields[0].defaultValue, '1K')
  const replayed = mergeAgentMessageForWrite(accepted, { ...pending, updatedAt: 200 }).message
  assert.equal(replayed.status, 'answered')
  assert.equal(replayed.question.fields[0].defaultValue, '1K')
  assert.equal(replayed.updatedAt, 200)
  const nextQuestion = mergeAgentMessageForWrite(accepted, { ...pending, updatedAt: 300, question: { id: 'another-question' } }).message
  assert.equal(nextQuestion.status, 'pending')
  assert.throws(() => mergeAgentMessageForWrite(nextQuestion, { ...answered, updatedAt: 9000 }), {
    code: 'AGENT_MESSAGE_ANSWER_CONFLICT', statusCode: 409,
  }, '旧题答案不能覆盖当前问题，即使旧设备时钟领先')
})

const projection = (status, updatedAt, content = status) => ({
  id: 'agent-turn-result-turn-terminal-lww',
  role: 'assistant',
  kind: 'notice',
  content,
  status,
  turnId: 'turn-terminal-lww',
  createdAt: 10,
  updatedAt,
})

const requestSnapshot = {
  locale: 'zh-CN',
  contextNodeIds: ['result-a'],
  hasTarget: true,
  selectedResultNodeId: 'result-a',
  selectedResultLabel: '结果 A',
  executionMode: 'auto',
}

const requestMentions = [{ kind: 'skill', id: 'skill-a', name: 'Skill A' }]

test('同一确认不同答案冲突，相同答案重放保留首次采用的正文', () => {
  const current = { ...projection('answered', 100), kind: 'question', question: {
    id: 'q', originalInstruction: '生成海边图片', fields: [{ id: 'resolution', defaultValue: '2K', label: '清晰度' }],
  } }
  const replay = { ...current, content: '旧设备正文', updatedAt: 200,
    question: { ...current.question, fields: [{ id: 'resolution', defaultValue: '2K', label: 'Resolution' }] } }
  assert.equal(mergeAgentMessageForWrite(current, replay).message.content, current.content)
  assert.throws(() => mergeAgentMessageForWrite(current, { ...replay,
    question: { ...replay.question, fields: [{ id: 'resolution', defaultValue: '1K' }] },
  }), { code: 'AGENT_MESSAGE_ANSWER_CONFLICT', statusCode: 409 })
})

test('同一 Turn 的后续计划不被旧问题回退，failed 终态保护仍优先', () => {
  const question = { ...projection('answered', 9000), kind: 'question', question: { id: 'q', fields: [] } }
  const plan = { ...projection('pending', 100), kind: 'plan', plan: { turnId: question.turnId } }
  const advanced = mergeAgentMessageForWrite(question, plan).message
  assert.equal(advanced.kind, 'plan')
  assert.equal(mergeAgentMessageForWrite(advanced, { ...question, updatedAt: 10000 }).message.kind, 'plan')
  assert.equal(mergeAgentMessageForWrite({ ...question, status: 'failed' }, plan).message.status, 'failed')
  const localQuestion = { ...question, id: 'prompt-question', turnId: undefined }
  const prompt = { ...localQuestion, kind: 'text', question: undefined, prompt: '香水广告', updatedAt: 100 }
  assert.equal(mergeAgentMessageForWrite(localQuestion, prompt).message.prompt, prompt.prompt)
  assert.equal(mergeAgentMessageForWrite(prompt, localQuestion).message.kind, 'text')
})

test('稳定 Turn 投影 failed 跨设备单调覆盖 answered，客户端时钟不能反转终态', () => {
  const failed = mergeAgentMessageForWrite(
    projection('answered', 9_000, '未来时钟的成功'),
    projection('failed', 100, '权威取消'),
    { currentUpdatedAt: 9_000, incomingUpdatedAt: 100 },
  )
  assert.equal(failed.message.status, 'failed')
  assert.equal(failed.message.content, '权威取消')
  assert.equal(failed.message.updatedAt, 9_000, '终态正文胜出时 payload 时间仍不得回退')
  assert.equal(failed.updatedAt, 9_000)

  const lateAnswered = mergeAgentMessageForWrite(
    failed.message,
    projection('answered', 10_000, '迟到成功'),
    { currentUpdatedAt: failed.updatedAt, incomingUpdatedAt: 10_000 },
  )
  assert.equal(lateAnswered.message.status, 'failed')
  assert.equal(lateAnswered.message.content, '权威取消')
  assert.equal(lateAnswered.message.updatedAt, 10_000, '丢弃迟到正文也要单调推进版本时间')
  assert.equal(lateAnswered.updatedAt, 10_000)
})

test('普通 Message 仍按版本 LWW，failed 优先级只属于稳定 Turn 投影', () => {
  const current = { ...projection('answered', 200, '新正文'), id: 'ordinary-message' }
  const incoming = { ...projection('failed', 100, '旧失败'), id: 'ordinary-message' }
  const merged = mergeAgentMessageForWrite(current, incoming, {
    currentUpdatedAt: 200,
    incomingUpdatedAt: 100,
  })
  assert.equal(merged.message.status, 'answered')
  assert.equal(merged.message.content, '新正文')
  assert.equal(merged.message.updatedAt, 200)
})

test('turnRequestSnapshot 可首次补写、旧 writer 遗漏时保留、改绑时 fail-closed', () => {
  const base = {
    id: 'message-sticky-snapshot', role: 'user', kind: 'text', content: '继续',
    mentions: requestMentions, createdAt: 10, updatedAt: 300,
  }
  for (const mismatchedFirstBinding of [
    { ...base, content: '另一条请求正文', updatedAt: 100, turnRequestSnapshot: requestSnapshot },
    {
      ...base,
      mentions: [{ kind: 'skill', id: 'skill-b', name: 'Skill B' }],
      updatedAt: 100,
      turnRequestSnapshot: requestSnapshot,
    },
  ]) {
    assert.throws(() => mergeAgentMessageForWrite(base, mismatchedFirstBinding, {
      currentUpdatedAt: 300,
      incomingUpdatedAt: 100,
    }), (error) => /** @type {any} */ (error)?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
  }
  const firstBound = mergeAgentMessageForWrite(base, {
    ...base, updatedAt: 100, turnRequestSnapshot: requestSnapshot,
  }, { currentUpdatedAt: 300, incomingUpdatedAt: 100 })
  assert.equal(firstBound.message.content, '继续')
  assert.deepEqual(firstBound.message.turnRequestSnapshot, requestSnapshot)
  assert.equal(firstBound.message.updatedAt, 300)

  const omitted = mergeAgentMessageForWrite(firstBound.message, {
    ...base, status: 'pending', updatedAt: 400,
  }, { currentUpdatedAt: 300, incomingUpdatedAt: 400 })
  assert.equal(omitted.message.content, '继续')
  assert.equal(omitted.message.status, 'pending')
  assert.deepEqual(omitted.message.turnRequestSnapshot, requestSnapshot)

  for (const drift of [
    { ...base, content: '漂移后的正文', updatedAt: 500 },
    { ...base, mentions: [{ kind: 'skill', id: 'skill-b', name: 'Skill B' }], updatedAt: 500 },
    { ...base, kind: 'notice', updatedAt: 500 },
    { ...base, createdAt: 11, updatedAt: 500 },
  ]) {
    assert.throws(() => mergeAgentMessageForWrite(omitted.message, drift, {
      currentUpdatedAt: 400,
      incomingUpdatedAt: 500,
    }), (error) => /** @type {any} */ (error)?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT')
  }

  assert.throws(() => mergeAgentMessageForWrite(omitted.message, {
    ...base,
    updatedAt: 500,
    turnRequestSnapshot: { ...requestSnapshot, selectedResultNodeId: 'result-b', contextNodeIds: ['result-b'] },
  }, { currentUpdatedAt: 400, incomingUpdatedAt: 500 }), (error) => (
    /** @type {any} */ (error)?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT'
  ))
})

test('服务端目标版本绑定在旧 writer 遗漏时保留，其他请求身份仍不可改绑', () => {
  const targetBinding = {
    version: 1,
    nodeId: 'result-a',
    nodeRevision: 'node-revision-a',
    artifactId: 'generation:job-a:candidate-a',
    generationJobId: 'job-a',
    candidateId: 'candidate-a',
    versionId: 'version-a',
    mediaSha256: 'a'.repeat(64),
    boundAt: 100,
  }
  const current = {
    id: 'message-target-bound', role: 'user', kind: 'text', content: '继续',
    createdAt: 10, updatedAt: 20,
    turnRequestSnapshot: { ...requestSnapshot, targetBinding },
  }
  const merged = mergeAgentMessageForWrite(current, {
    ...current,
    updatedAt: 30,
    turnRequestSnapshot: requestSnapshot,
  }, { currentUpdatedAt: 20, incomingUpdatedAt: 30 })

  assert.deepEqual(merged.message.turnRequestSnapshot, current.turnRequestSnapshot)
  assert.throws(() => mergeAgentMessageForWrite(current, {
    ...current,
    updatedAt: 30,
    turnRequestSnapshot: { ...requestSnapshot, contextNodeIds: ['result-b'] },
  }, { currentUpdatedAt: 20, incomingUpdatedAt: 30 }), (error) => (
    /** @type {any} */ (error)?.code === 'AGENT_MESSAGE_TURN_REQUEST_CONFLICT'
  ))
})

test('Message role 不可改绑，createdAt 首次绑定保留；无 snapshot 投影的 kind 仍可演进', () => {
  const current = {
    id: 'agent-turn-result-turn-role', role: 'assistant', kind: 'notice', content: '执行中',
    turnId: 'turn-role', status: 'failed', createdAt: 50, updatedAt: 100,
  }
  assert.throws(() => mergeAgentMessageForWrite(current, {
    ...current, role: 'user', status: 'answered', content: '伪造成功', createdAt: 900, updatedAt: 900,
  }, { currentUpdatedAt: 100, incomingUpdatedAt: 900 }), (error) => (
    /** @type {any} */ (error)?.code === 'AGENT_MESSAGE_ROLE_CONFLICT'
  ))

  const evolved = mergeAgentMessageForWrite(
    { ...current, status: 'answered' },
    { ...current, kind: 'plan', content: '完整方案', status: 'answered', createdAt: 900, updatedAt: 200 },
    { currentUpdatedAt: 100, incomingUpdatedAt: 200 },
  )
  assert.equal(evolved.message.role, 'assistant')
  assert.equal(evolved.message.createdAt, 50, '跨设备同 ID 首次创建时间不能被正文更新重排')
  assert.equal(evolved.message.kind, 'plan', 'kind 是投影正文形态，不是不可变作者身份')
})

test('稳定 Turn 投影的服务端 entityReferences 不被旧 writer 遗漏清空，冲突引用 fail-closed', () => {
  const references = [
    { type: 'agent_run', id: 'run-1' },
    { type: 'artifact', id: 'artifact-1' },
  ]
  const current = { ...projection('answered', 100, '完成'), entityReferences: references }

  const omitted = mergeAgentMessageForWrite(current, projection('answered', 200, '旧客户端重写正文'), {
    currentUpdatedAt: 100,
    incomingUpdatedAt: 200,
  })
  assert.deepEqual(omitted.message.entityReferences, references)

  const firstBackfill = mergeAgentMessageForWrite(
    projection('answered', 300, '已有正文'),
    { ...projection('answered', 100, '权威回填'), entityReferences: references },
    { currentUpdatedAt: 300, incomingUpdatedAt: 100 },
  )
  assert.deepEqual(firstBackfill.message.entityReferences, references)

  assert.throws(() => mergeAgentMessageForWrite(current, {
    ...projection('answered', 200, '伪造引用'),
    entityReferences: [{ type: 'agent_run', id: 'run-forged' }],
  }, { currentUpdatedAt: 100, incomingUpdatedAt: 200 }), (caught) => (
    /** @type {any} */ (caught)?.code === 'AGENT_MESSAGE_ENTITY_REFERENCES_CONFLICT'
  ))
})

test('稳定 Turn 投影的服务端 provenance 不被旧 writer 清空或改绑', () => {
  const provenance = {
    sourceMessageId: 'message-a',
    sourceNodeIds: ['node-a'],
    targetArtifactVersionId: 'version-a',
    planFingerprint: 'plan-a',
  }
  const current = { ...projection('answered', 100, '回答 A'), ...provenance }
  const omitted = mergeAgentMessageForWrite(current, projection('answered', 200, '旧客户端正文'), {
    currentUpdatedAt: 100,
    incomingUpdatedAt: 200,
  })
  assert.deepEqual(Object.fromEntries(Object.keys(provenance).map((key) => [key, omitted.message[key]])), provenance)

  assert.throws(() => mergeAgentMessageForWrite(current, {
    ...projection('answered', 300, '伪造来源'), sourceNodeIds: ['node-b'],
  }, { currentUpdatedAt: 100, incomingUpdatedAt: 300 }), (caught) => (
    /** @type {any} */ (caught)?.code === 'AGENT_MESSAGE_PROVENANCE_CONFLICT'
  ))
})
