// @ts-check
import { createAgentSubtask } from './agentSubtask.mjs'
import { runAgentSubtask } from './agentSubtaskScheduler.mjs'
import { isEvaluatorSkill } from './botanicAgentSkill.mjs'

/**
 * 评审第 3 类判据：**项目自定义的 evaluator Skill**（Epic 6 × Epic 11）。
 *
 * 内置判据只有 7 条（identity / product_structure / garment_material / composition /
 * lighting / brand_style / delivery_spec），加上 Epic 9.1 的逐条品牌规则。它们覆盖不到
 * 「不得出现绝对化用语」「不得出现未成年人形象」这类**项目自己的**要求 —— 今天只能靠
 * 人眼，而人眼要等到候选全部生成完之后才看。
 *
 * 三条边界：
 *
 * - **每条 evaluator 都是一次额外的模型调用。** 5 个候选 × 3 条判据 = 15 次。因此
 *   数量有硬上限，且调用次数必须能被算出来并显示给用户 —— 用户加了 3 条判据却不知道
 *   评审费用翻了 3 倍，是这个功能最容易造成的伤害。
 * - **判据标识带 Skill 版本。** Skill 版本不可变，历史评审必须说得清当时是哪一版判的；
 *   不带版本的话，Skill 改了之后旧结论会看起来像是新规则判出来的。
 * - **跑在子任务治理里**（预算、超时、工具白名单、输出 Schema、可追踪终止）。
 *   自定义判据是项目自己写的指令，正是最需要边界的那一类执行。
 */

/** 一次质量策略里最多几条自定义判据。上限低是因为每条都乘以候选数。 */
export const MAX_EVALUATOR_SKILLS = 3

/** 单条自定义判据的超时。可注入是为了让超时路径能被快速测到，而不是等 45 秒。 */
export const EVALUATOR_TIMEOUT_MS = 45_000

/** 判据标识。带版本：Skill 改了之后旧结论不会看起来像新规则判出来的。 */
export function evaluatorCriterionId(skill) {
  return `skill.${skill?.id}@${Number(skill?.version ?? 1)}`
}

/**
 * 从项目 Skill 里挑出可作为判据的那些，固定成质量策略的一部分。
 *
 * 在**编译期**固定（与品牌规则同一时点）：之后新发布的 Skill 不会回头去评判一个
 * 已经跑完的 Run —— 那会让「结果符合用户确认的约束」变成一个移动靶。
 *
 * @param {any[]} skills
 */
export function evaluatorSkillCriteria(skills = []) {
  return (Array.isArray(skills) ? skills : [])
    .filter(isEvaluatorSkill)
    // 只有已发布的 Skill 能当判据。draft 还没人批准过，不该决定结果合不合格。
    .filter((skill) => skill.lifecycle === 'published' || (!skill.lifecycle && skill.status === 'active'))
    .slice(0, MAX_EVALUATOR_SKILLS)
    .map((skill) => ({
      id: evaluatorCriterionId(skill),
      skillId: skill.id,
      version: Number(skill.version ?? 1),
      name: skill.name,
      ...(skill.contentHash ? { contentHash: skill.contentHash } : {}),
      instructions: String(skill.instructions ?? '').slice(0, 4_000),
      outputSchema: structuredClone(skill.manifest.outputSchema),
      toolAllowlist: [...(skill.manifest.toolAllowlist ?? [])],
    }))
}

/**
 * 这次评审因自定义判据会多花多少次模型调用。
 *
 * 单独给出来是为了让界面在评审**开始前**就能说清成本。评审完再显示已经晚了：
 * 钱已经花掉了。
 *
 * @param {{ evaluatorSkills?: any[] }} qualityPolicy
 * @param {number} candidateCount
 */
export function evaluatorCallEstimate(qualityPolicy, candidateCount) {
  const criteria = qualityPolicy?.evaluatorSkills?.length ?? 0
  return { criteria, candidates: candidateCount, calls: criteria * Math.max(0, candidateCount) }
}

/**
 * 用一条 evaluator Skill 判一个候选。
 *
 * 跑成受治理的子任务：预算、超时、工具白名单与输出 Schema 全部由 Epic 11 那套执行。
 * 媒体**不进** `subtask.input` —— input 参与指纹计算，把几 MB 的 data URL 塞进去既昂贵
 * 又会让同一判据因图片字节不同而反复重跑（重放复用就失效了）。画面通过执行器闭包取。
 *
 * @param {{
 *   criterion: any, candidate: any, task: any,
 *   judgeWith: (input: { criterion: any, candidate: any }) => any,
 *   registry?: any, context?: any, timeoutMs?: number, now?: () => number,
 * }} input
 */
