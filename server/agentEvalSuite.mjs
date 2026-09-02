// @ts-check
import { reviewDeterministicLayer } from './agent/review/agentReviewDeterministic.mjs'

/**
 * 创意质量 Eval 套件（Epic 12）。
 *
 * 它复用评审的分层判定，不另起一套 rubric —— 发布 Gate 用一套判据、线上评审用另一套
 * 的话，「Gate 过了」就证明不了「线上会通过」。
 *
 * 三条硬边界：
 * 1. **发布 Gate 只跑固定回归集**，样本自带实测规格与人工金标，不读生产项目素材。
 * 2. **不调用真实 Provider。** 视觉层是注入式 seam；Gate 里不注入，对应判据记为
 *    `unverifiable` 而不是默认通过。
 * 3. **单元测试通过率不是创意质量证明。** 报告把工程指标与创意判据分开呈现，
 *    并且 Gate 的结论只看后者。
 */

/**
 * Eval 分层。与 ADR 0006 的评审分层同构，多一层「线上反馈」——
 * 它是事后事实，不能参与发布前的 Gate 判定。
 */
export const EVAL_LAYERS = Object.freeze(['deterministic', 'vision', 'human_gold', 'online_feedback'])

/** 创意质量判据。声明式：新增判据必须说明它属于哪一层。 */
export const EVAL_CRITERIA = Object.freeze({
  media_kind: 'deterministic',
  file_integrity: 'deterministic',
  aspect_ratio: 'deterministic',
  resolution: 'deterministic',
  duration: 'deterministic',
  prompt_adherence: 'vision',
  subject_consistency: 'vision',
  brand_compliance: 'vision',
  text_legibility: 'vision',
  composition_defects: 'vision',
  variant_distinctiveness: 'vision',
  channel_safe_area: 'deterministic',
  human_acceptance: 'human_gold',
})

export class AgentEvalError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentEvalError'
    this.code = code
  }
}

