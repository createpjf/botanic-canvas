import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  AgentEvalError,
  EVAL_CRITERIA,
  EVAL_LAYERS,
  diffEvalSuites,
  evaluateReleaseGate,
  runAgentEvalSuite,
  validateEvalCase,
  validateEvalDataset,
} from './agentEvalSuite.mjs'

const dataset = JSON.parse(readFileSync(new URL('../scripts/fixtures/agentEvalRegressionSet.json', import.meta.url), 'utf8'))

const compliantCase = {
  id: 'case-1',
  settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
  output: { id: 'out-1', mediaKind: 'image', spec: { mimeType: 'image/png', byteSize: 1024, width: 1024, height: 1024 } },
}

test('分层与判据都是声明式的', () => {
  assert.deepEqual([...EVAL_LAYERS], ['deterministic', 'vision', 'human_gold', 'online_feedback'])
  assert.equal(EVAL_CRITERIA.aspect_ratio, 'deterministic')
  assert.equal(EVAL_CRITERIA.brand_compliance, 'vision')
  assert.equal(EVAL_CRITERIA.human_acceptance, 'human_gold')
})

test('回归集样本不得引用真实媒体或外部地址', () => {
  // 依赖生产素材会让 Gate 因为与质量无关的原因变红或变绿。
  for (const bad of ['/api/media/media_x', 'data:image/png;base64,AAA', 'https://cdn.example/a.png']) {
    assert.throws(
      () => validateEvalCase({ ...compliantCase, output: { ...compliantCase.output, image: bad } }),
      (error) => error instanceof AgentEvalError && error.code === 'EVAL_CASE_USES_REAL_MEDIA',
    )
  }
})

test('样本必须自带计划设置与输出记录，标识不得重复', () => {
  assert.throws(() => validateEvalCase({ id: 'x', output: {} }), /缺少计划设置/u)
  assert.throws(() => validateEvalCase({ id: 'x', settings: {} }), /缺少输出记录/u)
  assert.throws(() => validateEvalCase({ settings: {}, output: {} }), /缺少标识/u)
  assert.throws(() => validateEvalDataset({ cases: [compliantCase, compliantCase] }), /标识重复/u)
  assert.throws(() => validateEvalDataset({ cases: [] }), /回归集为空/u)
})

test('随仓库的固定回归集本身是合法的，且全部符合期望', () => {
  return (async () => {
    const suite = await runAgentEvalSuite({ dataset })
    assert.equal(suite.caseCount, 9)
    assert.equal(suite.expectationCount, 9)
    assert.equal(suite.expectationMatchRate, 1)
    // 回归集里必须有本来就该失败的样本，否则它退化成「一堆一定会过的样本」，
    // 抓不到判据变松。
    assert.ok(dataset.cases.filter((entry) => entry.expect.verdict === 'fail').length >= 4)
    assert.ok(dataset.cases.some((entry) => entry.expect.verdict === 'unverifiable'))
    // 报告必须显示「有多少条带保留」，否则「9 条全绿」会被读成「9 条全部验证过了」。
    assert.equal(suite.partiallyVerifiedCount, 9)
  })()
})

test('Gate 不调用视觉模型，视觉判据记为无法验证而不是默认通过', () => {
  return (async () => {
    const suite = await runAgentEvalSuite({ dataset: { cases: [compliantCase] } })
    const vision = suite.results[0].criteria.filter((item) => item.layer === 'vision')
    assert.ok(vision.length >= 6)
    assert.ok(vision.every((item) => item.verdict === 'unverifiable'))
    // pass 只表示「被检查过的判据都没失败」；没验证的层单独列出来，
    // 折进结论就只剩两种坏选择：把未检查说成通过，或把已确定的硬规格说成无法验证。
    assert.equal(suite.results[0].verdict, 'pass')
    assert.deepEqual(suite.results[0].unverifiedLayers, ['vision'])
    assert.equal(suite.partiallyVerifiedCount, 1)
  })()
})

test('注入视觉层后其结论参与判定', () => {
  return (async () => {
    const suite = await runAgentEvalSuite({
      dataset: { cases: [compliantCase] },
      evaluateVision: async () => ({ criteria: [{ id: 'brand_compliance', layer: 'vision', verdict: 'fail', evidence: '主色不符' }] }),
    })
    assert.equal(suite.results[0].verdict, 'fail')
  })()
})

