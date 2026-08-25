import type { ProductLocale } from '../i18n/core'

/** 与服务端 `generationCancelCapability.mjs` 的判定同构。 */
export type GenerationCancelOutcome = {
  billing: 'none' | 'possible'
  capability: string
  workerReleased: boolean
  code: string
}

/**
 * 取消回执：服务端在取消那一刻写下的持久记录。字段是判定的超集，因此它本身
 * 就能直接喂给文案函数 —— 刷新页面后不必再问服务端一次就能照实说明费用。
 */
export type GenerationCancelRecord = GenerationCancelOutcome & {
  requestedAt: number
  reason: string
  requestedBy?: string
}

/**
 * 取消结果的用户可读说明。
 *
 * 这里存在的唯一理由是**不要撒谎**：当前接入的 Provider 都不支持提交后停止计费，
 * 所以对已经派发的任务说「已取消」会让用户以为省下了费用。文案必须区分：
 *
 * - 尚未派发就取消 → 确实没有产生费用，可以直说。
 * - 已在执行 → 只能停止采用结果并释放算力，费用可能已产生，必须照实说。
 *
 * 判定本身在服务端（它才知道任务取消前的状态与 Provider 能力），这里只负责措辞。
 */
export function generationCancelMessage(
  outcome: GenerationCancelOutcome | undefined,
  locale: ProductLocale = 'zh-CN',
) {
  if (!outcome) {
    return locale === 'en' ? 'Generation cancelled.' : '已取消生成。'
  }
  if (outcome.code === 'ALREADY_SETTLED') {
    return locale === 'en' ? 'This task had already finished.' : '该任务已经结束，无需取消。'
  }
  if (outcome.billing === 'none') {
    return locale === 'en'
      ? 'Cancelled before dispatch. No generation quota was used.'
      : '已在派发前取消，未消耗生成额度。'
  }
  // 这是最重要的一条：不能只说「已取消」。
  return locale === 'en'
    ? 'Stopped using the result. The provider may have already run this request, so quota may have been consumed.'
    : '已停止采用结果。任务已提交给生成服务，费用可能已产生。'
}

/**
 * 取消后写给画布助手的完整文案：计费判定 + 明确说清画布留下了什么。
 *
 * 取消会把任务节点改成 `cancelled` 但不删除提示词与参考组，用户看不到这一点时
 * 会以为需要从头再来，所以这句必须跟着计费判定一起出现。
 */
export function generationCancelAssistantMessage(
  outcome: GenerationCancelOutcome | undefined,
  locale: ProductLocale = 'zh-CN',
) {
  const preserved = locale === 'en'
    ? ' The canvas keeps this round of prompt, reference group and task record.'
    : '画布保留本次的提示词、参考组与任务记录。'
  return `${generationCancelMessage(outcome, locale)}${preserved}`
}
