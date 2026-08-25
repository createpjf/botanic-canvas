import { WORKFLOW_BATCH_FIELDS, type WorkflowBatchItem } from './workflowBatchInput.ts'
import type { ProductLocale } from '../i18n/core.ts'

/**
 * Campaign 矩阵展开（Epic 9.3）。
 *
 * 与 `workflowBatchInput`（CSV 导入）是两种输入方式，共用同一批量项形状：CSV 适合
 * 已经在表格里列好的清单，矩阵适合「3 个 SKU × 4 个渠道 × 2 种语言」这种由轴相乘
 * 得出的批量。
 *
 * 这里最重要的行为不是「算笛卡尔积」，而是**在展开前把张数说清楚**：4 个轴各 5 个
 * 取值就是 625 项，每一项都是一次真实的模型调用。批量生产工具里最贵的错误就是
 * 用户以为自己提交了十几张、实际提交了几百张。因此展开必须：
 *
 * - 先能被预览（`campaignMatrixSize` 不做展开就能给出张数）；
 * - 超过上限时**拒绝并说明**，而不是截断到上限 —— 截断会让用户以为全跑了。
 */

/** 矩阵轴。是批量字段的子集：`assetGroupId` 属于共享 Reference Pack，不参与相乘。 */
export const CAMPAIGN_MATRIX_AXES = ['sku', 'channel', 'language', 'aspectRatio', 'copy'] as const

export type CampaignMatrixAxis = typeof CAMPAIGN_MATRIX_AXES[number]

export type CampaignMatrixInput = Partial<Record<CampaignMatrixAxis, string[]>> & {
  /** 全批共享的素材组与品牌上下文。共享而不是逐项复制，避免各项悄悄用了不同参考。 */
  shared?: { assetGroupId?: string; variables?: Record<string, string> }
}

export type CampaignMatrixProblem = {
  code: 'axis_empty' | 'axis_duplicate' | 'too_large' | 'no_axis'
  axis?: CampaignMatrixAxis
  detail: string
}

export type CampaignMatrixResult = {
  items: WorkflowBatchItem[]
  /** 实际参与相乘的轴与取值数，供界面解释「这 24 张是怎么来的」。 */
  axes: Array<{ axis: CampaignMatrixAxis; values: string[] }>
  size: number
  problems: CampaignMatrixProblem[]
}

/** 默认上限。比 CSV 导入的 200 更保守：矩阵的张数是乘出来的，涨得比人预期快得多。 */
export const CAMPAIGN_MATRIX_LIMIT = 200

function normalizeAxisValues(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))]
}

/** 参与相乘的轴。空轴不参与，也不让整个矩阵变成 0 项。 */
export function campaignMatrixAxes(input: CampaignMatrixInput | undefined) {
  return CAMPAIGN_MATRIX_AXES
    .map((axis) => ({ axis, values: normalizeAxisValues(input?.[axis]) }))
    .filter((entry) => entry.values.length)
}

/**
 * 展开前就能算出的张数。
 *
 * 单独给出来是为了让界面在用户点「生成」**之前**显示总数 —— 展开后再显示，
 * 已经晚了一步。
 */
export function campaignMatrixSize(input: CampaignMatrixInput | undefined) {
  const axes = campaignMatrixAxes(input)
  return axes.length ? axes.reduce((total, entry) => total * entry.values.length, 1) : 0
}

/**
 * 展开矩阵。
 *
 * 超过上限时**返回空项并报告**，不截断到上限：截断会让用户以为整批都提交了，
 * 而缺的那部分要到交付时才被发现。
 */
export function expandCampaignMatrix(
  input: CampaignMatrixInput | undefined,
  { limit = CAMPAIGN_MATRIX_LIMIT } = {},
): CampaignMatrixResult {
  const problems: CampaignMatrixProblem[] = []
  for (const axis of CAMPAIGN_MATRIX_AXES) {
    const raw = input?.[axis]
    if (!raw) continue
    const normalized = normalizeAxisValues(raw)
    if (!normalized.length) {
      problems.push({ code: 'axis_empty', axis, detail: `「${axis}」轴没有有效取值，已忽略。` })
      continue
    }
    // 重复取值会让同一组合出现两次，而两次的业务标识相同 —— 之后「只重试失败的 2 项」
    // 会对不上号。这里报告出来而不是静默去重。
    if (normalized.length !== raw.filter((value) => typeof value === 'string' && value.trim()).length) {
      problems.push({ code: 'axis_duplicate', axis, detail: `「${axis}」轴有重复取值，已按去重后展开。` })
    }
  }

  const axes = campaignMatrixAxes(input)
  if (!axes.length) {
    problems.push({ code: 'no_axis', detail: '至少要有一个轴带取值才能展开矩阵。' })
    return { items: [], axes: [], size: 0, problems }
  }

  const size = axes.reduce((total, entry) => total * entry.values.length, 1)
  if (size > limit) {
    problems.push({
      code: 'too_large',
      detail: `${axes.map((entry) => entry.values.length).join(' × ')} = ${size} 项，超过上限 ${limit}。请减少取值或分批提交。`,
    })
    return { items: [], axes, size, problems }
  }

  let combinations: Array<Partial<Record<CampaignMatrixAxis, string>>> = [{}]
  for (const { axis, values } of axes) {
    combinations = combinations.flatMap((combination) => values.map((value) => ({ ...combination, [axis]: value })))
  }

  const shared = input?.shared
  const items: WorkflowBatchItem[] = combinations.map((combination) => ({
    ...combination,
    // 共享的素材组与变量对每一项都一样。逐项让用户各填一次，迟早会出现某一项用了
    // 不同参考 —— 而那正是「跨输出一致性」最常见的破法。
    ...(shared?.assetGroupId ? { assetGroupId: shared.assetGroupId } : {}),
    ...(shared?.variables && Object.keys(shared.variables).length ? { variables: { ...shared.variables } } : {}),
  }))

  return { items, axes, size, problems }
}

/**
 * 展开摘要。**张数必须在提交前就说清楚**，并且把被忽略的轴一并说明。
 */
export function campaignMatrixSummary(result: CampaignMatrixResult, locale: ProductLocale = 'zh-CN') {
  const blocking = result.problems.find((problem) => problem.code === 'too_large' || problem.code === 'no_axis')
  if (blocking) return blocking.detail
  const shape = result.axes.map((entry) => `${entry.axis} ${entry.values.length}`).join(locale === 'en' ? ' x ' : ' × ')
  const warnings = result.problems.length
    ? (locale === 'en' ? ` ${result.problems.length} note(s) need review.` : ` 另有 ${result.problems.length} 处需要留意。`)
    : ''
  return locale === 'en'
    ? `${shape} = ${result.size} item(s), each a separate generation.${warnings}`
    : `${shape} = ${result.size} 项，每项都是一次独立生成。${warnings}`
}

/** 与服务端批量字段词表保持一致；不一致会让「校验通过」变得不可信。 */
export function campaignMatrixFieldsAreValid() {
  return CAMPAIGN_MATRIX_AXES.every((axis) => (WORKFLOW_BATCH_FIELDS as readonly string[]).includes(axis))
}
