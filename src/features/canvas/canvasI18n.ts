import type { AssetRole, AssetSource } from '../../domain/canvas'
import type { ProductLocale } from '../../i18n/core'

const roleLabels: Record<AssetRole, Record<ProductLocale, string>> = {
  '商品': { 'zh-CN': '商品', en: 'Product' },
  '模特': { 'zh-CN': '模特', en: 'Model' },
  '场景': { 'zh-CN': '场景', en: 'Scene' },
  '调性': { 'zh-CN': '调性', en: 'Style' },
  '首图': { 'zh-CN': '首图', en: 'Key visual' },
}

const sourceLabels: Record<AssetSource, Record<ProductLocale, string>> = {
  brand: { 'zh-CN': '品牌资产', en: 'Brand asset' },
  upload: { 'zh-CN': '项目上传', en: 'Project upload' },
  generated: { 'zh-CN': '生成入库', en: 'Generated asset' },
}

const systemLabels: Record<string, string> = {
  '图像生成': 'Image generation',
  '视频生成': 'Video generation',
  '定向精修': 'Directed refinement',
  'Agent 生成': 'Agent generation',
  '视觉目标': 'Prompt',
  '描述': 'Prompt',
  '视觉描述': 'Visual description',
  '生成描述': 'Generation brief',
  '精修描述': 'Refinement brief',
  '定向精修指令': 'Directed refinement brief',
  '复用原始参考重做首图': 'Reuse original references for a new key visual',
  '参考组': 'References',
  '上游输出': 'Upstream output',
  '输出图片': 'Output image',
  '生成结果': 'Generated result',
  '生成版本': 'Generated version',
  '精修版本': 'Refined version',
  '新版本': 'New version',
  '创意图': 'Creative image',
}

const systemLabelPatterns: Array<[RegExp, (...matches: string[]) => string]> = [
  [/^(图像生成|视频生成) (\d+)$/, (kind, sequence) => `${kind === '视频生成' ? 'Video generation' : 'Image generation'} ${sequence}`],
  [/^(.+) · (图像|视频) (\d+)$/, (source, kind, sequence) => `${source} · ${kind === '视频' ? 'Video' : 'Image'} ${sequence}`],
  [/^(首图|精修)候选(?: · (.+))?$/, (kind, status = '') => {
    const prefix = kind === '精修' ? 'Refinement' : 'Key visual'
    const statuses: Record<string, string> = {
      '等待选择': 'Awaiting selection',
      '等待确认': 'Awaiting confirmation',
      '登录已失效': 'Session expired',
      '提交超时': 'Submission timed out',
    }
    return status ? `${prefix} · ${statuses[status] ?? status}` : prefix
  }],
  [/^(首图|精修)分支 (\d+)$/, (kind, sequence) => `${kind === '精修' ? 'Refinement' : 'Key visual'} branch ${sequence}`],
]

/** Translate only Botanic-owned stable labels. User-authored names remain untouched. */
export function canvasSystemLabel(value: string, locale: ProductLocale) {
  if (locale !== 'en') return value === '视觉目标' ? '描述' : value
  const direct = systemLabels[value]
  if (direct) return direct
  for (const [pattern, format] of systemLabelPatterns) {
    const match = value.match(pattern)
    if (match) return format(...match.slice(1))
  }
  return value
}

export function canvasAssetRoleLabel(role: AssetRole, locale: ProductLocale) {
  return roleLabels[role][locale]
}

export function canvasAssetSourceLabel(source: AssetSource, locale: ProductLocale) {
  return sourceLabels[source][locale]
}

export function canvasDurationLabel(seconds: number, locale: ProductLocale) {
  return locale === 'en' ? `${seconds}s` : `${seconds}秒`
}

export function canvasCountLabel(count: number, singular: string, plural: string, locale: ProductLocale) {
  return locale === 'en' ? `${count} ${count === 1 ? singular : plural}` : `${count} ${singular}`
}
