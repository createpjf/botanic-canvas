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

/**
 * 适用主体（Epic 6 §8.6 的五值 `scope`）。
 *
 * 它与既有的 `scope` 是**两个轴**，不能合成一个七值枚举：`scope` 是包含范围
 * （run/project/workspace，影响排序权重），这里是**适用条件**（这条规则该不该
 * 参与这一次生成）。合并会重犯 status/confidence 那类错误。
 *
 * 解决的是一个正在发生的缺陷：今天所有 active 记忆进入**每一次**生成，`scope` 只
 * 影响排序、从不排除。于是「天猫主图顶部留 20% 安全区」会同样作用在京东项上，
 * 用户只能把「（仅天猫）」写进正文，指望模型自己注意到。
 *
 * 顺序即具体程度，越靠后越具体（用于同分时排序）。
 */
export const MEMORY_SUBJECTS = Object.freeze(['project', 'brand', 'product', 'channel', 'user'])

/** 每个主体从执行上下文的哪个字段取值。四个来源都已存在，不需要新基础设施。 */
const subjectContextKey = Object.freeze({
  brand: 'brandId',      // Epic 9.1：document.brandId
  product: 'sku',        // Epic 7：批量项 input.sku
  channel: 'channel',    // Epic 7：批量项 input.channel
  user: 'userId',        // Run 的 ownerId
})

const subjectLabels = Object.freeze({
  brand: '品牌', product: '产品', channel: '渠道', user: '用户', project: '项目',
})

/**
 * 一条记忆是否适用于本次执行。
 *
 * 三种结果，**必须分开**：
 * - `applies`：适用（缺省的 project 主体永远适用，等于今天的行为）。
 * - `context_missing`：本次执行根本没有那个维度（例如画布手工生成没有渠道）。
 * - `context_mismatch`：有那个维度但取值不同（本次是京东、规则限定天猫）。
 *
 * 后两者的修法完全不同：一个是「这次生成没有渠道信息」，一个是「这条规则不适用于
 * 京东」。合并成一句「未生效」，用户无从判断该改规则还是改这次运行。
 *
 * `context_missing` 判**不适用**而不是放行：用户写「仅天猫」就是这个意思，把它用在
 * 没有渠道的场景等于应用了一条他说过不要应用的规则。代价是画布生成可能一条规则都
 * 不剩 —— 所以落选必须可见，这与冲突消解是同一个原则。
 *
 * @param {{ subject?: string, subjectValue?: string }} item
 * @param {Record<string, string | undefined>} context
 */
export function memorySubjectApplicability(item, context = {}) {
  const subject = typeof item?.subject === 'string' ? item.subject : 'project'
  if (!MEMORY_SUBJECTS.includes(subject)) {
    // 未知主体按最保守处理：不适用。未知值可能来自更新的写侧，放行等于凭空扩大适用面。
    return { applies: false, code: 'subject_unknown', detail: `未知的适用主体「${subject}」。` }
  }
  if (subject === 'project') return { applies: true }
  const value = typeof item?.subjectValue === 'string' ? item.subjectValue.trim() : ''
  if (!value) {
    // 限定了主体却没给取值，规则本身是残缺的。
    return { applies: false, code: 'subject_value_missing', detail: `限定了${subjectLabels[subject]}但没有指定具体取值。` }
  }
  const actual = context?.[subjectContextKey[subject]]
  if (typeof actual !== 'string' || !actual.trim()) {
    return {
      applies: false,
      code: 'context_missing',
      detail: `这条规则限定${subjectLabels[subject]}「${value}」，但本次生成没有${subjectLabels[subject]}信息。`,
    }
  }
  if (actual.trim() !== value) {
    return {
      applies: false,
      code: 'context_mismatch',
      detail: `这条规则限定${subjectLabels[subject]}「${value}」，本次是「${actual.trim()}」。`,
    }
  }
  return { applies: true, subject, value }
}

/** 主体越具体，同分时越靠前。 */
function subjectWeight(item) {
  const index = MEMORY_SUBJECTS.indexOf(typeof item?.subject === 'string' ? item.subject : 'project')
  return index > 0 ? index : 0
}

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
  // 主体越具体越靠前：一条限定渠道的规则比一条全项目规则更针对本次执行。
  score += subjectWeight(item)
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
 * @param {{
 *   query?: string, contextNodeIds?: string[], limit?: number,
 *   context?: { brandId?: string, sku?: string, channel?: string, userId?: string },
 * }} options
 *   `context` 是本次执行的身份维度。不给等于「没有任何维度信息」，于是所有限定了
 *   主体的规则都会落进 `filtered` —— 这是有意的：调用方没有把上下文传进来时，
 *   宁可少用规则并说明，也不要按「碰巧适用」放行。
 * @returns {{
 *   total: number,
 *   items: Array,
 *   selections: Array<{ item: any, tier: string, score: number, reason: string }>,
 *   conflicts: Array<{ keptId: string, droppedId: string }>,
 *   filtered: Array<{ id: string, code: string, detail: string }>,
 *   zeroHit: boolean,
 *   matchedQuery: boolean,
 * }}
 *   `zeroHit` 表示一条都没返回；`matchedQuery` 单独表示本轮查询是否真的命中过 ——
 *   两者必须分开，否则「没命中但给了常驻规则」只能被说成「找到了」，读者无从判断
 *   这些规则是不是针对他这次问题的。
 *   `filtered` 是因适用范围不符而落选的规则**及其原因**，与冲突落选同一原则：
 *   静默丢弃会让「为什么这条规则没生效」无从解释。
 */
export function selectBotanicAgentMemory(memory = [], {
  query = '', contextNodeIds = [], limit = 12, context = {}, applySubjectFilter = true,
} = {}) {
  const normalizedQuery = normalized(query)
  const nodeIds = [...new Set((contextNodeIds ?? []).filter((id) => typeof id === 'string'))]
  /** @type {Array<{ id: string, code: string, detail: string }>} */
  const filtered = []
  const ranked = (Array.isArray(memory) ? memory : [])
    .filter((item) => item && typeof item.id === 'string' && typeof item.content === 'string')
    // 未激活的记忆只作为人工审核候选保留，不可被 Planner/执行层当成品牌事实。
    .filter(isActiveMemory)
    // 适用范围过滤。**排除而不是降权**：降权只是让它排在后面，限额一满照样进 Prompt。
    .filter((item) => {
      // 唯一允许关掉它的场景是**固定工作流版本**：那一刻还没有批量项，也就没有
      // 渠道/产品可比，此时过滤会把限定渠道的规则挡在版本之外，执行期再也挑不出来。
      // 除此之外一律不要关 —— 关掉等于让规则回到「无差别进每一次生成」。
      if (!applySubjectFilter) return true
      const applicability = memorySubjectApplicability(item, context)
      if (applicability.applies) return true
      filtered.push({ id: item.id, code: applicability.code, detail: applicability.detail })
      return false
    })
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
    filtered,
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