export async function runEvaluatorSkillCriterion({
  criterion, candidate, task, judgeWith, registry, context,
  timeoutMs = EVALUATOR_TIMEOUT_MS, now = () => Date.now(),
}) {
  let subtask
  try {
    subtask = createAgentSubtask({
      // 与评审任务同一 trace：失败、超时与重试要能串成一条线。
      parentTurnId: String(task?.id ?? 'review'),
      projectId: String(task?.projectId ?? ''),
      ownerId: String(task?.ownerId ?? ''),
      role: 'compliance_review',
      input: { criterionId: criterion.id, artifactId: candidate?.artifactId, skillVersion: criterion.version },
      // Skill 自己声明的白名单。会写入或需确认的工具在这里就被拒绝（Epic 11）。
      allowedTools: criterion.toolAllowlist?.length ? criterion.toolAllowlist : ['canvas_read'],
      outputSchema: criterion.outputSchema,
      registry: registry ?? { get: (name) => (name === 'canvas_read' ? { name, risk: 'read' } : undefined) },
      budget: { maxSteps: 1, maxToolCalls: 2 },
      timeoutMs,
      now: now(),
    })
  } catch (caught) {
    // Skill 的白名单/Schema 不合治理要求时，这条判据判「无法验证」并说明原因 ——
    // 不能因为一条自定义判据配错就让整个评审失败。
    return {
      id: criterion.id,
      layer: 'model',
      verdict: 'unverifiable',
      evidence: `自定义判据无法执行：${caught instanceof Error ? caught.message : String(caught)}`.slice(0, 300),
      skillId: criterion.skillId,
      skillVersion: criterion.version,
    }
  }
  const settled = await runAgentSubtask({
    subtask,
    registry,
    context,
    // 工厂按 (判据, 候选) 闭包出这一次的执行器。
    runSubagent: judgeWith({ criterion, candidate }),
    now,
  })
  if (settled.status !== 'completed') {
    // 终止原因原样带出来：超时、预算用尽与越权是三种不同的运维问题。
    return {
      id: criterion.id,
      layer: 'model',
      verdict: 'unverifiable',
      evidence: `自定义判据未完成（${settled.termination?.reason ?? 'failed'}）。`,
      skillId: criterion.skillId,
      skillVersion: criterion.version,
    }
  }
  const output = settled.result?.output ?? {}
  return {
    id: criterion.id,
    layer: 'model',
    verdict: output.verdict === 'pass' || output.verdict === 'fail' ? output.verdict : 'unverifiable',
    evidence: String(output.evidence ?? output.reason ?? output.summary ?? '').slice(0, 300) || '自定义判据未给出依据。',
    // 结论回带 Skill 版本：Skill 不可变版本化，历史评审要说得清当时按哪一版判的。
    skillId: criterion.skillId,
    skillVersion: criterion.version,
  }
}

/**
 * evaluator Skill 的执行器。
 *
 * 与 `createAgentReviewVisionJudge` 是两件事，不能复用：那一份带固定的评审 rubric 与
 * 固定的判据清单；这一份的指令来自**项目自己写的 Skill**，输出形状也由 Skill 声明。
 * 复用会让「内置判据」和「自定义判据」的 Prompt 互相牵连。
 *
 * 未配置视觉模型时返回 `undefined` —— 调用方据此把自定义判据记为「无法验证」，
 * 而不是拿一个永远失败的执行器去跑。
 *
 * @param {{ runtimeConfig?: any, resolveMedia?: (image: string) => Promise<string | undefined>, callModel?: any, fetchImpl?: typeof fetch }} input
 */
export function createEvaluatorSkillRunner({ runtimeConfig, resolveMedia, callModel, fetchImpl = fetch } = {}) {
  const model = typeof runtimeConfig?.agentVisionModel === 'string' ? runtimeConfig.agentVisionModel.trim() : ''
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const invoke = callModel ?? (model && apiKey
    ? async ({ messages, signal }) => {
      const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
        ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
        : 'https://api.flock.io/v1'
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'x-litellm-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.2 }),
        signal,
      })
      if (!response.ok) throw new Error(`自定义判据模型返回 ${response.status}。`)
      return response.json().catch(() => null)
    }
    : undefined)
  if (!invoke) return undefined

  /**
   * 返回的是**工厂**：`runAgentSubtask` 只会给 `runSubagent` 传 `{ subtask, signal,
   * callTool }`，判据与候选到不了那里。因此按 (判据, 候选) 闭包一个执行器出来，
   * 而不是把它们塞进 `subtask.input` —— input 参与指纹，塞进去会让同一判据因图片
   * 不同而反复重跑，重放复用就失效了。
   */
  return function judgeWith({ criterion, candidate }) {
    return async function runSubagent({ signal }) {
      const dataUrl = typeof resolveMedia === 'function' ? await resolveMedia(candidate?.output?.image) : undefined
      if (!dataUrl) {
        // 取不到画面就无法判定；照实说，不拿一张空图去问模型。
        return { verdict: 'unverifiable', evidence: '无法读取该候选的画面。' }
      }
      const instructions = [
        String(criterion?.instructions ?? '').trim(),
        '',
        '你在为品牌视觉工作台做一条**自定义评审判据**的判定。只依据画面可见内容判断，不臆测拍摄意图。',
        '只输出 JSON，且只包含下列字段：verdict（pass / fail / unverifiable）、evidence（不超过 40 字的依据）。',
        '看不出来必须给 unverifiable，不要为了给结论而猜。',
        '不要输出 JSON 之外的任何文字。',
      ].join('\n')
      const payload = await invoke({
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
        ],
        signal: signal ?? AbortSignal.timeout(EVALUATOR_TIMEOUT_MS),
      })
      const content = payload?.choices?.[0]?.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') : ''
      const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      let parsed
      try { parsed = JSON.parse(trimmed) } catch { parsed = undefined }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // 解析不出来是可诊断的失败：子任务按 output_invalid 终止，而不是静默算通过。
        throw new Error('自定义判据的输出不是预期的 JSON。')
      }
      return parsed
    }
  }
}
