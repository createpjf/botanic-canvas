import { AgentToolRuntimeError, createAgentToolRegistry } from './agentToolRuntime.mjs'

const skillCatalog = Object.freeze({
  controlled_edit: {
    label: '受控局部编辑',
    instructions: '只改变用户明确允许变化的维度；人物、服装、商品等锁定项必须写入提示词，并且新结果不得覆盖父图。',
  },
  batch_variation: {
    label: '批量变量生成',
    instructions: '以素材组中的每个素材建立独立分支；继承同一父图和锁定项，每个分支保持独立状态、结果与重试记录。',
  },
  root_recipe_redo: {
    label: '原配方重做',
    instructions: '从根配方恢复原始参考、提示词和参数，创建独立首图分支；当前结果图不能作为直接输入。',
  },
})

export function botanicAgentBuiltInSkill(skillId) {
  const skill = skillCatalog[skillId]
  return skill ? { id: skillId, name: skill.label, instructions: skill.instructions } : undefined
}

export function botanicAgentSystemSkills() {
  return Object.entries(skillCatalog).map(([id, skill]) => ({
    id,
    name: skill.label,
    instructions: skill.instructions,
    source: 'system',
  }))
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  return value
}

function optionalText(value, name, maximumLength = 160) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  return value.trim()
}

function requiredText(value, name, maximumLength = 160) {
  const result = optionalText(value, name, maximumLength)
  if (!result) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  return result
}

function safeClone(value) {
  return structuredClone(value)
}

