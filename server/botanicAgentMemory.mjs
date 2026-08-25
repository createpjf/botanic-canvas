/**
 * Memory V2 选择器：**项目内唯一的记忆读取路径**（ADR 0006）。
 *
 * 任何构造 Prompt、Plan 或不可变工作流定义的位置都必须经过这里。绕过它直接读原始
 * 集合会让过滤规则（未激活项、范围、墓碑）在部分路径失效 —— 这已经实际发生过：
 * 生产工作流草稿曾直接 `agentMemory.map(item => item.content)`，把未确认的记忆写进
 * 了不可变定义。
 *
 * 选择器不负责写入；显式的人类保存/评审闭环仍是唯一写入入口。
 */

/**
 * 选择分档。用分档而不是「一个总分 + 阈值」，是因为阈值会把「本轮措辞没有字面命中」
 * 等同于「不相关」：用户存下的规则本来就不会和每次查询用同样的措辞（ADR 0006）。
 *
 * - `matched`：本轮查询字面命中，或关联到本轮上下文节点。
 * - `standing`：用户自己确认过的常驻规则。**不因未命中而落选。**
 * - `weak`：既没命中、也不是人工确认来源。有查询时才丢弃。
 */
export const MEMORY_SELECTION_TIERS = Object.freeze(['matched', 'standing', 'weak'])

const tierRank = Object.freeze({ matched: 2, standing: 1, weak: 0 })

function normalized(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-CN') : ''
}

/**
 * 记忆是否处于生效态。
 *
 * `status` 是激活开关，`confidence` 是可信程度，两者不能互相顶替（ADR 0006）。
 * 早期实现只有 `confidence`，因此没有 `status` 的历史记忆按 `confidence` 兼容判定：
 * provisional 视为待确认（不生效），其余视为生效。
 */
export function isActiveMemory(item) {
  if (!item) return false
  if (typeof item.status === 'string') return item.status === 'active'
  return item.confidence !== 'provisional'
}

/** 用户自己确认过的规则：人工来源且已生效。这类记忆常驻，不参与「是否命中」的淘汰。 */
function isStandingRule(item) {
  return isActiveMemory(item) && item.source === 'human'
}

function scopeWeight(scope) {
  // 越具体的范围对本项目越相关。scope 目前是三值；扩成品牌/产品/渠道时在这里加档。
  if (scope === 'run') return 3
  if (scope === 'project') return 2
  if (scope === 'workspace') return 1
  return 0
}

/** 冲突是对称的：任一侧声明即成立，否则单方面声明会被另一侧忽略。 */
function conflictsBetween(left, right) {
  return Boolean(left.conflictsWith?.includes(right.id) || right.conflictsWith?.includes(left.id))
}

/**
 * 可信程度的数值口径（Epic 6 §8.6 的 `confidence: number`）。
 *
 * **不改存储、不迁移历史数据**：仍以枚举为准，数值是读时派生的。原先推迟这一项的
 * 理由是「改数值要迁移全部历史数据与每处读取」—— 那说的是把枚举换成数值。这里是
 * 叠加：写侧可选给 `confidenceScore`，没给就按枚举派生，两条路径得到同一个量纲。
 *
 * 有了数值，排序才能在**同一档内**分出高低：此前 `confirmed` 一律加 4 分，两条都
 * 确认过的记忆完全平手，谁在前只取决于数组顺序。
 *
 * @param {{ confidence?: string, confidenceScore?: number }} item
 */
export function memoryConfidenceScore(item) {
  const explicit = Number(item?.confidenceScore)
  // 写侧显式给的分数优先，但必须落在 [0,1]：越界值按「没给」处理，
  // 而不是夹到边界 —— 夹了之后一个写错的 42 会变成「最高可信度」。
  if (Number.isFinite(explicit) && explicit >= 0 && explicit <= 1) return explicit
  return item?.confidence === 'provisional' ? 0.4 : 0.85
}

