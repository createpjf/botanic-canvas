import type { ProductLocale } from '../i18n/core'

/**
 * 评审结果的展示规则（Epic 5）。
 *
 * 放在 domain 而不是组件里，是因为这里有几条**不能靠组件自觉**的约束：
 *
 * - `unverifiable` 必须与 pass/fail 分开显示。把它折进「通过」，用户会以为
 *   没检查过的判据检查过了；折进「不通过」，又会把「没验证」说成「不合格」。
 * - 覆盖策略与被跳过的候选数必须出现在摘要里。不显示的话，「评了 2 张」看起来
 *   就像「全评过了」。
 * - 自动结论一律停在待人工，因此每个候选都要能被接受/拒绝/请求重试。
 */

export type AgentReviewVerdict = 'pass' | 'fail' | 'unverifiable'
export type AgentReviewDecision = 'accepted' | 'rejected' | 'retry_requested'
export type AgentReviewReconciliationAction = 'continue_unverifiable' | 'retry_once'

export type AgentReviewCriterion = {
  id: string
  layer?: 'deterministic' | 'model' | 'human'
  verdict?: AgentReviewVerdict
  evidence?: string
  /** 品牌判据的溯源（Epic 9.1）。 */
  brandRuleId?: string
  brandLayer?: string
  /** 自定义判据（evaluator Skill）的溯源：**必须带版本**，Skill 版本不可变。 */
  skillId?: string
  skillVersion?: number
}

export type AgentReviewCandidate = {
  artifactId: string
  verdict?: AgentReviewVerdict
  candidateStatus?: string
  criteria?: AgentReviewCriterion[]
  revisionProposal?: { suggestion?: string; failedCriteria?: string[] }
}

export type AgentReviewTaskSnapshot = {
  id: string
  runId: string
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed'
  qualityPolicyFingerprint?: string
  planFingerprint?: string
  qualityPolicy?: {
    requiredCriteria?: string[]
    brandCriteria?: Array<{ id: string }>
    /** 项目自定义判据。每条都乘以候选数，因此成本必须能提前算出来。 */
    evaluatorSkills?: Array<{ id: string; skillId: string; version: number; name?: string }>
  }
  error?: { code: string; message?: string }
  coverage?: {
    strategy?: string
    totalCandidates?: number
    reviewedCandidates?: number
    skippedCandidates?: number
  }
  results?: AgentReviewCandidate[]
  decisions?: Array<{
    artifactId: string
    decision: AgentReviewDecision
    decidedAt?: number
    decisionRevision?: number
  }>
  cancel?: {
    status?: 'cancelling' | 'cancelled'
    requestedAt?: number
    releaseBasis?: 'not_started' | 'worker_exit' | 'lease_expired'
  }
  reconciliation?: {
    version?: number
    retryCount?: number
    resolutions?: Array<{
      action: AgentReviewReconciliationAction
      resolvedAt?: number
      risk?: { code?: string }
    }>
  }
}

export function agentReviewRequiresReconciliation(task: AgentReviewTaskSnapshot | undefined) {
  return task?.status === 'failed' && task.error?.code === 'AGENT_REVIEW_OUTCOME_UNKNOWN'
}

const verdictLabels: Record<AgentReviewVerdict, Record<ProductLocale, string>> = {
  pass: { 'zh-CN': '符合', en: 'Meets' },
  fail: { 'zh-CN': '不符合', en: 'Fails' },
  // 「无法验证」不是中间态，是「这一项没被检查」。措辞必须让人一眼看出区别。
  unverifiable: { 'zh-CN': '未验证', en: 'Not verified' },
}

const layerLabels: Record<string, Record<ProductLocale, string>> = {
  deterministic: { 'zh-CN': '硬规格', en: 'Hard spec' },
  model: { 'zh-CN': '视觉评审', en: 'Vision review' },
  human: { 'zh-CN': '人工', en: 'Human' },
}