function boundedArguments(value, name) {
  const result = object(value, name)
  let serialized
  try {
    serialized = JSON.stringify(result)
  } catch {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  if (serialized.length > 8 * 1024) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数过大。`)
  }
  return safeClone(result)
}

function safeResultText(value, maximumLength = 4000) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maximumLength)
}

function safeArtifactUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  if (value.startsWith('/api/media/')) return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function artifactKindForMimeType(value) {
  if (typeof value !== 'string') return 'file'
  if (value.startsWith('image/')) return 'image'
  if (value.startsWith('video/')) return 'video'
  return 'file'
}

function mcpArtifacts(result, { actionId, externalTool }) {
  if (result?.isError) {
    throw new AgentToolRuntimeError('MCP_TOOL_FAILED', 'MCP 工具执行失败。', 502)
  }
  if (!Array.isArray(result?.content)) return []
  const artifacts = []
  const textContent = safeResultText(result.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n'))
  if (textContent) artifacts.push({
    kind: 'text', label: `MCP · ${externalTool}`, content: textContent, placement: 'panel',
  })
  for (const item of result.content) {
    if (item?.type !== 'resource_link') continue
    const url = safeArtifactUrl(item.uri)
    if (!url) continue
    const kind = artifactKindForMimeType(item.mimeType)
    artifacts.push({
      kind,
      placement: kind === 'image' || kind === 'video' ? 'canvas' : 'panel',
      label: safeResultText(item.title || item.name, 120) || 'MCP 文件',
      url,
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType.slice(0, 120) } : {}),
    })
  }
  return artifacts.slice(0, 20).map((artifact, index) => ({
    id: `artifact-${actionId}-${index + 1}`,
    ...artifact,
    provenance: { actionId, toolName: 'mcp_call', externalTool },
  }))
}

function artifactPlacement(artifact) {
  if (artifact.placement === 'canvas' || artifact.placement === 'panel') return artifact.placement
  return artifact.kind === 'image' || artifact.kind === 'video' ? 'canvas' : 'panel'
}

/**
 * 只为落点是 canvas 的 Artifact 生成节点命令。Skill 规则与 MCP 文本默认留在结果面板，
 * 不再无条件在画布上产生一个既不能当参考、又会抢走选中态的文字节点。
 */
function artifactCanvasCommands(artifacts, actionId) {
  return artifacts.flatMap((artifact, index) => {
    if (artifactPlacement(artifact) !== 'canvas') return []
    const type = artifact.kind === 'text' || artifact.kind === 'workflow'
      ? 'create_text_node'
      : artifact.kind === 'image' || artifact.kind === 'video'
        ? 'create_media_node'
        : undefined
    return type ? [{ id: `command-${actionId}-${index + 1}`, type, artifactId: artifact.id }] : []
  })
}

function planParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      intent: { type: 'string' },
      prompt: { type: 'string', maxLength: 6000 },
      summary: { type: 'string', maxLength: 240 },
      assetGroupId: { type: 'string', maxLength: 160 },
      constraints: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object' } },
    },
    required: ['intent', 'prompt', 'summary', 'constraints'],
  }
}

function clarificationParameters() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      question: { type: 'string', maxLength: 240 },
      helper: { type: 'string', maxLength: 240 },
      fields: {
        type: 'array', minItems: 1, maxItems: 3,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', enum: ['model', 'aspect_ratio', 'resolution'] },
            label: { type: 'string', maxLength: 80 },
          },
          required: ['id', 'label'],
        },
      },
    },
    required: ['question', 'fields'],
  }
}

export function createBotanicAgentPlanningToolRegistry({ input, finalizePlan, finalizeClarification, onProposeAction }) {
  if (!input || typeof finalizePlan !== 'function' || typeof finalizeClarification !== 'function') throw new TypeError('Agent 规划工具缺少可信上下文。')
  const projectSkills = Object.fromEntries((input.projectSkills ?? [])
    .filter((skill) => skill?.status === 'active' && typeof skill.id === 'string' && typeof skill.name === 'string' && typeof skill.instructions === 'string')
    .filter((skill) => !skillCatalog[skill.id])
    .slice(0, 30)
    .map((skill) => [skill.id, { label: skill.name, instructions: skill.instructions, source: 'project' }]))
  const availableSkills = { ...skillCatalog, ...projectSkills }
  const mountedSkillLabels = (input.mountedSkillIds ?? [])
    .map((skillId) => availableSkills[skillId]?.label)
    .filter(Boolean)
  const availableMcpTools = (input.availableMcpTools ?? [])
    .filter((item) => item && typeof item.server === 'string' && typeof item.tool === 'string')
    .slice(0, 30)
  const mcpToolKeys = new Set(availableMcpTools.map((item) => `${item.server}.${item.tool}`))
  const propose = typeof onProposeAction === 'function' ? onProposeAction : () => {}
  const tools = [
    {
      name: 'canvas_read',
      label: '读取画布上下文',
      description: '读取当前结果、生成参数和已连接参考的安全元数据，不返回图片、媒体地址或文件字节。',
      risk: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      validate: (raw) => object(raw, '画布读取'),
      execute: async () => safeClone({
        projectId: input.projectId,
        selectedResult: input.selectedResult,
        settings: input.settings,
        references: input.references,
      }),
    },
    {
      name: 'asset_search',
      label: '搜索素材',
      description: '按角色或关键词搜索本次规划可使用的素材组元数据。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { role: { type: 'string' }, query: { type: 'string' } },
      },
      validate: (raw) => {
        const value = object(raw, '素材搜索')
        return { role: optionalText(value.role, '素材角色', 80), query: optionalText(value.query, '搜索词', 120) }
      },
      execute: async ({ role, query }) => {
        const groups = input.assetGroups?.length ? input.assetGroups : input.assetGroup ? [input.assetGroup] : []
        const normalizedQuery = query?.toLocaleLowerCase('zh-CN')
        const matches = groups.filter((group) => (!role || group.role === role)
          && (!normalizedQuery || `${group.name} ${group.role}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery)))
        return { groups: safeClone(matches), total: matches.length }
      },
    },
    {
      name: 'skill_run',
      label: '调用创作 Skill',
      description: `调用 Botanic 已审核的创作规则。可用 Skill：${Object.keys(availableSkills).join('、')}。${mountedSkillLabels.length ? `当前已挂载，相关任务优先使用：${mountedSkillLabels.join('、')}。` : ''}`,
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { skillId: { type: 'string', enum: Object.keys(availableSkills) } },
        required: ['skillId'],
      },
      validate: (raw) => {
        const skillId = requiredText(object(raw, 'Skill 调用').skillId, 'Skill', 80)
        if (!availableSkills[skillId]) throw new AgentToolRuntimeError('SKILL_NOT_ALLOWED', `Skill 不在允许列表：${skillId}。`, 403)
        return { skillId }
      },
      execute: async ({ skillId }, context) => {
        const skill = availableSkills[skillId]
        propose({
          id: context?.toolCallId ?? `skill-${skillId}`,
          kind: 'skill',
          toolName: 'skill_apply',
          label: `应用 Skill：${skill.label}`,
          summary: `按「${skill.label}」约束本次创作，并把规则写回画布。`,
          risk: 'write',
          arguments: { skillId },
          status: 'awaiting_confirmation',
        })
        return { skillId, ...skill }
      },
    },
    {
      name: 'skill_create_propose',
      label: '提议创建项目 Skill',
      description: '当一组创作约束具有明确复用价值时，提议创建项目 Skill；只生成待确认行动，不直接写入项目。',
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 80 },
          instructions: { type: 'string', maxLength: 4000 },
          reason: { type: 'string', maxLength: 240 },
        },
        required: ['name', 'instructions', 'reason'],
      },
      validate: (raw) => {
        const value = object(raw, 'Skill 创建提议')
        return {
          name: requiredText(value.name, 'Skill 名称', 80),
          instructions: requiredText(value.instructions, 'Skill 规则', 4000),
          reason: requiredText(value.reason, '创建原因', 240),
        }
      },
      execute: async ({ name, instructions, reason }, context) => {
        const proposal = {
          id: context?.toolCallId ?? `skill-create-${name}`,
          kind: 'skill', toolName: 'skill_create', label: `创建 Skill：${name}`,
          summary: reason, risk: 'write', arguments: { name, instructions },
          status: 'awaiting_confirmation',
        }
        propose(proposal)
        return { proposed: true, actionId: proposal.id }
      },
    },
    ...(availableMcpTools.length ? [{
      name: 'mcp_propose',
      label: '提议 MCP 调用',
      description: `提议一个需要用户确认的外部 MCP 工具调用，不在规划阶段执行。允许的工具：${[...mcpToolKeys].join('、')}。`,
      risk: 'read',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          server: { type: 'string' }, tool: { type: 'string' },
          arguments: { type: 'object' }, reason: { type: 'string', maxLength: 240 },
        },
        required: ['server', 'tool', 'arguments', 'reason'],
      },
      validate: (raw) => {
        const value = object(raw, 'MCP 提议')
        const server = requiredText(value.server, 'MCP 服务', 80)
        const tool = requiredText(value.tool, 'MCP 工具', 80)
        const argumentsValue = boundedArguments(value.arguments, 'MCP 工具')
        const reason = requiredText(value.reason, 'MCP 调用原因', 240)
        if (!mcpToolKeys.has(`${server}.${tool}`)) {
          throw new AgentToolRuntimeError('MCP_TOOL_NOT_ALLOWED', `MCP 工具不在允许列表：${server}.${tool}。`, 403)
        }
        return { server, tool, arguments: argumentsValue, reason }
      },
      execute: async ({ server, tool, arguments: argumentsValue, reason }, context) => {
        const proposal = {
          id: context?.toolCallId ?? `mcp-${server}-${tool}`,
          kind: 'mcp', toolName: 'mcp_call', label: `调用 MCP：${server}.${tool}`,
          summary: reason, risk: 'external',
          arguments: { server, tool, arguments: argumentsValue },
          status: 'awaiting_confirmation',
        }
        propose(proposal)
        return { proposed: true, actionId: proposal.id, tool: `${server}.${tool}` }
      },
    }] : []),
    {
      name: 'generation_ask_clarification',
      label: '确认生成参数',
      description: '当用户目标或输出规格确实不清晰时，提出最多三个简短的参数选择问题；只返回问题卡，不执行生成。优先询问模型、比例和分辨率，不要重复询问上下文中已有且未要求改变的设置。',
      risk: 'read',
      terminal: true,
      parameters: clarificationParameters(),
      validate: (raw) => {
        const value = object(raw, '参数确认')
        const fields = Array.isArray(value.fields) ? value.fields : []
        if (!fields.length || fields.length > 3) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '参数确认字段无效。')
        return finalizeClarification({
          question: requiredText(value.question, '确认问题', 240),
          ...(value.helper !== undefined ? { helper: optionalText(value.helper, '确认说明', 240) } : {}),
          fields: fields.map((field, index) => {
            const item = object(field, `第 ${index + 1} 个确认字段`)
            return {
              id: requiredText(item.id, `第 ${index + 1} 个确认字段 ID`, 40),
              label: requiredText(item.label, `第 ${index + 1} 个确认字段名称`, 80),
            }
          }),
        })
      },
      execute: async (clarification) => clarification,
    },
    {
      name: 'generation_create_plan',
      label: '生成执行计划',
      description: '把用户要求转换成待确认的 Botanic 生图计划；只创建计划，不执行生成或修改画布。',
      risk: 'read',
      terminal: true,
      parameters: planParameters(),
      validate: (raw) => finalizePlan(object(raw, '生成计划')),
      execute: async (plan) => plan,
    },
  ]
  return createAgentToolRegistry(tools)
}

