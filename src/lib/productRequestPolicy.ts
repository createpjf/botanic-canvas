const defaultProductRequestTimeoutMs = 15_000
const promptRefinementRequestTimeoutMs = 45_000

/**
 * 润色调用包含一次外部模型推理，必须晚于 API 的 30 秒 Provider 窗口结束；
 * 其余工作区请求继续快速失败，避免放大数据库或网络故障。
 */
export function productRequestTimeoutFor(path: string) {
  return path === '/api/prompt-refinements'
    ? promptRefinementRequestTimeoutMs
    : defaultProductRequestTimeoutMs
}
