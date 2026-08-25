// @ts-check

/**
 * 评审第 2 层：视觉模型语义判定（ADR 0006 / Epic 5）。
 *
 * 与既有的「结果自评」展示型评审是两回事，不能复用它：那一份带**硬编码 rubric**，
 * 只读 instruction 与 prompt。本模块的判据一律来自
 * `CompiledCreativePlan.qualityPolicy.requiredCriteria` —— 否则「结果符合用户确认的
 * 约束」无法被证明，编译期声明的策略与评审期实际使用的判据会各自漂移。
 *
 * 失败必须可诊断：「模型不可用」与「输出不可解析」是两种不同的失败，
 * 收敛成一个空结果会让运维无从判断该重试还是该修解析。
 */

const REVIEW_TIMEOUT_MS = 30_000
const EVIDENCE_LIMIT = 300

/** 质量策略判据 → 给模型看的人话说明。未知判据按原样传，不静默丢。 */
const CRITERION_LABELS = Object.freeze({
  identity: '主体与人物身份是否保持一致',
  product_structure: '商品结构、比例与关键细节是否保持',
  garment_material: '服装材质与版型是否保持',
  composition: '构图是否符合要求且画面完整',
  lighting: '光线方向与质感是否符合要求',
  brand_style: '是否符合品牌风格与禁用表达',
  delivery_spec: '交付规格（安全区、留白、可读性）是否满足',
})

export class AgentReviewVisionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentReviewVisionError'
    this.code = code
  }
}

function parseJsonPayload(content) {
  if (typeof content !== 'string' || !content.trim()) return undefined
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function providerText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

/** 判据说明。策略里出现未知判据时原样交给模型，而不是悄悄跳过。 */
export function reviewCriteriaBriefing(requiredCriteria = []) {
  return requiredCriteria.map((id) => `${id}：${CRITERION_LABELS[id] ?? '按该判据名判断是否满足'}`)
}

export function reviewVisionInstructions(requiredCriteria = []) {
  return [
    '你是品牌视觉工作台的结果评审。只依据画面可见内容判断，不臆测拍摄意图。',
    '逐条给出下列判据的结论，不要增加判据，也不要遗漏：',
    ...reviewCriteriaBriefing(requiredCriteria).map((line) => `- ${line}`),
    '只输出 JSON，格式：{"criteria":[{"id":"判据名","verdict":"pass"或"fail"或"unverifiable","evidence":"不超过40字的依据"}],"revision":"若有不符，给出一句可执行的修订建议；否则空字符串"}。',
    '看不出来的判据必须给 unverifiable，不要为了凑齐而猜 pass。',
    '不要输出 JSON 之外的任何文字。',
  ].join('\n')
}

/**
 * 构建逐候选的视觉评审器。
 *
 * @param {{
 *   runtimeConfig?: any,
 *   resolveMedia?: (image: string) => Promise<string | undefined>,
 *   callModel?: (input: { model: string, messages: any[], signal: AbortSignal }) => Promise<any>,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {undefined | ((input: { candidate: any, task: any }) => Promise<{ criteria: any[], revisionProposal?: any }>)}
 *   视觉模型未配置时返回 `undefined` —— 调用方据此把语义判据记为「无法验证」，
 *   而不是拿一个永远失败的评审器去跑。
 */
export function createAgentReviewVisionJudge({ runtimeConfig, resolveMedia, callModel, fetchImpl = fetch } = {}) {
  const model = typeof runtimeConfig?.agentVisionModel === 'string' ? runtimeConfig.agentVisionModel.trim() : ''
  const apiKey = typeof runtimeConfig?.flockApiKey === 'string' ? runtimeConfig.flockApiKey.trim() : ''
  const invoke = callModel ?? (model && apiKey
    ? async ({ messages, signal }) => {
      const baseUrl = typeof runtimeConfig?.flockApiBaseUrl === 'string' && runtimeConfig.flockApiBaseUrl.trim()
        ? runtimeConfig.flockApiBaseUrl.trim().replace(/\/+$/, '')
        : 'https://api.flock.io/v1'
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'x-litellm-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, max_tokens: 600, temperature: 0.2 }),
        signal,
      })
      if (!response.ok) {
        throw new AgentReviewVisionError('REVIEW_MODEL_UNAVAILABLE', `视觉评审模型返回 ${response.status}。`)
      }
      return response.json().catch(() => null)
    }
    : undefined)
  if (!invoke) return undefined

  return async function reviewCandidate({ candidate, task }) {
    const requiredCriteria = task?.qualityPolicy?.requiredCriteria ?? []
    if (!requiredCriteria.length) {
      // 没有判据就没有可评的东西。这不是模型故障，因此不抛错，如实返回无法验证。
      return { criteria: [{ id: 'semantic_review', layer: 'model', verdict: 'unverifiable', evidence: '质量策略没有声明判据。' }] }
    }
    const dataUrl = typeof resolveMedia === 'function' ? await resolveMedia(candidate?.output?.image) : undefined
    if (!dataUrl) {
      // 取不到画面就无法做视觉判定；照实说，不拿一张空图去问模型。
      return { criteria: requiredCriteria.map((id) => ({ id, layer: 'model', verdict: 'unverifiable', evidence: '无法读取该候选的画面。' })) }
    }
    let payload
    try {
      payload = await invoke({
        model,
        messages: [
          { role: 'system', content: reviewVisionInstructions(requiredCriteria) },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
        ],
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
      })
    } catch (caught) {
      if (caught instanceof AgentReviewVisionError) throw caught
      throw new AgentReviewVisionError('REVIEW_MODEL_UNAVAILABLE', caught instanceof Error ? caught.message : String(caught))
    }
    const parsed = parseJsonPayload(providerText(payload))
    if (!Array.isArray(parsed?.criteria)) {
      throw new AgentReviewVisionError('REVIEW_OUTPUT_UNPARSABLE', '视觉评审模型的输出不是预期的 JSON。')
    }
    const byId = new Map(parsed.criteria
      .filter((entry) => typeof entry?.id === 'string')
      .map((entry) => [entry.id, entry]))
    const criteria = requiredCriteria.map((id) => {
      const entry = byId.get(id)
      const verdict = entry?.verdict === 'pass' || entry?.verdict === 'fail' ? entry.verdict : 'unverifiable'
      return {
        id,
        layer: 'model',
        verdict,
        // 模型漏答的判据判「无法验证」，不按通过处理 —— 漏答不是合格。
        evidence: typeof entry?.evidence === 'string' && entry.evidence.trim()
          ? entry.evidence.trim().slice(0, EVIDENCE_LIMIT)
          : entry ? '模型未给出依据。' : '模型未对该判据作答。',
      }
    })
    const revision = typeof parsed.revision === 'string' ? parsed.revision.trim() : ''
    const failed = criteria.filter((entry) => entry.verdict === 'fail').map((entry) => entry.id)
    return {
      criteria,
      // 只有真的不符合时才产出修订建议：全通过还给建议会诱导无意义的重跑。
      ...(revision && failed.length
        ? {
          revisionProposal: {
            version: 1,
            failedCriteria: failed,
            suggestion: revision.slice(0, 500),
            // 建议来自本次评审，因此绑定它所依据的策略指纹，方便追溯它凭什么这么说。
            ...(task?.qualityPolicyFingerprint ? { qualityPolicyFingerprint: task.qualityPolicyFingerprint } : {}),
          },
        }
        : {}),
    }
  }
}