const MEDIA_PATTERNS = [/data:[a-z]+\//i, /\/api\/media\//, /https?:\/\//i]

/**
 * 校验一条回归样本。
 *
 * 样本里出现真实媒体地址或 data URL 直接拒绝：**Gate 不得依赖生产素材** ——
 * 依赖了，素材一被删除或轮转，Gate 就会因为与质量无关的原因变红或变绿。
 */
export function validateEvalCase(value, index = 0) {
  if (!value || typeof value !== 'object') throw new AgentEvalError('INVALID_EVAL_CASE', `第 ${index + 1} 条样本格式无效。`)
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : ''
  if (!id) throw new AgentEvalError('INVALID_EVAL_CASE', `第 ${index + 1} 条样本缺少标识。`)
  const serialized = JSON.stringify(value)
  if (MEDIA_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new AgentEvalError('EVAL_CASE_USES_REAL_MEDIA', `样本「${id}」引用了真实媒体或外部地址，回归集不得依赖生产素材。`)
  }
  if (!value.settings || typeof value.settings !== 'object') {
    throw new AgentEvalError('INVALID_EVAL_CASE', `样本「${id}」缺少计划设置。`)
  }
  if (!value.output || typeof value.output !== 'object') {
    throw new AgentEvalError('INVALID_EVAL_CASE', `样本「${id}」缺少输出记录。`)
  }
  return {
    id,
    label: typeof value.label === 'string' ? value.label : id,
    settings: value.settings,
    output: value.output,
    // 人工金标：这一条按人的判断应当通过还是不通过。缺省表示这条样本不参与金标层。
    ...(typeof value.humanAccepted === 'boolean' ? { humanAccepted: value.humanAccepted } : {}),
    ...(value.expect && typeof value.expect === 'object' ? { expect: value.expect } : {}),
  }
}

export function validateEvalDataset(value) {
  const cases = Array.isArray(value?.cases) ? value.cases : []
  if (!cases.length) throw new AgentEvalError('EMPTY_EVAL_DATASET', '回归集为空。')
  const validated = cases.map((entry, index) => validateEvalCase(entry, index))
  const duplicates = validated.map((entry) => entry.id).filter((id, index, all) => all.indexOf(id) !== index)
  if (duplicates.length) throw new AgentEvalError('DUPLICATE_EVAL_CASE', `样本标识重复：${[...new Set(duplicates)].join('、')}`)
  return { version: Number(value?.version) || 1, cases: validated }
}

/**
 * 跑一遍回归集。
 *
 * @param {{
 *   dataset: any,
 *   evaluateVision?: (input: { case: any }) => Promise<{ criteria?: Array<any> }>,
 * }} input
 */
export async function runAgentEvalSuite({ dataset, evaluateVision } = /** @type {any} */ ({})) {
  const validated = validateEvalDataset(dataset)
  const results = []
  for (const entry of validated.cases) {
    const deterministic = reviewDeterministicLayer({ output: entry.output, settings: entry.settings })
    const criteria = [...deterministic.criteria]
    if (typeof evaluateVision === 'function') {
      const judged = await evaluateVision({ case: entry })
      criteria.push(...(judged?.criteria ?? []))
    } else {
      // Gate 不调用真实 Provider：视觉判据记为无法验证，不默认通过。
      for (const [id, layer] of Object.entries(EVAL_CRITERIA)) {
        if (layer !== 'vision') continue
        criteria.push({ id, layer: 'vision', verdict: 'unverifiable', evidence: '发布 Gate 不调用视觉模型。' })
      }
    }
    if (entry.humanAccepted !== undefined) {
      criteria.push({
        id: 'human_acceptance',
        layer: 'human_gold',
        verdict: entry.humanAccepted ? 'pass' : 'fail',
        evidence: '人工金标',
      })
    }
    const verdict = criteria.some((item) => item.verdict === 'fail')
      ? 'fail'
      : criteria.every((item) => item.verdict === 'unverifiable') ? 'unverifiable' : 'pass'
    // `pass` 只表示「被检查过的判据都没失败」，不是「全都验证过了」。
    // 没能验证的层单独列出来，而不是折进结论里 —— 折进去就只剩两种选择：
    // 要么把未检查说成通过，要么把已确定通过的硬规格也说成无法验证。
    const unverifiedLayers = [...new Set(criteria
      .filter((item) => item.verdict === 'unverifiable')
      .map((item) => item.layer))]
    // 样本可以声明「这条本来就该失败」：只有 pass 样本才应当全绿，缺了这一层
    // 回归集会退化成「一堆一定会过的样本」，抓不到判据变松。
    const expectedVerdict = entry.expect?.verdict
    results.push({
      id: entry.id,
      label: entry.label,
      verdict,
      ...(unverifiedLayers.length ? { unverifiedLayers } : {}),
      ...(expectedVerdict ? { expectedVerdict, matchesExpectation: verdict === expectedVerdict } : {}),
      criteria,
    })
  }
  const scored = results.filter((result) => result.expectedVerdict)
  return {
    version: validated.version,
    caseCount: results.length,
    results,
    // 回归口径：样本的实际结论是否与它声明的期望一致。
    expectationCount: scored.length,
    expectationMatchRate: scored.length ? scored.filter((result) => result.matchesExpectation).length / scored.length : null,
    deterministicFailures: results.filter((result) => (
      result.criteria.some((item) => item.layer === 'deterministic' && item.verdict === 'fail')
    )).length,
    // 有多少条样本的结论带着「某一层没验证」的保留。报告必须显示它，否则
    // 「9 条全绿」会被读成「9 条全部验证过了」。
    partiallyVerifiedCount: results.filter((result) => result.unverifiedLayers?.length).length,
  }
}

/**
 * 发布 Gate 判定。
 *
 * **只看创意判据，不看单元测试通过率** —— 后者证明代码没崩，不证明生成质量。
 * 报告里两者并列呈现，但结论只由前者决定。
 */
export function evaluateReleaseGate(suite, { minimumExpectationMatchRate = 1 } = {}) {
  const mismatches = (suite?.results ?? []).filter((result) => result.expectedVerdict && !result.matchesExpectation)
  const matchRate = suite?.expectationMatchRate
  if (matchRate === null || matchRate === undefined) {
    return { passed: false, code: 'NO_SCORED_CASES', message: '回归集没有任何声明期望的样本，Gate 无法判定。', mismatches: [] }
  }
  if (matchRate < minimumExpectationMatchRate) {
    return {
      passed: false,
      code: 'EVAL_REGRESSION',
      message: `回归集期望符合率 ${(matchRate * 100).toFixed(1)}%，低于门槛 ${(minimumExpectationMatchRate * 100).toFixed(1)}%。`,
      mismatches: mismatches.map((result) => ({ id: result.id, expected: result.expectedVerdict, actual: result.verdict })),
    }
  }
  return { passed: true, code: 'EVAL_PASSED', message: `回归集 ${suite.expectationCount} 条样本全部符合期望。`, mismatches: [] }
}

/**
 * 两次 Eval 的差异。模型、Prompt 或路由改动后必须输出它 ——
 * 只说「测试还是绿的」不构成质量没退化的证据。
 */
export function diffEvalSuites(before, after) {
  const beforeById = new Map((before?.results ?? []).map((result) => [result.id, result]))
  const afterById = new Map((after?.results ?? []).map((result) => [result.id, result]))
  const changes = []
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const left = beforeById.get(id)
    const right = afterById.get(id)
    if (!left) { changes.push({ id, status: 'added', to: right.verdict }); continue }
    if (!right) { changes.push({ id, status: 'removed', from: left.verdict }); continue }
    if (left.verdict === right.verdict) continue
    changes.push({
      id,
      status: right.verdict === 'pass' ? 'improved' : left.verdict === 'pass' ? 'regressed' : 'changed',
      from: left.verdict,
      to: right.verdict,
    })
  }
  return {
    changes,
    regressed: changes.filter((change) => change.status === 'regressed').length,
    improved: changes.filter((change) => change.status === 'improved').length,
  }
}

