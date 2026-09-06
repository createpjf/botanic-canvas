import assert from 'node:assert/strict'
import { loadAgentTaskForFocus } from './agentTaskFocus.ts'
import type { BotanicAgentRunSnapshot } from '../../domain/agent.ts'
import test from 'node:test'
import type { BotanicAgentMessage, BotanicAgentSession } from '../../domain/agent.ts'
import { submitAgentClarification } from './agentClarificationSubmission.ts'
import { resolveBotanicAgentContinuationTarget } from '../../domain/agentTurnObservation.ts'

test('任务定位只投影准确 Run；迟到、缺失和跨项目结果不写入当前项目', async () => {
  const run = { id: 'target', projectId: 'project-1' } as BotanicAgentRunSnapshot
  const applied: string[] = []
  const controller = new AbortController()
  const input = { projectId: 'project-1', runId: 'target', signal: controller.signal, isCurrent: () => true, apply: (run: BotanicAgentRunSnapshot) => { applied.push(run.id) }, read: async () => [run] }
  await loadAgentTaskForFocus(input)
  assert.deepEqual(applied, ['target'])
  await assert.rejects(loadAgentTaskForFocus({ ...input, read: async () => [] }), { code: 'AGENT_RUN_NOT_FOUND' })
  await assert.rejects(loadAgentTaskForFocus({ ...input, read: async () => [{ ...run, projectId: 'other' }] }), { code: 'AGENT_RUN_PROJECT_MISMATCH' })
  controller.abort()
  await loadAgentTaskForFocus(input)
  assert.deepEqual(applied, ['target'])
})

const question = (): BotanicAgentMessage => ({
  id: 'question-1', role: 'assistant', kind: 'question', status: 'pending', content: '', createdAt: 1,
  turnId: 'turn-1', question: {
    id: 'settings-1', originalInstruction: '生成海边图片', question: '清晰度',
    fields: [{ id: 'resolution', label: '清晰度', control: 'single_choice', required: true, defaultValue: '1K', options: [{ value: '1K', label: '1K' }, { value: '2K', label: '2K' }] }],
  },
})
const session = (message: BotanicAgentMessage): BotanicAgentSession => ({
  id: 'session-1', title: '海边图片', executionMode: 'manual', createdAt: 1, updatedAt: 1, contextNodeIds: [], messages: [{
    id: 'input-1', role: 'user', kind: 'text', content: '生成海边图片', createdAt: 0, turnId: 'turn-1',
    turnRequestSnapshot: { locale: 'zh-CN', contextNodeIds: [], hasTarget: false, selectedResultNodeId: null, plannerModel: 'original-model', executionMode: 'manual' },
  }, message],
})