test('人工金标可以否掉规格全合规的样本', () => {
  return (async () => {
    const suite = await runAgentEvalSuite({
      dataset: { cases: [{ ...compliantCase, humanAccepted: false }] },
    })
    assert.equal(suite.results[0].verdict, 'fail')
    assert.equal(suite.results[0].criteria.find((item) => item.layer === 'human_gold').verdict, 'fail')
  })()
})

test('Gate 只看创意判据的回归口径', () => {
  return (async () => {
    const suite = await runAgentEvalSuite({ dataset })
    const gate = evaluateReleaseGate(suite)
    assert.equal(gate.passed, true)
    assert.equal(gate.code, 'EVAL_PASSED')

    // 判据变松（本该失败的样本变成通过）必须让 Gate 红。
    const loosened = {
      ...suite,
      results: suite.results.map((result) => (result.id === 'aspect-ratio-drift'
        ? { ...result, verdict: 'pass', matchesExpectation: false }
        : result)),
      expectationMatchRate: 8 / 9,
    }
    const failed = evaluateReleaseGate(loosened)
    assert.equal(failed.passed, false)
    assert.equal(failed.code, 'EVAL_REGRESSION')
    assert.deepEqual(failed.mismatches, [{ id: 'aspect-ratio-drift', expected: 'fail', actual: 'pass' }])
  })()
})

test('没有声明期望的样本集无法作为 Gate 依据', () => {
  return (async () => {
    const suite = await runAgentEvalSuite({ dataset: { cases: [compliantCase] } })
    const gate = evaluateReleaseGate(suite)
    assert.equal(gate.passed, false)
    assert.equal(gate.code, 'NO_SCORED_CASES')
  })()
})

test('前后 Eval 差异区分回退与改善', () => {
  return (async () => {
    const before = await runAgentEvalSuite({ dataset })
    const after = {
      ...before,
      results: before.results.map((result) => (result.id === 'square-1k-compliant'
        ? { ...result, verdict: 'fail' }
        : result)),
    }
    const diff = diffEvalSuites(before, after)
    assert.equal(diff.regressed, 1)
    assert.equal(diff.improved, 0)
    assert.deepEqual(diff.changes[0], { id: 'square-1k-compliant', status: 'regressed', from: 'pass', to: 'fail' })
    assert.deepEqual(diffEvalSuites(before, before).changes, [])
  })()
})

test('线上反馈从既有实体聚合，不新增埋点', async () => {
  const { aggregateOnlineFeedback } = await import('./agentEvalSuite.mjs')
  const feedback = aggregateOnlineFeedback({
    reviewTasks: [{
      id: 't1',
      results: [{ artifactId: 'a1' }, { artifactId: 'a2' }, { artifactId: 'a3' }],
      decisions: [
        { artifactId: 'a1', decision: 'rejected', decidedAt: 1 },
        // 同一候选改主意：只算最后一次，否则一次反复会被算成多次拒绝。
        { artifactId: 'a1', decision: 'accepted', decidedAt: 9 },
        { artifactId: 'a2', decision: 'retry_requested', decidedAt: 3 },
      ],
    }],
    manifests: [{ files: [{ artifactId: 'a1' }], excluded: [{ artifactId: 'a2' }, { artifactId: 'a3' }] }],
  })
  assert.equal(feedback.decidedCount, 2)
  assert.equal(feedback.acceptanceRate, 0.5)
  assert.equal(feedback.retryRequestRate, 0.5)
  assert.equal(feedback.rejectionRate, 0)
  // 还没人看过的候选：比接受率更早暴露评审堆积。
  assert.equal(feedback.pendingDecisionCount, 1)
  assert.equal(feedback.deliveryCompletionRate, 1 / 3)
})

test('线上反馈没有样本时给 null，不冒充 0%', async () => {
  const { aggregateOnlineFeedback } = await import('./agentEvalSuite.mjs')
  const empty = aggregateOnlineFeedback()
  assert.equal(empty.acceptanceRate, null)
  assert.equal(empty.deliveryCompletionRate, null)
  assert.equal(empty.decidedCount, 0)
})

test('线上反馈不参与发布 Gate 判定', async () => {
  // 用上一版的线上接受率去卡这一版能不能上，是把事后事实当成发布前证据。
  const suite = await runAgentEvalSuite({ dataset })
  const gate = evaluateReleaseGate(suite)
  assert.equal(gate.passed, true)
  assert.equal(Object.keys(gate).includes('acceptanceRate'), false)
})
