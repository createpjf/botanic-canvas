import { agentToolObject as toolObject, agentToolText as toolText } from './agentToolRuntime.mjs'
import { selectBotanicAgentMemory } from '../semantic/botanicAgentMemory.mjs'

// 只读上下文工具是 Agent 对话与回合规划共享的深模块：把项目本体、记忆、素材组与
// 已审核 Skill 的受控读取集中在一处，任何调用方都拿到同一套安全语义（不返回图片字节、
// 私有媒体地址或凭据）。工具参数由模型产出，因此校验失败按“Provider 非法工具参数”处理。

function searchText(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-CN') : ''
}

function matchesQuery(item, query, fields) {
  if (!query) return true
  return fields.some((field) => searchText(item?.[field]).includes(query))
}

/** Skill 摘要:正文首个非空非标题行,兜底标题行;单行截断,不展开全文。 */
function skillSummary(instructions) {
  if (typeof instructions !== 'string') return ''
  const lines = instructions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines.find((line) => !line.startsWith('#')) ?? lines[0] ?? '').slice(0, 160)
}

const SOURCE_LABELS = new Map([
  ['ontology_read', '项目本体'],
  ['project_memory_search', '项目记忆'],
  ['asset_group_search', '素材组'],
  ['skill_search', '项目 Skill'],
])

export function botanicAgentContextToolSourceLabels(toolCalls) {
  return [...new Set((toolCalls ?? []).map((call) => SOURCE_LABELS.get(call.name)).filter(Boolean))]
}

export function createBotanicAgentReadToolDefinitions({ ontology, memory, skills }) {
  return [
    {
      name: 'ontology_read',
      label: '读取项目本体',
      description: '读取当前项目、画布节点关系和上下文节点的安全元数据；不返回图片、媒体地址或文件字节。项目相关问题优先调用。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string', maxLength: 120 } },
      },
      validate: (raw) => {
        const value = toolObject(raw, '本体读取')
        return { query: value.query === undefined ? '' : toolText(value.query, '本体检索词', 120) }
      },
      execute: async ({ query }) => {
        const normalizedQuery = searchText(query)
        const nodes = ontology.nodes.filter((node) => !normalizedQuery || matchesQuery(node, normalizedQuery, ['id', 'type', 'label', 'role']))
        const nodeIds = new Set(nodes.map((node) => node.id))
        const edges = ontology.edges.filter((edge) => !normalizedQuery || (nodeIds.has(edge.source) && nodeIds.has(edge.target)))
        const groups = ontology.assetGroups.filter((group) => !normalizedQuery || matchesQuery(group, normalizedQuery, ['id', 'name', 'role']))
        return {
          project: ontology.project,
          counts: { nodes: ontology.nodes.length, edges: ontology.edges.length, assetGroups: ontology.assetGroups.length },
          contextNodeIds: ontology.contextNodeIds,
          nodes: normalizedQuery ? nodes.slice(0, 80) : ontology.nodes.slice(0, 160),
          edges: edges.slice(0, 200),
          assetGroups: groups.slice(0, 80),
        }
      },
    },
    {
      name: 'project_memory_search',
      label: '检索项目记忆',
      description: '检索当前项目已保存的长期规则、认可方向和避免事项。检索词没有命中时仍会返回当前生效的常驻规则，此时 matchedQuery 为 false，必须如实说明这些规则不是针对本次检索词的。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string', maxLength: 120 } },
      },
      validate: (raw) => {
        const value = toolObject(raw, '项目记忆检索')
        return { query: value.query === undefined ? '' : toolText(value.query, '记忆检索词', 120) }
      },
      execute: async ({ query }) => {
        const normalizedQuery = searchText(query)
        const selected = selectBotanicAgentMemory(memory, { query: normalizedQuery, limit: 30 })
        // 不回传 selections：里面是同一批记忆的重复副本，只会把工具结果撑大。
        return {
          total: selected.total,
          items: selected.items,
          zeroHit: selected.zeroHit,
          matchedQuery: selected.matchedQuery,
          // 冲突落选必须可见：静默丢弃会让「这条规则为什么没生效」无从解释。
          ...(selected.conflicts.length ? { conflicts: selected.conflicts } : {}),
        }
      },
    },
    {
      name: 'asset_group_search',
      label: '检索素材组',
      description: '按名称、角色或素材组 ID 检索当前项目素材组的安全元数据，不读取图片内容。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string', maxLength: 120 }, role: { type: 'string', maxLength: 40 } },
      },
      validate: (raw) => {
        const value = toolObject(raw, '素材组检索')
        return {
          query: value.query === undefined ? '' : toolText(value.query, '素材组检索词', 120),
          role: value.role === undefined ? '' : toolText(value.role, '素材组角色', 40),
        }
      },
      execute: async ({ query, role }) => {
        const normalizedQuery = searchText(query)
        const normalizedRole = searchText(role)
        const groups = ontology.assetGroups.filter((group) => (!normalizedRole || searchText(group.role) === normalizedRole)
          && (!normalizedQuery || matchesQuery(group, normalizedQuery, ['id', 'name', 'role'])))
        return { total: groups.length, groups: groups.slice(0, 80) }
      },
    },
    {
      name: 'skill_search',
      label: '检索已审核 Skill',
      description: '检索当前项目已启用 Skill 的目录（名称、能力与一句摘要），不返回完整正文。需要正文时调用 skill_run 或请用户在输入框挂载；Skill 只能作为参考，不能在日常对话中自动写回项目。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string', maxLength: 120 } },
      },
      validate: (raw) => {
        const value = toolObject(raw, 'Skill 检索')
        return { query: value.query === undefined ? '' : toolText(value.query, 'Skill 检索词', 120) }
      },
      execute: async ({ query }) => {
        const normalizedQuery = searchText(query)
        // 渐进式披露:检索是第二级(selection),按正文匹配但只回 metadata + 摘要;
        // 完整正文归第三级(skill_run 调用或 Composer 挂载)。整段回传曾让一次宽泛
        // 检索带回 30 份正文,再被工具输出预算静默截断——被丢弃的是整条 Skill 而
        // 不是正文细节,模型无从知道目录不完整。
        const matches = skills.filter((skill) => !normalizedQuery || matchesQuery(skill, normalizedQuery, ['id', 'name', 'instructions']))
        return {
          total: matches.length,
          skills: matches.slice(0, 30).map((skill) => ({
            id: skill.id,
            name: skill.name,
            ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
            ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities } : {}),
            summary: skillSummary(skill.instructions),
          })),
        }
      },
    },
  ]
}
