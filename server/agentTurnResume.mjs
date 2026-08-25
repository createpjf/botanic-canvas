// @ts-check
import { resolveBotanicAgentTurn } from './botanicAgentTurn.mjs'

/** 与路由层同一份映射：Skill 只把可解释字段交给规划器，不交内部记录。 */
function plannerSkillInput(skill) {
  return {
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    status: skill.status,
    ...(Number.isInteger(skill.version) ? { version: skill.version } : {}),
    ...(typeof skill.contentHash === 'string' ? { contentHash: skill.contentHash } : {}),
    ...(Array.isArray(skill.capabilities) ? { capabilities: skill.capabilities } : {}),
  }
}

export class AgentTurnResumeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentTurnResumeError'
    this.code = code
  }
}

/**
 * 恢复一个被判定为可重放的孤儿 Turn。
 *
 * 派生上下文（项目文档、项目 Skill）在这里**重新读取**而不是从快照恢复：重放一份
 * 过期的画布或 Skill 列表，会让恢复出的回合与当前项目不一致。只有用户请求本身
 * 来自不可变快照。
 *
 * 不自己判断能否重放 —— 那是 `turnReclaimDecision` 的职责，调用方判完再交给它。
 *
 * @param {{
 *   productStore: any,
 *   config: any,
 *   mediaService?: any,
 *   turnRuntime: { execute: (input: any) => Promise<any> },
 *   observe?: (event: any) => void,
 * }} deps
 */
export function createAgentTurnResumer({ productStore, config, mediaService, turnRuntime, observe }) {
  if (!productStore) throw new TypeError('Turn 恢复缺少 ProductStore。')
  if (!turnRuntime?.execute) throw new TypeError('Turn 恢复缺少 Turn Runtime。')

  const report = (event) => {
    try { observe?.(event) } catch { /* 可观测性不得改变恢复结果。 */ }
  }

  return async function resumeAgentTurn(turn) {
    if (!turn?.request) {
      // 早于请求快照落地的 Turn 无从重建输入。明确报错而不是静默跳过，
      // 否则调用方会以为恢复成功了。
      throw new AgentTurnResumeError('AGENT_TURN_REQUEST_MISSING', '该回合没有可重放的请求快照，无法恢复。')
    }
    const project = await productStore.readProject(turn.ownerId, turn.projectId)
    if (!project?.document) {
      throw new AgentTurnResumeError('AGENT_TURN_PROJECT_MISSING', '来源项目已不存在，无法恢复该回合。')
    }
    const projectSkills = await productStore.listAgentSkills(turn.ownerId, turn.projectId) ?? []

    // 恢复自带独立的取消控制器：它与原请求的 HTTP 连接无关，那条连接早已断开。
    const controller = new AbortController()
    const input = { ...turn.request, projectSkills: projectSkills.map(plannerSkillInput) }

    report({ event: 'agent.turn.resume.started', turnId: turn.id, projectId: turn.projectId })
    const execution = await turnRuntime.execute({
      userId: turn.ownerId,
      projectId: turn.projectId,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      id: turn.id,
      // 复用原幂等键：恢复是同一次逻辑请求的续跑，不是新的一次提交。
      idempotencyKey: turn.idempotencyKey,
      request: turn.request,
      resolve: (resolveOptions) => resolveBotanicAgentTurn(input, config, resolveOptions),
      resolveOptions: {
        document: project.document,
        projectSkills,
        signal: controller.signal,
        // 看图只读当前项目内的媒体；图片字节不离开服务端与模型网关。
        resolveVisionMedia: mediaService?.enabled
          ? (mediaId) => mediaService.readGenerationInput(turn.ownerId, mediaId, turn.projectId)
          : undefined,
      },
    })
    report({
      event: 'agent.turn.resume.completed',
      turnId: turn.id,
      projectId: turn.projectId,
      status: execution?.turn?.status,
    })
    return execution
  }
}
