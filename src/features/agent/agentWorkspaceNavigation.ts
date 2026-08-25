/**
 * Agent 工作台的层级消解规则。
 *
 * Escape 该关掉什么，原先是渲染层里一条 27 行的 `else if` 阶梯：优先级隐含在书写
 * 顺序里，插入一个新层很容易插错位置，而且没有任何东西能发现插错了。这里把优先级
 * 变成数据，顺序本身可被测试锁住。
 */

/** 由内到外的消解优先级。数组顺序即优先级，改动顺序会改变交互语义。 */
export const AGENT_DISMISS_PRIORITY = Object.freeze([
  // Composer 内的提及菜单最贴近光标，永远先关它。
  'mention',
  // 触发器旁的瞬态菜单。
  'contextMenu',
  'modeMenu',
  'history',
  'utilityMenu',
  // 二次确认比它所在的面板更内层：Escape 应该退出确认，而不是连面板一起关掉。
  'skillConfirm',
  'recoveryMenu',
  // 可展开的详情区。
  'runtimeDetails',
  // 常驻工具面板是最外层的可关闭物。
  'utilityPanel',
] as const)

export type AgentDismissLayer = typeof AGENT_DISMISS_PRIORITY[number]

/** `workspace` 表示已经没有内层可关，Escape 关闭整个工作台。 */
export type AgentDismissTarget = AgentDismissLayer | 'workspace'

export type AgentOpenLayers = Record<AgentDismissLayer, boolean>

/**
 * 当前开着这些层时，Escape 应该消解哪一个。
 * 只有全部内层都关闭后才返回 `workspace` —— 否则用户会在还有菜单开着时被整个关掉。
 */
export function agentEscapeDismissTarget(open: Partial<AgentOpenLayers>): AgentDismissTarget {
  return AGENT_DISMISS_PRIORITY.find((layer) => open[layer]) ?? 'workspace'
}