const decisionLabels: Record<AgentReviewDecision, Record<ProductLocale, string>> = {
  accepted: { 'zh-CN': '已接受', en: 'Accepted' },
  rejected: { 'zh-CN': '已拒绝', en: 'Rejected' },
  retry_requested: { 'zh-CN': '已请求重试', en: 'Retry requested' },
}

export function agentReviewVerdictLabel(verdict: AgentReviewVerdict | undefined, locale: ProductLocale = 'zh-CN') {
  return verdictLabels[verdict ?? 'unverifiable'][locale]
}

/**
 * 自定义判据的成本提示。
 *
 * **必须在评审开始前就能显示**：评审完再说已经晚了，钱已经花掉。用户加了 3 条判据
 * 却不知道费用翻了 3 倍，是这个功能最容易造成的伤害。
 */
export function agentReviewEvaluatorCostNote(
  task: AgentReviewTaskSnapshot | undefined,
  locale: ProductLocale = 'zh-CN',
) {
  const criteria = task?.qualityPolicy?.evaluatorSkills?.length ?? 0
  if (!criteria) return ''
  const candidates = Number(task?.coverage?.reviewedCandidates ?? 0)
  const calls = criteria * candidates
  return locale === 'en'
    ? `${criteria} project-defined criteria × ${candidates} candidates = ${calls} extra model call(s).`
    : `${criteria} 条自定义判据 × ${candidates} 个候选 = 额外 ${calls} 次模型调用。`
}

/** 一条判据是不是项目自定义的。自定义与内置必须分开展示：来源不同、可信度也不同。 */
export function isEvaluatorCriterion(criterion: { id?: string }) {
  return typeof criterion?.id === 'string' && criterion.id.startsWith('skill.')
}

export function agentReviewLayerLabel(layer: string | undefined, locale: ProductLocale = 'zh-CN') {
  return layerLabels[layer ?? 'deterministic']?.[locale] ?? layer ?? ''
}

export function agentReviewDecisionLabel(decision: AgentReviewDecision, locale: ProductLocale = 'zh-CN') {
  return decisionLabels[decision][locale]
}

/**
 * 覆盖摘要。**被跳过的候选数必须出现**，否则截断看起来像全评过了。
 */
export function agentReviewCoverageSummary(task: AgentReviewTaskSnapshot | undefined, locale: ProductLocale = 'zh-CN') {
  const total = Number(task?.coverage?.totalCandidates ?? 0)
  const reviewed = Number(task?.coverage?.reviewedCandidates ?? 0)
  const skipped = Number(task?.coverage?.skippedCandidates ?? 0)
  if (!total) return locale === 'en' ? 'No candidates to review.' : '没有可评审的候选。'
  const base = locale === 'en'
    ? `Reviewed ${reviewed} of ${total} candidates`
    : `已评审 ${total} 个候选中的 ${reviewed} 个`
  if (!skipped) return locale === 'en' ? `${base}.` : `${base}。`
  return locale === 'en'
    ? `${base}; ${skipped} skipped by the coverage strategy and not judged.`
    : `${base}；另有 ${skipped} 个按覆盖策略跳过，未做判断。`
}

/** 任务本身的失败要能被诊断，不能只显示「评审失败」。 */
export function agentReviewTaskStatusNote(task: AgentReviewTaskSnapshot | undefined, locale: ProductLocale = 'zh-CN') {
  if (!task) return ''
  if (agentReviewRequiresReconciliation(task)) {
    return locale === 'en'
      ? 'The model-call outcome cannot be proven. It was not retried automatically; choose whether to continue as not verified or authorize one risk-aware retry.'
      : '模型调用结果无法确认，系统未自动重试；请选择按「未验证」继续，或明确授权一次有重复调用风险的重试。'
  }
  if (task.status === 'failed') {
    const code = task.error?.code ?? 'REVIEW_FAILED'
    return locale === 'en'
      ? `Review did not finish (${code}). It can be retried; generated results are unaffected.`
      : `评审未完成（${code}），可以重试；已生成的结果不受影响。`
  }
  if (task.status === 'cancelling') {
    return locale === 'en'
      ? 'Stopping the active review. It remains in progress until the worker exits or its lease expires.'
      : '正在停止评审；只有执行 Worker 退出或租约过期后，任务才会确认取消。'
  }
  if (task.status === 'cancelled') {
    return locale === 'en' ? 'Review was cancelled; generated results are unaffected.' : '评审已取消；已生成的结果不受影响。'
  }
  if (task.status === 'queued' || task.status === 'running') {
    return locale === 'en' ? 'Review is still running in the background.' : '评审仍在后台进行。'
  }
  return ''
}