function selectionOf(item, query, contextNodeIds) {
  const text = normalized(`${item.id} ${item.kind} ${item.content}`)
  const literalHit = Boolean(query) && text.includes(query)
  const contextHit = contextNodeIds.some((id) => item.sourceNodeIds?.includes(id))
  const tier = literalHit || contextHit ? 'matched' : isStandingRule(item) ? 'standing' : 'weak'
  let score = 0
  if (literalHit) score += 8
  if (contextHit) score += 5
  // 可信程度按数值计入，同一档内也能分出高低（此前 confirmed 一律 +4，两条都确认过的
  // 记忆完全平手，谁在前只取决于数组顺序）。系数保持 4，`confirmed` 仍得约 3.4 分，
  // 与改动前的相对排序基本一致，不会让既有选择结果整体翻盘。
  score += memoryConfidenceScore(item) * 4
  if (item.source === 'human') score += 2
  score += scopeWeight(item.scope)
  return {
    item,
    tier,
    score,
    reason: literalHit
      ? `匹配本轮检索「${query}」`
      : contextHit
        ? '关联本轮画布上下文'
        : '用户确认的常驻项目规则',
  }
}

/**
 * @param {Array} memory 项目记忆原始集合。
 * @param {{ query?: string, contextNodeIds?: string[], limit?: number }} options
 * @returns {{
 *   total: number,
 *   items: Array,
 *   selections: Array<{ item: any, tier: string, score: number, reason: string }>,
 *   conflicts: Array<{ keptId: string, droppedId: string }>,
 *   zeroHit: boolean,
 *   matchedQuery: boolean,
 * }}
 *   `zeroHit` 表示一条都没返回；`matchedQuery` 单独表示本轮查询是否真的命中过 ——
 *   两者必须分开，否则「没命中但给了常驻规则」只能被说成「找到了」，读者无从判断
 *   这些规则是不是针对他这次问题的。
 */
export function selectBotanicAgentMemory(memory = [], { query = '', contextNodeIds = [], limit = 12 } = {}) {
  const normalizedQuery = normalized(query)
  const nodeIds = [...new Set((contextNodeIds ?? []).filter((id) => typeof id === 'string'))]
  const ranked = (Array.isArray(memory) ? memory : [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.content === 'string')
    // 未激活的记忆只作为人工审核候选保留，不可被 Planner/执行层当成品牌事实。
    .filter(isActiveMemory)
    .map((item) => selectionOf(item, normalizedQuery, nodeIds))
    // 有查询时才淘汰，且只淘汰 weak；standing 是用户确认过的规则，不因措辞未命中而落选。
    .filter((selection) => !normalizedQuery || selection.tier !== 'weak')
    .sort((left, right) => tierRank[right.tier] - tierRank[left.tier]
      || right.score - left.score
      // 时效：同分时新的规则在前。
      || (Number(right.item.updatedAt) || 0) - (Number(left.item.updatedAt) || 0)
      || String(left.item.id).localeCompare(String(right.item.id)))
  // 冲突消解：相互矛盾的记忆不得同时进入同一个 Plan（ADR 0006）。排序在前的胜出，
  // 落选的**记录下来**而不是静默丢弃 —— 静默丢弃会让「为什么这条规则没生效」无从解释。
  const selections = []
  const conflicts = []
  for (const selection of ranked) {
    const blocker = selections.find(({ item }) => conflictsBetween(item, selection.item))
    if (blocker) {
      conflicts.push({ keptId: blocker.item.id, droppedId: selection.item.id })
      continue
    }
    selections.push(selection)
    if (selections.length >= Math.max(1, Math.min(Number(limit) || 12, 30))) break
  }
  return {
    total: selections.length,
    items: selections.map((selection) => selection.item),
    selections,
    conflicts,
    zeroHit: selections.length === 0,
    matchedQuery: selections.some((selection) => selection.tier === 'matched'),
  }
}

/**
 * 计划 / 工作流定义里记录的记忆绑定。
 *
 * 版本与内容摘要随绑定落库，`selectionReason` 说明「为什么用了这条」—— 这是
 * 「Run 可展示使用了哪些规则以及为什么使用」的落点，也是绑定进计划指纹的内容。
 */
export function memoryBindingSnapshot(memory = [], options = {}) {
  return selectBotanicAgentMemory(memory, options).selections.map(({ item, reason }) => ({
    id: item.id,
    ...(item.version ? { version: item.version } : {}),
    ...(item.contentHash ? { contentHash: item.contentHash } : {}),
    selectionReason: reason,
  }))
}
