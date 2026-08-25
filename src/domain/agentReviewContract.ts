/**
 * 结果自评契约：Run 终态后服务端用视觉模型评审整批结果，客户端把结论展示为会话消息。
 * 评审是派生数据，只影响展示；消息 id 按 Run 固定，重评与刷新都不会重复追加。
 */

export type BotanicAgentRunReviewItem = {
  nodeId: string
  branchLabel: string
  verdict: 'pass' | 'adjust'
  note: string
}

export type BotanicAgentRunReview = {
  summary: string
  bestNodeId?: string
  items: BotanicAgentRunReviewItem[]
  /** V2 持久化质量门：不影响旧格式读取。 */
  id?: string
  version?: 2
  runId?: string
  projectId?: string
  locale?: 'zh-CN' | 'en'
  status?: 'pending' | 'accepted' | 'rejected' | 'retry_requested'
  requiredCriteria?: string[]
  decisionNote?: string
  decidedBy?: string
  createdAt?: number
  updatedAt?: number
}

/** 评审消息的固定标识：一个 Run 只有一条评审消息。 */
export function botanicAgentRunReviewMessageId(runId: string) {
  return `agent-review-${runId}`
}

const verdictLabel = { pass: '达标', adjust: '建议调整' } as const
const englishVerdictLabel = { pass: 'Pass', adjust: 'Needs adjustment' } as const
const englishReviewFallback = 'Reviewed this round of results.'

/** 把结构化评审排成会话正文；措辞给出可执行的下一步，不只是打分。 */
export function formatBotanicAgentRunReviewMessage(review: BotanicAgentRunReview, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (locale === 'en') {
    const summary = /\p{Script=Han}/u.test(review.summary) ? englishReviewFallback : review.summary
    const lines = review.items.map((item, index) => {
      const marker = review.bestNodeId && item.nodeId === review.bestNodeId ? '★ ' : ''
      const note = /\p{Script=Han}/u.test(item.note) ? '' : item.note
      return `${index + 1}. ${marker}"${item.branchLabel}" — ${englishVerdictLabel[item.verdict]}${note ? ` — ${note}` : ''}`
    })
    const best = review.bestNodeId
      ? review.items.find((item) => item.nodeId === review.bestNodeId)
      : undefined
    return [
      `Reviewed ${review.items.length} ${review.items.length === 1 ? 'result' : 'results'} from this generation: ${summary}`,
      ...lines,
      best ? `Recommended: “${best.branchLabel}”.` : '',
      review.items.some((item) => item.verdict === 'adjust')
        ? 'Retry an adjusted branch from its task card, or tell me what you want to change.'
        : 'You can continue with another round from these results.',
    ].filter(Boolean).join('\n')
  }
  const lines = review.items.map((item, index) => {
    const marker = review.bestNodeId && item.nodeId === review.bestNodeId ? '★ ' : ''
    return `${index + 1}. ${marker}「${item.branchLabel}」${verdictLabel[item.verdict]}${item.note ? ` —— ${item.note}` : ''}`
  })
  const best = review.bestNodeId
    ? review.items.find((item) => item.nodeId === review.bestNodeId)
    : undefined
  return [
    `已看完这轮生成的 ${review.items.length} 张结果：${review.summary}`,
    ...lines,
    best ? `推荐「${best.branchLabel}」。` : '',
    review.items.some((item) => item.verdict === 'adjust')
      ? '想调整的分支可以在任务卡上重试，或直接告诉我要改哪里。'
      : '可以直接基于结果继续下一轮。',
  ].filter(Boolean).join('\n')
}