function actionHandler(handler, name) {
  return typeof handler === 'function'
    ? handler
    : async () => { throw new AgentToolRuntimeError('TOOL_NOT_CONFIGURED', `${name}尚未配置。`, 503) }
}

export function createBotanicAgentActionToolRegistry({
  createWorkflow,
  submitGeneration,
  applySkill,
  createSkill,
  mcpTools = {},
} = {}) {
  const workflowHandler = actionHandler(createWorkflow, '工作流创建工具')
  const generationHandler = actionHandler(submitGeneration, '生成提交工具')
  const applySkillHandler = actionHandler(applySkill, 'Skill 应用工具')
  const skillHandler = actionHandler(createSkill, 'Skill 创建工具')
  return createAgentToolRegistry([
    {
      name: 'workflow_create', label: '创建画布工作流',
      description: '在当前项目中创建新的文字、参考和生成节点，不覆盖已有节点。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: { type: 'object', additionalProperties: false, properties: { planId: { type: 'string' } }, required: ['planId'] },
      validate: (raw) => ({ planId: requiredText(object(raw, '工作流创建').planId, '计划') }),
      execute: workflowHandler,
    },
    {
      name: 'generation_submit', label: '提交生成任务',
      description: '提交一个已确认计划对应的真实生成任务，会产生模型费用。',
      risk: 'costly', requiresConfirmation: true, terminal: true,
      parameters: { type: 'object', additionalProperties: false, properties: { planId: { type: 'string' } }, required: ['planId'] },
      validate: (raw) => ({ planId: requiredText(object(raw, '生成提交').planId, '计划') }),
      execute: generationHandler,
    },
    {
      name: 'skill_apply', label: '应用项目 Skill',
      description: '读取已审核的项目或内置 Skill，并把规则作为本轮创作约束返回；不会在画布上创建节点。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { skillId: { type: 'string' } },
        required: ['skillId'],
      },
      validate: (raw) => ({ skillId: requiredText(object(raw, 'Skill 应用').skillId, 'Skill', 160) }),
      execute: async ({ skillId }, context) => {
        const result = await applySkillHandler({ skillId }, context)
        const skill = object(result?.skill, 'Skill 应用结果')
        const name = requiredText(skill.name, 'Skill 名称', 80)
        const instructions = requiredText(skill.instructions, 'Skill 规则', 4000)
        const actionId = context?.toolCallId ?? `skill-apply-${skillId}`
        const artifact = {
          id: `artifact-${actionId}-1`, kind: 'workflow', label: `Skill · ${name}`, content: instructions,
          placement: 'panel',
          provenance: { actionId, toolName: 'skill_apply' },
        }
        return {
          message: `已应用 Skill「${name}」。`,
          writeback: { kind: 'text', label: `Skill · ${name}`, content: instructions },
          artifacts: [artifact],
          canvasCommands: artifactCanvasCommands([artifact], actionId),
        }
      },
    },
    {
      name: 'skill_create', label: '创建项目 Skill',
      description: '创建项目级创作规则草稿；启用前必须由用户确认。',
      risk: 'write', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, instructions: { type: 'string' } },
        required: ['name', 'instructions'],
      },
      validate: (raw) => {
        const value = object(raw, 'Skill 创建')
        return { name: requiredText(value.name, 'Skill 名称', 80), instructions: requiredText(value.instructions, 'Skill 规则', 4000) }
      },
      execute: async (argumentsValue, context) => {
        const result = await skillHandler(argumentsValue, context)
        const skill = object(result?.skill, 'Skill 创建结果')
        const name = requiredText(skill.name, 'Skill 名称', 80)
        const instructions = requiredText(skill.instructions, 'Skill 规则', 4000)
        const actionId = context?.toolCallId ?? `skill-create-${name}`
        return {
          ...result,
          message: `已创建项目 Skill「${name}」。`,
          artifacts: [{
            id: `artifact-${actionId}-1`, kind: 'workflow', label: `Skill · ${name}`, content: instructions,
            placement: 'panel',
            provenance: { actionId, toolName: 'skill_create' },
          }],
        }
      },
    },
    {
      name: 'mcp_call', label: '调用外部工具',
      description: '调用服务端明确允许的 MCP 工具；服务器和工具名必须同时命中白名单。',
      risk: 'external', requiresConfirmation: true, terminal: true,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { server: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } },
        required: ['server', 'tool', 'arguments'],
      },
      validate: (raw) => {
        const value = object(raw, 'MCP 调用')
        const server = requiredText(value.server, 'MCP 服务', 80)
        const tool = requiredText(value.tool, 'MCP 工具', 80)
        const argumentsValue = boundedArguments(value.arguments, 'MCP 工具')
        const key = `${server}.${tool}`
        if (typeof mcpTools[key] !== 'function') throw new AgentToolRuntimeError('MCP_TOOL_NOT_ALLOWED', `MCP 工具不在允许列表：${key}。`, 403)
        return { key, arguments: argumentsValue }
      },
      execute: async ({ key, arguments: argumentsValue }, context) => {
        const result = await mcpTools[key](argumentsValue, context)
        const actionId = context?.toolCallId ?? `mcp-${key}`
        const artifacts = mcpArtifacts(result, { actionId, externalTool: key })
        const textArtifact = artifacts.find((artifact) => artifact.kind === 'text')
        return {
          message: `MCP 工具 ${key} 已执行。`,
          ...(textArtifact?.content ? { writeback: { kind: 'text', label: textArtifact.label, content: textArtifact.content } } : {}),
          ...(artifacts.length ? { artifacts, canvasCommands: artifactCanvasCommands(artifacts, actionId) } : {}),
        }
      },
    },
  ])
}