export type AgentReviewCandidateRow = {
  artifactId: string
  verdict: AgentReviewVerdict
  verdictLabel: string
  /** 已经做过的人工决定；没有则表示还等着人来判断。 */
  decision?: AgentReviewDecision
  decisionLabel?: string
  awaitingHuman: boolean
  criteria: Array<{
    id: string; layer: string; layerLabel: string; verdict: AgentReviewVerdict; verdictLabel: string; evidence: string
    /** 自定义判据的来源 Skill 与版本；内置判据没有。 */
    skillId?: string; skillVersion?: number
  }>
  /** 未被验证的判据数。单独给出来，不混进「不符合」。 */
  unverifiedCount: number
  revisionSuggestion?: string
}

/**
 * 把一个评审任务摊成可直接渲染的候选行。
 *
 * 决定以**最后一次**为准：同一候选可以被改主意，展示最新的那个。
 */
export function agentReviewCandidateRows(
  task: AgentReviewTaskSnapshot | undefined,
  locale: ProductLocale = 'zh-CN',
): AgentReviewCandidateRow[] {
  const latestDecision = new Map<string, {
    decision: AgentReviewDecision
    decisionRevision: number
    decidedAt: number
  }>()
  for (const entry of task?.decisions ?? []) {
    const current = latestDecision.get(entry.artifactId)
    const decisionRevision = Number(entry.decisionRevision ?? 0)
    const decidedAt = Number(entry.decidedAt ?? 0)
    if (!current || decisionRevision > current.decisionRevision
      || (decisionRevision === current.decisionRevision && decidedAt >= current.decidedAt)) {
      latestDecision.set(entry.artifactId, { decision: entry.decision, decisionRevision, decidedAt })
    }
  }
  return (task?.results ?? []).map((result) => {
    const verdict = result.verdict ?? 'unverifiable'
    const decision = latestDecision.get(result.artifactId)?.decision
    const criteria = (result.criteria ?? []).map((item) => {
      const criterionVerdict = item.verdict ?? 'unverifiable'
      return {
        id: item.id,
        layer: item.layer ?? 'deterministic',
        layerLabel: agentReviewLayerLabel(item.layer, locale),
        verdict: criterionVerdict,
        verdictLabel: agentReviewVerdictLabel(criterionVerdict, locale),
        evidence: item.evidence ?? '',
        // Skill 版本不可变，历史评审必须说得清当时按哪一版判的。
        ...(item.skillId ? { skillId: item.skillId, skillVersion: item.skillVersion } : {}),
      }
    })
    return {
      artifactId: result.artifactId,
      verdict,
      verdictLabel: agentReviewVerdictLabel(verdict, locale),
      ...(decision ? { decision, decisionLabel: agentReviewDecisionLabel(decision, locale) } : {}),
      // 自动结论从不代替人工批准，因此没有人工决定的候选一律算「等人」。
      awaitingHuman: !decision,
      criteria,
      unverifiedCount: criteria.filter((item) => item.verdict === 'unverifiable').length,
      ...(result.revisionProposal?.suggestion ? { revisionSuggestion: result.revisionProposal.suggestion } : {}),
    }
  })
}