/**
 * 线上反馈层（Epic 12 第 4 层）。
 *
 * 它是**事后事实**，因此不参与发布前的 Gate 判定 —— 用线上接受率去卡发布，等于用
 * 上一版的结果决定这一版能不能上。它的价值在趋势：接受率掉下去、修订次数升上来，
 * 说明质量在退化，而这在 Gate 里看不出来。
 *
 * 数据来自已有实体，不新增埋点：人工决定来自评审任务（Epic 5），交付完整率来自
 * 交付清单（Epic 7）。
 *
 * @param {{ reviewTasks?: any[], manifests?: any[] }} [input]
 */
export function aggregateOnlineFeedback({ reviewTasks = [], manifests = [] } = {}) {
  const decisions = reviewTasks.flatMap((task) => task?.decisions ?? [])
  // 同一候选可以被改主意，只算最后一次 —— 否则一次反复会被算成多次拒绝。
  const latest = new Map()
  for (const decision of decisions) {
    const current = latest.get(decision?.artifactId)
    const decisionRevision = Number(decision?.decisionRevision ?? 0)
    const decidedAt = Number(decision?.decidedAt ?? 0)
    if (!current || decisionRevision > current.decisionRevision
      || (decisionRevision === current.decisionRevision && decidedAt >= current.decidedAt)) {
      latest.set(decision?.artifactId, { decision: decision?.decision, decisionRevision, decidedAt })
    }
  }
  const settled = [...latest.values()]
  const accepted = settled.filter((entry) => entry.decision === 'accepted').length
  const rejected = settled.filter((entry) => entry.decision === 'rejected').length
  const retried = settled.filter((entry) => entry.decision === 'retry_requested').length
  const reviewedCandidates = reviewTasks.reduce((total, task) => total + (task?.results?.length ?? 0), 0)
  const deliveredFiles = manifests.reduce((total, manifest) => total + (manifest?.files?.length ?? 0), 0)
  const excludedFiles = manifests.reduce((total, manifest) => total + (manifest?.excluded?.length ?? 0), 0)
  const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null)
  return {
    decidedCount: settled.length,
    // 比率无样本时为 null：没人做过决定不等于接受率 0%。
    acceptanceRate: ratio(accepted, settled.length),
    rejectionRate: ratio(rejected, settled.length),
    retryRequestRate: ratio(retried, settled.length),
    // 还有多少候选没人看过。它比接受率更早暴露「评审堆积」。
    pendingDecisionCount: Math.max(0, reviewedCandidates - settled.length),
    deliveredFileCount: deliveredFiles,
    // 交付完整率：进了包的 / (进了包的 + 因未批准被排除的)。
    deliveryCompletionRate: ratio(deliveredFiles, deliveredFiles + excludedFiles),
  }
}
