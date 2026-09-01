import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentTurnCheckpointHash,
  completeAgentTurnCheckpoint,
  prepareAgentTurnCheckpoint,
  terminalAgentTurnCheckpoint,
  validateAgentTurnCheckpoint,
} from './agentTurnCheckpoint.mjs'

const attempt = (overrides = {}) => ({
  id: 'text',
  model: 'planner-model',
  snapshotHash: 'snapshot-v1',
  ...overrides,
})

const readCall = (overrides = {}) => ({
  id: 'call-read-1',
  name: 'canvas_read',
  risk: 'read',
  recovery: 'reexecute',
  terminal: false,
  arguments: { nodeIds: ['node-1'], why: '核对画布上下文' },
  ...overrides,
})

const receiptCall = (overrides = {}) => ({
  id: 'call-write-1',
  name: 'generation_submit',
  risk: 'costly',
  recovery: 'receipt',
  terminal: true,
  receiptId: 'receipt-1',
  intentHash: 'intent-hash-1',
  ...overrides,
})

test('Checkpoint 按 prepared → completed → terminal 流转，哈希不受键顺序影响', () => {
  const prepared = prepareAgentTurnCheckpoint(undefined, {
    attempt: attempt(),
    step: 0,
    calls: [readCall()],
  })
  assert.deepEqual(prepared, {
    version: 1,
    attempt: attempt(),
    completedSteps: [],
    pendingStep: { step: 0, calls: [readCall()] },
  })

  const completed = completeAgentTurnCheckpoint(prepared, { calls: [readCall()] })
  assert.deepEqual(completed, {
    version: 1,
    attempt: attempt(),
    completedSteps: [{ step: 0, calls: [readCall()] }],
  })
  assert.deepEqual(
    completeAgentTurnCheckpoint(completed, { calls: [readCall()] }),
    completed,
    'completed 落盘后的同内容传输重试必须幂等',
  )

  const terminal = terminalAgentTurnCheckpoint(completed, {
    attempt: attempt(),
    step: 1,
    content: ' 已核对完成。 ',
  })
  assert.deepEqual(terminal, {
    version: 1,
    attempt: attempt(),
    completedSteps: [{ step: 0, calls: [readCall()] }],
    terminalContent: '已核对完成。',
  })
  assert.equal(
    agentTurnCheckpointHash(terminal),
    agentTurnCheckpointHash({
      terminalContent: '已核对完成。',
      completedSteps: [{ calls: [readCall()], step: 0 }],
      attempt: { snapshotHash: 'snapshot-v1', model: 'planner-model', id: 'text' },
      version: 1,
    }),
  )
})

