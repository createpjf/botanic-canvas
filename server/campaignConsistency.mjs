// @ts-check

/**
 * 跨输出一致性 Gate（Epic 9.3）。
 *
 * 「一整套物料看起来是一套」听上去像是必须让视觉模型判断的事。但其中有一大块是
 * **可以被证明的**，根本不需要模型：
 *
 * - 它们是不是用了同一批参考素材；
 * - 是不是在同一套品牌规则下生成的；
 * - 是不是同一次发布/同一份计划展开出来的；
 * - 声明要一致的规格（比例、分辨率）是不是真的一致。
 *
 * 这几条不一致时，画面几乎不可能是一套 —— 而且原因是确定的、能指名道姓的。先把
 * 它们查掉，视觉模型只用来看剩下那部分（构图、色调、气质），既便宜又可靠。
 *
 * 与评审层的分工和 ADR 0006 一致：能证明的不交给模型。区别在于评审层看的是
 * **单个候选对不对**，这里看的是**一组输出彼此像不像一套**。
 */

/** 一致性维度。声明式：新增维度必须同时说明它读哪个字段。 */
export const CAMPAIGN_CONSISTENCY_DIMENSIONS = Object.freeze([
  'reference_pack',
  'brand_kit',
  'plan',
  'model',
  'aspect_ratio',
  'resolution',
])

/** 判定档与评审层同口径：`unverifiable` 是独立结论，不折进 pass 或 fail。 */
export const CAMPAIGN_CONSISTENCY_VERDICTS = Object.freeze(['pass', 'fail', 'unverifiable'])

function referencePackKey(output) {
  const references = output?.recipe?.references ?? output?.references
  if (!Array.isArray(references)) return undefined
  // 只取身份并排序：参考的**书写顺序**不同不代表用的不是同一批素材。
  const identities = references
    .map((reference) => reference?.assetId ?? reference?.nodeId)
    .filter((value) => typeof value === 'string' && value)
    .sort()
  // 空参考集是一个有意义的值（纯文字生成），与「没记录参考」不是一回事。
  return identities.join('|')
}

const dimensionReaders = Object.freeze({
  reference_pack: referencePackKey,
  brand_kit: (output) => output?.brandKitFingerprint ?? output?.recipe?.brandKitFingerprint,
  plan: (output) => output?.planFingerprint ?? output?.recipe?.planFingerprint,
  model: (output) => output?.settings?.model,
  aspect_ratio: (output) => output?.settings?.aspectRatio,
  resolution: (output) => output?.settings?.resolution,
})

const dimensionLabels = Object.freeze({
  reference_pack: '参考素材',
  brand_kit: '品牌规则',
  plan: '计划',
  model: '生成模型',
  aspect_ratio: '画面比例',
  resolution: '分辨率',
})

/**
 * 允许不一致的维度。
 *
 * Campaign 的**本意**就是同一批内容按渠道/比例分发，因此比例与分辨率天然会不同。
 * 把它们默认判成不一致，Gate 会对每一个正常的 Campaign 都报警，然后没人再看它。
 */
const VARIES_BY_DESIGN = Object.freeze(['aspect_ratio', 'resolution'])

/**
 * 检查一组输出是否构成一套。
 *
 * @param {{
 *   outputs?: Array<any>,
 *   requireDimensions?: string[],
 * }} input
 */
export function checkCampaignConsistency({ outputs = [], requireDimensions } = {}) {
  const dimensions = (requireDimensions ?? CAMPAIGN_CONSISTENCY_DIMENSIONS)
    .filter((dimension) => CAMPAIGN_CONSISTENCY_DIMENSIONS.includes(dimension))
    // 未显式要求时，按设计本来就会变的维度不参与判定。
    .filter((dimension) => requireDimensions ? true : !VARIES_BY_DESIGN.includes(dimension))

  if (outputs.length < 2) {
    // 一个输出没有「彼此」可言。说成通过会让「只生成了一张」看起来像「一整套都对齐了」。
    return {
      verdict: 'unverifiable',
      checks: dimensions.map((dimension) => ({ dimension, verdict: 'unverifiable', evidence: '少于两个输出，无法比较。' })),
      groups: {},
    }
  }

  const checks = []
  /** @type {Record<string, any>} */
  const groups = {}
  for (const dimension of dimensions) {
    const read = dimensionReaders[dimension]
    const values = outputs.map((output) => ({ id: output?.artifactId ?? output?.id, value: read(output) }))
    const missing = values.filter((entry) => entry.value === undefined || entry.value === null)
    if (missing.length) {
      // 缺字段判「无法验证」而不是默认通过：默认通过会让「没记录」看起来像「一致」。
      checks.push({
        dimension,
        verdict: 'unverifiable',
        evidence: `${missing.length} 个输出没有记录${dimensionLabels[dimension]}。`,
      })
      continue
    }
    const distinct = [...new Set(values.map((entry) => String(entry.value)))]
    if (distinct.length === 1) {
      checks.push({ dimension, verdict: 'pass', evidence: `全部 ${outputs.length} 个输出一致。` })
      continue
    }
    // 不一致时必须给出**是哪几个输出**分成了几组，否则用户只知道「不一致」，
    // 不知道该去看哪一张。
    const grouped = distinct.map((value) => ({
      value,
      artifactIds: values.filter((entry) => String(entry.value) === value).map((entry) => entry.id),
    }))
    groups[dimension] = grouped
    checks.push({
      dimension,
      verdict: 'fail',
      evidence: `${dimensionLabels[dimension]}分成了 ${distinct.length} 组。`,
    })
  }

  if (checks.some((check) => check.verdict === 'fail')) return { verdict: 'fail', checks, groups }
  if (checks.some((check) => check.verdict === 'unverifiable')) return { verdict: 'unverifiable', checks, groups }
  return { verdict: 'pass', checks, groups }
}

/**
 * 一致性摘要。
 *
 * 「无法验证」必须与「不一致」分开说：前者是没记录，后者是确实不是一套。
 *
 * @param {any} result
 * @param {string} [locale]
 */
export function campaignConsistencySummary(result, locale = 'zh-CN') {
  const failed = (result?.checks ?? []).filter((check) => check.verdict === 'fail')
  const unverified = (result?.checks ?? []).filter((check) => check.verdict === 'unverifiable')
  const en = locale === 'en'
  if (!result?.checks?.length) return en ? 'Nothing to compare.' : '没有可比较的输出。'
  if (!failed.length && !unverified.length) {
    return en ? 'All outputs share the same references, brand rules and plan.' : '全部输出共享同一批参考、同一套品牌规则与同一份计划。'
  }
  const parts = []
  if (failed.length) {
    parts.push(en
      ? `${failed.length} dimension(s) diverge: ${failed.map((check) => check.dimension).join(', ')}`
      : `${failed.length} 项不一致：${failed.map((check) => dimensionLabels[check.dimension] ?? check.dimension).join('、')}`)
  }
  if (unverified.length) {
    parts.push(en
      ? `${unverified.length} dimension(s) could not be verified (not recorded), which is not the same as consistent`
      : `${unverified.length} 项无法验证（没有记录），这与「一致」不是一回事`)
  }
  return en ? `${parts.join('; ')}.` : `${parts.join('；')}。`
}
