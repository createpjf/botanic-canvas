import { AgentToolRuntimeError } from './agentToolRuntime.mjs'

// 只读上下文工具是 Agent 对话与回合规划共享的深模块：把项目本体、记忆、素材组与
// 已审核 Skill 的受控读取集中在一处，任何调用方都拿到同一套安全语义（不返回图片字节、
// 私有媒体地址或凭据）。工具参数由模型产出，因此校验失败按“Provider 非法工具参数”处理。

function invalidToolArguments(message) {
  throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', message)
}

function toolText(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim()) invalidToolArguments(`${name}不能为空。`)
  const result = value.trim()
  if (result.length > maximumLength) invalidToolArguments(`${name}过长。`)
  return result
}

function toolObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidToolArguments(`${name}无效。`)
  return value
}

function searchText(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-CN') : ''
}

function matchesQuery(item, query, fields) {
  if (!query) return true
  return fields.some((field) => searchText(item?.[field]).includes(query))
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
      description: '检索当前项目已保存的长期规则、认可方向和避免事项。没有命中时必须如实说明。',
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
        const matches = memory.filter((item) => !normalizedQuery || matchesQuery(item, normalizedQuery, ['id', 'kind', 'content']))
        return { total: matches.length, items: matches.slice(0, 30) }
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
      description: '读取当前项目已启用的 Skill 规则；Skill 只能作为参考，不能在日常对话中自动写回项目。',
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
        const matches = skills.filter((skill) => !normalizedQuery || matchesQuery(skill, normalizedQuery, ['id', 'name', 'instructions']))
        return { total: matches.length, skills: matches.slice(0, 30) }
      },
    },
  ]
}