test('completed Checkpoint 持久化显式工具业务引用；pending、未知工具与恶意引用均拒绝', () => {
  const call = readCall({ name: 'artifact_search' })
  const references = [
    { type: 'artifact', id: 'artifact-1' },
    { type: 'agent_run', id: 'run-1' },
  ]
  const prepared = prepareAgentTurnCheckpoint(undefined, {
    attempt: attempt(), step: 0, calls: [call],
  })
  assert.throws(
    () => validateAgentTurnCheckpoint({
      ...prepared,
      pendingStep: { step: 0, calls: [{ ...call, entityReferences: references }] },
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )

  const completed = completeAgentTurnCheckpoint(prepared, {
    calls: [{ ...call, entityReferences: references }],
  })
  assert.deepEqual(completed.completedSteps[0].calls[0].entityReferences, references)
  assert.deepEqual(
    completeAgentTurnCheckpoint(completed, { calls: [{ ...call, entityReferences: references }] }),
    completed,
  )

  for (const invalidCall of [
    { ...readCall(), entityReferences: [{ type: 'artifact', id: 'artifact-forged' }] },
    { ...call, entityReferences: [{ type: 'artifact', id: 'https://evil.test/a' }] },
    { ...call, entityReferences: [{ type: 'workflow', id: 'workflow-forged' }] },
  ]) {
    assert.throws(
      () => completeAgentTurnCheckpoint(prepared, { calls: [invalidCall] }),
      (error) => error.code === 'AGENT_ENTITY_REFERENCES_INVALID'
        || error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
    )
  }
})

test('调用恢复数据按能力收口：reexecute 才保存参数，receipt 只保存回执引用', () => {
  const calls = [readCall(), {
    id: 'call-never-1', name: 'unknown_external', risk: 'external', recovery: 'never', terminal: false,
  }, receiptCall()]
  const prepared = prepareAgentTurnCheckpoint(undefined, { attempt: attempt(), step: 0, calls })
  assert.deepEqual(prepared.pendingStep.calls, calls)

  assert.throws(
    () => prepareAgentTurnCheckpoint(undefined, {
      attempt: attempt(), step: 0,
      calls: [{ ...receiptCall(), arguments: { prompt: '不得保存' } }],
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
  assert.throws(
    () => prepareAgentTurnCheckpoint(undefined, {
      attempt: attempt(), step: 0,
      calls: [{ ...readCall(), receiptId: 'receipt-extra' }],
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
})

test('Checkpoint 拒绝媒体字节、原始推理、工具输出与 Provider 回包', () => {
  const forbiddenArguments = [
    { image: 'AAAA' },
    { nested: { dataUrl: 'data:image/png;base64,AAAA' } },
    { bytes: [1, 2, 3] },
    { reasoning_content: '隐藏思维链' },
    { analysis: '原始推理' },
    { output: { secret: true } },
    { result: { privateUrl: 'https://private.test/x' } },
    { provider_response: { choices: [] } },
    { payload: 'data:application/octet-stream;base64,AAAA' },
  ]
  for (const argumentsValue of forbiddenArguments) {
    assert.throws(
      () => prepareAgentTurnCheckpoint(undefined, {
        attempt: attempt(), step: 0, calls: [readCall({ arguments: argumentsValue })],
      }),
      (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
      JSON.stringify(argumentsValue),
    )
  }

  assert.throws(
    () => validateAgentTurnCheckpoint({
      version: 1,
      attempt: attempt(),
      completedSteps: [],
      reasoning: '不应落盘',
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
})

test('Checkpoint 强制步骤连续、pending 位置正确且 snapshot 不可漂移', () => {
  const prepared = prepareAgentTurnCheckpoint(undefined, { attempt: attempt(), step: 0, calls: [readCall()] })
  const completed = completeAgentTurnCheckpoint(prepared, { calls: [readCall()] })

  assert.throws(
    () => prepareAgentTurnCheckpoint(completed, { attempt: attempt(), step: 2, calls: [readCall({ id: 'call-2' })] }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
  assert.throws(
    () => prepareAgentTurnCheckpoint(completed, {
      attempt: attempt({ snapshotHash: 'snapshot-v2' }), step: 1, calls: [readCall({ id: 'call-2' })],
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_SNAPSHOT_MISMATCH',
  )
  assert.throws(
    () => completeAgentTurnCheckpoint(prepared, { calls: [readCall({ name: 'project_memory_search' })] }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_MISMATCH',
  )
  assert.throws(
    () => validateAgentTurnCheckpoint({
      version: 1,
      attempt: attempt(),
      completedSteps: [{ step: 1, calls: [readCall()] }],
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
})

test('Checkpoint 限制 8 步、每步 16 调用与 64KB 总大小', () => {
  const sixteenCalls = Array.from({ length: 16 }, (_, index) => readCall({ id: `call-${index}` }))
  assert.doesNotThrow(() => prepareAgentTurnCheckpoint(undefined, { attempt: attempt(), step: 0, calls: sixteenCalls }))
  assert.throws(
    () => prepareAgentTurnCheckpoint(undefined, {
      attempt: attempt(), step: 0,
      calls: [...sixteenCalls, readCall({ id: 'call-17' })],
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )

  let checkpoint
  for (let step = 0; step < 8; step += 1) {
    const call = readCall({ id: `step-${step}` })
    checkpoint = completeAgentTurnCheckpoint(
      prepareAgentTurnCheckpoint(checkpoint, { attempt: attempt(), step, calls: [call] }),
      { calls: [call] },
    )
  }
  assert.equal(checkpoint.completedSteps.length, 8)
  assert.throws(
    () => prepareAgentTurnCheckpoint(checkpoint, { attempt: attempt(), step: 8, calls: [readCall({ id: 'step-8' })] }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )

  assert.throws(
    () => prepareAgentTurnCheckpoint(undefined, {
      attempt: attempt(), step: 0,
      calls: [readCall({ arguments: { prompt: 'x'.repeat(70 * 1024) } })],
    }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_TOO_LARGE',
  )
})

test('terminalContent 只接受当前步的最终用户可见文本', () => {
  assert.throws(
    () => terminalAgentTurnCheckpoint(undefined, { attempt: attempt(), step: 0, content: '' }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
  assert.throws(
    () => terminalAgentTurnCheckpoint(undefined, { attempt: attempt(), step: 0, content: 'x'.repeat(12_001) }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )

  const prepared = prepareAgentTurnCheckpoint(undefined, { attempt: attempt(), step: 0, calls: [readCall()] })
  assert.throws(
    () => terminalAgentTurnCheckpoint(prepared, { attempt: attempt(), step: 0, content: '完成' }),
    (error) => error.code === 'AGENT_TURN_CHECKPOINT_INVALID',
  )
})

test('Checkpoint V2 reader:V1/V2 fixture 均可读,journal call 顺序与配对稳定', () => {
  // V1 fixture 原样可读(向前兼容 reader)。
  const v1 = validateAgentTurnCheckpoint({
    version: 1,
    attempt: attempt(),
    completedSteps: [{ step: 0, calls: [readCall()] }],
  })
  assert.equal(v1.version, 1)

  // V2 fixture:journal call 携带 lifecycle 与安全 result envelope。
  const envelope = JSON.stringify({ url: 'https://example.com/page', title: '页面', text: '正文摘录' })
  const v2 = validateAgentTurnCheckpoint({
    version: 2,
    attempt: attempt(),
    completedSteps: [{
      step: 0,
      calls: [
        { id: 'call-web-1', name: 'web_fetch', risk: 'external', recovery: 'journal', terminal: false, phase: 'completed', arguments: { url: 'https://example.com/page' }, resultEnvelope: envelope },
        { id: 'call-web-2', name: 'web_fetch', risk: 'external', recovery: 'journal', terminal: false, phase: 'unknown', arguments: { url: 'https://example.com/next' } },
      ],
    }],
    pendingStep: {
      step: 1,
      calls: [{ id: 'call-web-3', name: 'web_fetch', risk: 'external', recovery: 'journal', terminal: false, phase: 'dispatched', arguments: { url: 'https://example.com/third' } }],
    },
  })
  assert.equal(v2.version, 2)
  assert.deepEqual(v2.completedSteps[0].calls.map((call) => [call.id, call.phase]), [
    ['call-web-1', 'completed'],
    ['call-web-2', 'unknown'],
  ])
  assert.equal(v2.completedSteps[0].calls[0].resultEnvelope, envelope)
  assert.equal(v2.pendingStep.calls[0].phase, 'dispatched')
  // resultRef 只能指向既有 Receipt/Artifact。
  assert.throws(() => validateAgentTurnCheckpoint({
    version: 2, attempt: attempt(),
    completedSteps: [{ step: 0, calls: [{ id: 'c1', name: 'web_fetch', risk: 'external', recovery: 'journal', terminal: false, phase: 'completed', resultRef: { kind: 'url', id: 'x' } }] }],
  }))
})

test('Checkpoint V2 拒绝 raw/私网/媒体/推理与超预算 result', () => {
  const journalCall = (overrides) => ({
    id: 'call-x', name: 'web_fetch', risk: 'external', recovery: 'journal', terminal: false, phase: 'completed', ...overrides,
  })
  const withEnvelope = (resultEnvelope, id = 'call-x') => ({
    version: 2, attempt: attempt(),
    completedSteps: [{ step: 0, calls: [journalCall({ id, resultEnvelope })] }],
  })
  assert.throws(() => validateAgentTurnCheckpoint(withEnvelope('data:image/png;base64,AAAA')), /Data URL/u)
  assert.throws(() => validateAgentTurnCheckpoint(withEnvelope('{"reasoning":"隐藏推理"}')), /原始推理/u)
  assert.throws(() => validateAgentTurnCheckpoint(withEnvelope('{"url":"http://10.0.0.8/internal"}')))
  assert.throws(() => validateAgentTurnCheckpoint(withEnvelope('{"url":"http://example.com"}')), /HTTPS/u)
  // 单 call >8KiB
  assert.throws(
    () => validateAgentTurnCheckpoint(withEnvelope(JSON.stringify({ text: 'x'.repeat(9 * 1024) }))),
    (caught) => caught.code === 'AGENT_TURN_CHECKPOINT_TOO_LARGE',
  )
  // 全 Turn >24KiB(4 × 7KiB)
  const sevenKb = JSON.stringify({ text: 'y'.repeat(7 * 1024) })
  assert.throws(
    () => validateAgentTurnCheckpoint({
      version: 2, attempt: attempt(),
      completedSteps: [{
        step: 0,
        calls: [1, 2, 3, 4].map((index) => journalCall({ id: 'call-' + index, resultEnvelope: sevenKb })),
      }],
    }),
    (caught) => caught.code === 'AGENT_TURN_CHECKPOINT_TOO_LARGE',
  )
  // journal recovery 需要 V2。
  assert.throws(() => validateAgentTurnCheckpoint({
    version: 1, attempt: attempt(),
    completedSteps: [{ step: 0, calls: [journalCall({ phase: undefined })] }],
  }))
})
