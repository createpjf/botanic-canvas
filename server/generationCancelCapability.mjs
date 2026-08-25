// @ts-check

/**
 * Provider 取消能力矩阵。
 *
 * 这张表存在的原因是：**当前没有任何一个接入的 Provider 支持提交后停止计费。**
 * 因此「取消」对用户的真实含义取决于任务是否已经派发，界面必须照实说，不能笼统
 * 地暗示取消等于省钱。
 *
 * - `remote-cancel`：Provider 提供取消端点，能真正终止已提交的作业。目前无。
 * - `local-abort-only`：只能中止本地等待。作业已提交给 Provider，费用可能已产生。
 *
 * 核对依据（2026-08-24）：
 * - OpenAI 图像走同步 `POST /v1/images/{generations,edits}`，无取消端点。
 * - MiniMax 图像走同步 `POST /v1/image_generation`，未见取消端点。
 * - MiniMax H3 视频是 submit → task_id → 轮询 `/v2/query/video_generation/{id}`。
 *   中止轮询能立刻释放 worker（视频轮询是分钟级，收益最大），但作业仍在 Provider
 *   侧执行。是否存在取消端点未经确认，确认后再把它移入 `remote-cancel`。
 */
export const PROVIDER_CANCEL_CAPABILITIES = Object.freeze({
  openai: 'local-abort-only',
  minimax: 'local-abort-only',
})

/** 未知 Provider 按最保守处理：不能声称能停止计费。 */
export function providerCancelCapability(provider) {
  return PROVIDER_CANCEL_CAPABILITIES[provider] ?? 'local-abort-only'
}

/**
 * 取消一个任务对用户的真实后果。
 *
 * 唯一真能省下费用的路径是「尚未派发就取消」—— 队列里移除后 Provider 根本不会被
 * 调用。已经在执行的任务只能停止采用结果并释放 worker 槽位。
 *
 * @param {{ status?: string, provider?: string, capability?: string }} input
 *   `capability` 可直接传入（调用方已知时省一次查表；也让 remote-cancel 分支可测）。
 * @returns {{
 *   billing: 'none' | 'possible',
 *   capability: string,
 *   workerReleased: boolean,
 *   code: string,
 * }}
 */
export function generationCancelOutcome(input = {}) {
  const capability = input.capability ?? providerCancelCapability(input.provider)
  // queued 表示 Worker 还没取走它，队列移除即彻底阻止提交。
  if (input.status === 'queued') {
    return { billing: 'none', capability, workerReleased: false, code: 'CANCELLED_BEFORE_DISPATCH' }
  }
  if (input.status === 'running') {
    return {
      billing: capability === 'remote-cancel' ? 'none' : 'possible',
      capability,
      // 中止本地等待会立刻释放 worker 槽位，即使远端仍在执行。
      workerReleased: true,
      code: capability === 'remote-cancel' ? 'CANCELLED_AT_PROVIDER' : 'CANCELLED_RESULT_DISCARDED',
    }
  }
  // 已终态：取消是无操作，不产生新的计费判断。
  return { billing: 'none', capability, workerReleased: false, code: 'ALREADY_SETTLED' }
}
