// @ts-check
import { AgentSubtaskError, assertSubtaskToolAllowlist } from '../../agentSubtask.mjs'
import { canonicalHash } from '../../canonicalHash.mjs'
import { createAgentToolRegistry, freezeAgentStepSnapshot } from '../../agentToolRuntime.mjs'

/**
 * 为一次子 Agent activation 冻结最小工具面。
 *
 * 能力只从服务端 Registry 取，`allowedTools` 只负责继续缩小范围，不能提供工具定义。
 * 因此客户端即使伪造同名工具 Schema，也没有任何路径把它放进模型可见的能力快照。
 *
 * @param {{
 *   registry: any,
 *   allowedTools: string[],
 *   executeTool?: (name: string, input: any, context: any) => Promise<any>,
 * }} input
 */
export function createAgentSubagentToolRegistry(input) {
  const { registry, allowedTools, executeTool } = input ?? {}
  if (!registry || typeof registry.get !== 'function') {
    throw new AgentSubtaskError('SUBTASK_TOOL_REGISTRY_REQUIRED', '子 Agent 缺少服务端工具注册表。', 500)
  }

  const names = [...new Set(assertSubtaskToolAllowlist(allowedTools, registry))]
  const definitions = names.map((name) => {
    const source = registry.get(name)
    // assertSubtaskToolAllowlist 已经验证过存在性与治理声明；这里捕获函数引用和结构化
    // 字段，之后即使调用方替换自己的 Registry，也不会改变本 activation 的工具面。
    const validate = source.validate
    const execute = source.execute
    const receipt = source.receipt
    return {
      name: source.name,
      label: source.label,
      description: source.description,
      parameters: source.parameters,
      risk: source.risk,
      recovery: source.recovery,
      requiresConfirmation: false,
      terminal: false,
      ...(typeof receipt === 'function' ? { receipt } : {}),
      validate: (value, context) => validate(value, context),
      execute: async (value, context) => {
        if (context?.signal?.aborted) {
          throw new AgentSubtaskError('SUBTASK_ABORTED', '子 Agent 工具调用已取消。', 499)
        }
        return typeof executeTool === 'function'
          ? executeTool(name, value, context)
          : execute(value, context)
      },
    }
  })

  // createAgentToolRegistry 会深拷贝/冻结参数 Schema，并固定 capabilitySnapshot。
  return createAgentToolRegistry(definitions)
}

/** 无工具的旧调用兼容路径；空 Registry 仍然是一份冻结能力快照。 */
export function createEmptyAgentSubagentToolRegistry() {
  return createAgentToolRegistry([])
}

/**
 * Start service 与 Runner 共用的能力快照算法。descriptor 只负责缩小工具面；工具的
 * Schema、风险与恢复语义始终取服务端 Registry。
 *
 * @param {{ descriptor: any, registry: any, fallbackModel?: string }} input
 */
export function agentSubagentCapabilitySnapshot(input) {
  const { descriptor, registry, fallbackModel } = input ?? {}
  const descriptorModel = typeof descriptor?.model === 'string' ? descriptor.model.trim() : ''
  const model = descriptorModel || (typeof fallbackModel === 'string' ? fallbackModel.trim() : '')
  if (!model) throw new AgentSubtaskError('SUBAGENT_MODEL_UNAVAILABLE', '子 Agent 能力快照缺少模型。', 503)
  const filtered = createAgentSubagentToolRegistry({
    registry,
    allowedTools: descriptor?.allowedTools,
  })
  const runtimeSnapshot = freezeAgentStepSnapshot({ registry: filtered, model, role: descriptor?.role })
  const instructionsVersion = typeof descriptor?.instructionsVersion === 'string'
    ? descriptor.instructionsVersion.trim()
    : ''
  if (!instructionsVersion || !descriptor?.outputSchema || descriptor.outputSchema.type !== 'object') {
    throw new AgentSubtaskError(
      'SUBTASK_CAPABILITY_SNAPSHOT_INVALID',
      '子 Agent 能力快照缺少指令版本或输出 Schema。',
      409,
    )
  }
  // Prompt 指令与输出契约同样属于能力边界；否则工具未变时，入队后的指令/Schema
  // 漂移仍会错误通过 capability fence。
  return Object.freeze({
    ...runtimeSnapshot,
    instructionsVersion,
    outputKind: descriptor.outputKind,
    outputSchemaHash: canonicalHash(descriptor.outputSchema),
  })
}

/** @param {{ descriptor: any, registry: any, fallbackModel?: string }} input */
export function agentSubagentCapabilityHash(input) {
  return canonicalHash(agentSubagentCapabilitySnapshot(input))
}