test('同一确认先可靠保存，再接续原 Turn；连点不会产生第二次提交', async () => {
  const message = question()
  const originalInput: BotanicAgentMessage = {
    id: 'input-1', role: 'user', kind: 'text', content: '生成海边图片', createdAt: 0, turnId: 'turn-1',
    turnRequestSnapshot: { locale: 'zh-CN', contextNodeIds: [], hasTarget: false, selectedResultNodeId: null, plannerModel: 'original-model', executionMode: 'manual' },
  }
  const events: string[] = []
  let release!: () => void
  const saving = new Promise<void>((resolve) => { release = resolve })
  const input: Parameters<typeof submitAgentClarification>[0] = {
    session: { ...session(message), messages: [originalInput, message] }, message, answers: { resolution: '2K' }, generationModels: [], runs: [], locale: 'zh-CN',
    contextOptions: [], plannerModel: 'newly-selected-model',
    inFlight: new Set(), isCurrent: () => true, retryMessage: () => {},
    ensureMessageDurable: async (saved) => {
      events.push(saved.kind)
      if (saved.kind === 'question') {
        await saving
        return { ...saved, question: { ...saved.question!, resolvedGeneration: { mediaKind: 'image', prompt: '服务端确认的海边图片', turnId: 'turn-1' } } }
      }
      assert.equal(saved.turnId, 'turn-1')
      assert.equal(saved.sourceMessageId, 'input-1')
      return { ...saved, content: '服务端已保存答案', createdAt: 123 }
    },
    onUpdateMessage: (_sessionId, _id, patch) => { assert.equal(patch.question?.fields[0].defaultValue, '2K'); events.push('accepted') },
    continueInstruction: async (instruction, options) => {
      assert.equal(instruction, message.question?.originalInstruction)
      assert.equal(options.sourceTurnId, 'turn-1')
      assert.equal(options.executionSnapshot?.plannerModel, 'original-model')
      assert.equal(options.executionSnapshot?.targetNodeId, null)
      assert.equal(options.clarificationAnswers?.resolution, '2K')
      assert.equal(options.clarificationId, 'settings-1')
      assert.equal(options.sourceMessageId, 'input-1')
      assert.equal(options.requestId, `agent-plan-${options.appendUserMessageId}`)
      assert.equal(options.appendUser, '服务端已保存答案')
      assert.equal(options.appendUserCreatedAt, 123)
      assert.deepEqual(options.resolvedGeneration, { mediaKind: 'image', prompt: '服务端确认的海边图片', turnId: 'turn-1' })
      events.push('continue')
    },
  }
  const first = submitAgentClarification(input)
  await submitAgentClarification(input)
  assert.ok(!events.includes('continue'))
  release()
  await first
  assert.deepEqual(events, ['question', 'accepted', 'text', 'continue'])
  assert.equal(input.inFlight.size, 0)
  await assert.rejects(() => submitAgentClarification({ ...input, message: { ...message, status: 'failed' },
    ensureMessageDurable: async () => assert.fail('失败的历史确认不得再次保存或执行'),
  }), /原请求无法接续/)
  const plannedMessage = { ...message, question: { ...message.question!, id: 'plan-clarification:turn-planner' } }
  let planReads = 0
  const plannedInput = {
    ...input, message: plannedMessage, session: session(plannedMessage),
    readTurn: async (id: string) => { planReads++; return id === 'turn-1' ? { id, status: 'completed' } : { id, status: 'waiting_user', result: { kind: 'clarification', runtimeOperation: 'plan', clarification: plannedMessage.question } } },
    continueInstruction: async () => {},
  }
  await submitAgentClarification(plannedInput)
  assert.equal(planReads, 2, '提交前核对原 Turn 和真实规划 Turn 的当前问题')
  await assert.rejects(() => submitAgentClarification({
    ...plannedInput, readTurn: async () => ({ id: 'turn-planner', status: 'cancelled' }),
    ensureMessageDurable: async (saved) => { assert.fail('取消的规划不能保存答案后继续'); return saved },
  }), /原确认/)
  await assert.rejects(() => submitAgentClarification({
    ...input, readTurn: async () => ({ id: 'turn-1', status: 'cancelled' }),
    ensureMessageDurable: async () => assert.fail('原 Turn 已取消，旧格式确认也不能继续'),
  }), /原确认/)
  const generationMessage = { ...message, question: { ...message.question!, resolvedGeneration: { turnId: 'turn-1', mediaKind: 'image' as const, prompt: '海边图片' } } }
  let continuedGeneration = false
  await submitAgentClarification({
    ...input, message: generationMessage,
    readTurn: async () => ({ id: 'turn-1', status: 'completed', result: { kind: 'generation', mediaKind: 'image', prompt: '海边图片' } }),
    continueInstruction: async () => { continuedGeneration = true },
  })
  assert.equal(continuedGeneration, true, '根生成决策已完成时，仍允许确认它的原设置')
  await submitAgentClarification({
    ...input, readTurn: async () => ({ id: 'turn-1', status: 'completed', linkedRunIds: ['run-existing'] }),
    ensureMessageDurable: async (saved) => { assert.equal(saved.runId, 'run-existing'); return saved },
    onUpdateMessage: (_session, _id, patch) => { assert.equal(patch.runId, 'run-existing') },
    continueInstruction: async () => assert.fail('已有任务时不得再次规划'),
  })
  await submitAgentClarification({
    ...input,
    ensureMessageDurable: async (saved) => ({ ...saved, kind: 'plan', question: undefined }),
    onUpdateMessage: () => assert.fail('已推进的服务端计划不能回写为旧问题'),
    continueInstruction: async () => assert.fail('已推进的服务端计划不能再次接续'),
  })
  const pages: (string | undefined)[] = []
  await submitAgentClarification({
    ...input, session: { ...input.session, messages: [message, { id: 'agent-answer-other', role: 'user', kind: 'text', content: '2K', turnId: 'turn-1', createdAt: 2 }] },
    loadMessages: async (before) => {
      pages.push(before)
      return before ? { messages: [originalInput] } : { messages: [message], nextBefore: 'older-page' }
    },
  })
  assert.deepEqual(pages, [undefined, 'older-page'])
  assert.equal(events.filter((event) => event === 'continue').length, 2)
  // 本地计划没有 Turn，但仍用确切的原输入身份和快照恢复，而非当前 Composer。
  await submitAgentClarification({
    ...input, message: { ...message, turnId: undefined, sourceMessageId: originalInput.id },
    ensureMessageDurable: async (saved) => saved,
    continueInstruction: async (_instruction, options) => {
      assert.equal(options.executionSnapshot?.plannerModel, 'original-model')
      assert.equal(options.clarificationMessageId, message.id)
    },
  })
  // 引用托盘可以没有缩略图；接续时仍保留原身份，实际目标由共同解析入口核对。
  const targetInput = { ...originalInput, turnRequestSnapshot: { ...originalInput.turnRequestSnapshot!, hasTarget: true, selectedResultNodeId: 'result-original' } }
  await submitAgentClarification({
    ...input, session: { ...input.session, messages: [targetInput, message] },
    contextOptions: [{ id: 'result-original', kind: '结果', label: '原图' }],
    continueInstruction: async (_instruction, options) => {
      assert.equal(options.executionSnapshot?.targetNodeId, 'result-original')
      const recovered = await resolveBotanicAgentContinuationTarget(options.executionSnapshot?.targetNodeId, (id) => ({ id }))
      assert.equal(recovered?.id, 'result-original')
    },
  })
})

