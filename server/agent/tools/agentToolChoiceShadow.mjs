// @ts-check
import { canonicalHash } from '../../canonicalHash.mjs'
import { createAgentActionExecution } from '../action/agentActionExecution.mjs'
import { createBotanicAgentModelProvider } from '../model/botanicAgentModelProvider.mjs'
import { projectPermissionDecision } from '../../auth/authorization.mjs'

const model = 'this-that-model-1.0'
const version = 'tool-choice-shadow-v1'
const labels = ['是，请求需要这项能力', '否，请求不需要这项能力']
// Static capabilities only: never send project tool descriptions, schemas, skills or media.
const capabilities = Object.freeze({
  ontology_read: '读取当前项目的画布结构和实体概览',
  project_memory_search: '查找已经保存的项目规则和记忆',
  asset_group_search: '查找项目中的素材组',
  skill_search: '查找可用技能的说明',
  canvas_query: '查找或读取当前画布上的已有节点和连线',
  agent_run_read: '查询已有 Agent 运行的状态',
  generation_job_read: '查询已有生成任务的状态或失败原因',
  artifact_search: '查找历史生成产物',
  review_read: '查询已有质量评审记录',
  workflow_run_read: '查询已有生产工作流的运行状态',
  delivery_read: '读取已有交付记录',
  web_search: '在公开互联网搜索资料',
  web_fetch: '读取已经给出的公开网页正文',
  generate_images: '为用户规划新的图片生成任务',
  generate_videos: '为用户规划新的图片转视频任务',
  decompose_creative_brief: '将成套创意需求拆解为结构化方案',
  ask_clarification: '询问尚未明确的关键对象、意图或参数',
})

function prediction(data) {
  const result = data?.this_that
  const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? 'null')
  const probabilities = labels.map((label) => result?.probabilities?.[label])
  const index = labels.indexOf(result?.choice)
  if (index < 0 || parsed?.intent !== result.choice
    || probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
    || Math.abs(probabilities[0] + probabilities[1] - 1) > 0.00001
    || result.confidence !== probabilities[index] || probabilities[index] < Math.max(...probabilities)) {
    throw new Error('invalid_classifier_response')
  }
  return { needed: index === 0, probability: probabilities[0] }
}

