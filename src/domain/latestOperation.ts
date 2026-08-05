export type LatestOperation = {
  begin: () => number
  isCurrent: (token: number) => boolean
  invalidate: () => void
}

/**
 * 为“只允许最后一次异步结果落地”的流程生成单调令牌。
 * 调用方不需要共享请求对象，也不会把项目切换和具体网络实现耦合在一起。
 */
export function createLatestOperation(): LatestOperation {
  let currentToken = 0
  return {
    begin() {
      currentToken += 1
      return currentToken
    },
    isCurrent(token) {
      return token === currentToken
    },
    invalidate() {
      currentToken += 1
    },
  }
}