test('答案保存失败不执行；已确认后刷新用保存的答案恢复，同一答案身份不变', async () => {
  let message = question()
  const answerIds: string[] = []
  let failAt: 'question' | 'answer' | undefined = 'question'
  let continues = 0
  const input: Parameters<typeof submitAgentClarification>[0] = {
    session: session(message), message, answers: { resolution: '2K' }, generationModels: [], runs: [], locale: 'zh-CN',
    contextOptions: [], plannerModel: 'current-model',
    inFlight: new Set(), isCurrent: () => true, retryMessage: () => {},
    ensureMessageDurable: async (saved) => {
      if (saved.kind === 'question' && failAt === 'question') throw new Error('offline')
      if (saved.role === 'user') { answerIds.push(saved.id); if (failAt === 'answer') throw new Error('offline') }
      return saved
    },
    onUpdateMessage: (_sessionId, _id, patch) => { message = { ...message, ...patch } },
    continueInstruction: async (_instruction, options) => { continues++; assert.equal(options.clarificationAnswers?.resolution, '2K') },
  }
  await assert.rejects(() => submitAgentClarification(input), /offline/)
  assert.equal(message.status, 'pending')
  assert.equal(continues, 0)
  failAt = 'answer'
  await assert.rejects(() => submitAgentClarification(input), /offline/)
  assert.equal(message.status, 'answered')
  assert.equal(continues, 0)
  failAt = undefined
  const resumed = { ...input, session: session(message), message, answers: { resolution: '1K' }, inFlight: new Set<string>() }
  await submitAgentClarification(resumed)
  assert.equal(continues, 1)
  assert.equal(answerIds.length, 2)
  assert.equal(answerIds[0], answerIds[1])
  await submitAgentClarification({ ...resumed, isCurrent: () => false })
  assert.equal(continues, 1)
  await assert.rejects(() => submitAgentClarification({ ...resumed, session: { ...session(message), messages: [message] } }), /原请求/)
  assert.equal(continues, 1, '原请求缺失不能借用当前 Composer 继续')
  let reads = 0
  const unloaded = { ...resumed, session: { ...session(message), messages: [message] } }
  await assert.rejects(() => submitAgentClarification({
    ...unloaded, loadMessages: async () => { reads++; return { messages: [], nextBefore: 'stalled-page' } },
  }), /原请求/)
  assert.equal(reads, 2, '重复游标不能无限读取')
  let current = true
  await submitAgentClarification({
    ...unloaded, isCurrent: () => current,
    loadMessages: async () => { current = false; return { messages: session(message).messages } },
  })
  assert.equal(continues, 1, '读取历史时切换会话不能接续旧任务')
  const legacy = { ...question(), turnId: undefined }
  await assert.rejects(() => submitAgentClarification({
    ...input, message: legacy, session: { ...session(legacy), messages: [legacy] },
  }), /原请求/)
  assert.equal(continues, 1, '没有原请求身份的旧卡不能用当前设置重新执行')
  const newQuestion = { ...message, question: { ...message.question!, id: 'settings-2' }, status: 'pending' as const }
  await assert.rejects(() => submitAgentClarification({
    ...resumed, session: session(newQuestion),
    ensureMessageDurable: async (saved) => { assert.fail('旧题必须在保存前被拒绝'); return saved },
  }), /确认.*变化/)
  assert.equal(continues, 1)
})