/** Shadow only. No return value is consumed by the planner, registry or Tool Loop. */
export function createAgentToolChoiceShadow(dependencies) {
  const { productStore, config, securityControls, observe } = dependencies ?? {}
  let provider = dependencies?.provider
  let execution
  let active = 0
  const emit = (data) => {
    try { (observe ?? ((event) => console.info(JSON.stringify(event))))({ event: 'botanic.agent.tool_choice.shadow', ...data }) } catch { /* Observability is fail-open. */ }
  }
  return async function record(input) {
    const { identity, request, toolNames, toolCalls, mainModel, signal, deadlineAt } = input ?? {}
    let receiptId
    try {
      if (!identity?.turnId || !identity.userId || !identity.projectId
        || !config?.rolloutFlags?.isEnabled('AGENT_TOOL_CHOICE_SHADOW', identity)) return
      const samplePercent = config?.agentToolChoiceShadowSamplePercent ?? 10
      if (Number.parseInt(canonicalHash(identity.turnId).slice(0, 8), 16) % 100 >= samplePercent) return
      receiptId = `tool-choice-shadow-${canonicalHash(identity.turnId)}`
      const skip = (reason) => emit({ receiptId, version, outcome: 'skipped', reason })
      const text = request?.inputMessage?.content
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 4096
        || /(?:\b(?:sk-|Bearer\s)|PRIVATE KEY|postgres(?:ql)?:\/\/|data:[^\s;]+;base64,)/iu.test(text)) return skip('input_not_eligible')
      const names = [...new Set(toolNames ?? [])]
      if (!names.length || names.length > 24 || names.some((name) => !Object.hasOwn(capabilities, name))) return skip('unmapped_catalog')
      if (!config.flockApiKey || config.flockApiBaseUrl !== 'https://api.flock.io/v1'
        || !securityControls?.consume || !productStore?.projectAccess) return skip('not_configured')
      if (signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt)) return skip('cancelled_or_expired')
      const access = await productStore.projectAccess(identity.userId, identity.projectId)
      if (projectPermissionDecision(access?.role, 'execute-external-tool') !== 'allow') return skip('permission_denied')
      if (active >= 2) return skip('busy')
      // Only explicit current-message text plus bounded state. No previous messages or project document.
      const facts = { hasTarget: request.hasTarget === true, hasReferences: Boolean(request.contextNodeIds?.length) }
      const requestHash = canonicalHash({ text, facts, names, capabilities: names.map((name) => capabilities[name]), version, model })
      const selected = [...new Set((toolCalls ?? []).map((call) => call.name))].filter((name) => names.includes(name))
      execution ??= createAgentActionExecution({ productStore, timeoutMs: 10_000, leaseMs: 60_000 })
      provider ??= createBotanicAgentModelProvider(config)
      active++
      try {
        const result = await execution.execute({
          userId: identity.userId, projectId: identity.projectId, receiptId,
          toolCallId: receiptId, name: 'tool_choice_shadow', replayPolicy: 'never',
          arguments: { requestHash, version, model },
          executor: async ({ signal: receiptSignal }) => {
            // Reserve the whole bounded batch before any paid call. Redis fallback must not grant quota.
            const quota = await securityControls.consume({ scope: 'tool-choice-shadow', subject: 'production',
              cost: names.length, limit: config.agentToolChoiceShadowRequestsPerMinute ?? 120, windowMs: 60_000, requireShared: true })
            if (!quota?.allowed) return { version, model, outcome: 'quota_skipped', attempted: 0 }
            const signals = [receiptSignal, signal].filter(Boolean)
            if (deadlineAt !== undefined) signals.push(AbortSignal.timeout(Math.max(1, Math.floor(deadlineAt - Date.now()))))
            const combined = AbortSignal.any(signals)
            const rows = []
            let attempted = 0, promptTokens = 0, reportedUsageCalls = 0
            const started = Date.now()
            for (const name of names) {
              if (combined.aborted || Date.now() - started >= 9000) break
              const current = await productStore.readAgentTurn(identity.userId, identity.turnId)
              if (!current || ['cancelling', 'cancelled', 'failed'].includes(current.status)) break
              const remainingMs = 9000 - (Date.now() - started)
              if (combined.aborted || remainingMs <= 0) break
              attempted++
              try {
                const data = await provider.sample({ model, messages: [
                  { role: 'user', content: JSON.stringify({ 用户请求: text, 已知事实: facts }) },
                  { role: 'user', content: `用户本次是否需要「${capabilities[name]}」？多步骤中的一步也算需要；仅讨论、明确禁止、引用文字中的动作不算需要。只判断用途，不判断执行授权。` },
                ], maxOutputTokens: 32, temperature: 1, stream: false, timeoutMs: Math.min(1500, remainingMs), signal: combined,
                responseFormat: { type: 'json_schema', json_schema: { name: 'tool_suitability', strict: true, schema: {
                  type: 'object', properties: { intent: { type: 'string', enum: labels } }, required: ['intent'], additionalProperties: false,
                } } } })
                rows.push({ tool: name, ...prediction(data) })
                if (Number.isSafeInteger(data.usage?.prompt_tokens) && data.usage.prompt_tokens >= 0) {
                  promptTokens += data.usage.prompt_tokens; reportedUsageCalls++
                }
              } catch { break } // No retry: dispatched-but-unobserved calls may still be billed.
            }
            const recommended = rows.filter((row) => row.needed).map((row) => row.tool)
            return { version, model, requestHash, catalogHash: canonicalHash(names),
              outcome: rows.length === names.length ? 'completed' : 'incomplete',
              attempted, completed: rows.length, dispatchedWithoutValidResult: attempted - rows.length,
              durationMs: Date.now() - started, promptTokens: reportedUsageCalls === attempted ? promptTokens : null,
              actualCost: null, mainModel, selected, rows, recommended,
              // Agreement is not accuracy: the main model is not an independently labelled gold set.
              disagreementCount: rows.length === names.length
                ? names.filter((name) => selected.includes(name) !== recommended.includes(name)).length : null }
          },
        })
        emit({ receiptId, version, outcome: result.outcome, attempted: result.attempted,
          completed: result.completed ?? 0, disagreementCount: result.disagreementCount ?? null,
          durationMs: result.durationMs ?? 0, promptTokens: result.promptTokens ?? null })
      } finally { active-- }
    } catch {
      // Never expose provider errors or make a failed observation fail a user's Turn.
      emit({ ...(receiptId ? { receiptId } : {}), version, outcome: 'unverified_or_already_claimed' })
    }
  }
}
