/**
 * 多图合成规则：参考图在 images/edits 里第一张是底图，其余是弱提示。
 * Logo / 标识绝不能当底图，否则模型会把标识改成整张肖像并另造勋章。
 */

export const generationMarkNamePattern =
  /logo|wordmark|word[\s-]?mark|标识|徽章|勋章|胸针|领针|袖标|臂章|商标|标志|标牌|emblem|badge|crest|monogram|insignia/iu

export function isGenerationMarkReference(reference: { name?: string } | null | undefined) {
  const name = reference?.name?.trim() ?? ''
  return Boolean(name) && generationMarkNamePattern.test(name)
}

/** 底图在前、标识在后；没有标识或全是标识时保持原顺序。 */
export function orderCompositionReferences<T extends { name?: string }>(references: readonly T[]): T[] {
  if (references.length < 2) return [...references]
  const bases: T[] = []
  const marks: T[] = []
  for (const reference of references) {
    if (isGenerationMarkReference(reference)) marks.push(reference)
    else bases.push(reference)
  }
  if (!marks.length || !bases.length) return [...references]
  return [...bases, ...marks]
}

/** 局部重绘选区里要贴回去的标识图；人像底图已由 parent / 蒙版承担。 */
export function compositionOverlayReferences<T extends { name?: string }>(references: readonly T[] | undefined): T[] {
  return (references ?? []).filter((reference) => isGenerationMarkReference(reference))
}

export function withRegionEditOverlayReferences<
  T extends { references: U[]; maskRegion?: unknown },
  U extends { name?: string },
>(recipe: T, parentRecipe?: { references?: U[] }): T {
  if (!recipe.maskRegion || recipe.references.length) return recipe
  const overlays = compositionOverlayReferences(parentRecipe?.references)
  if (!overlays.length) return recipe
  return {
    ...recipe,
    references: overlays.map((item) => ({ ...item })),
  }
}

/**
 * 贴标识 / 还原 logo：默认走 GPT Image 2 多图 edits（一句话 + 参考图）。
 * 像素贴图层只在显式 composeMode=overlay 时启用，作为贴歪后的保底。
 */
export const markOverlayLanguagePattern =
  /(?:添加|加上|贴上|印上|放上|戴上|还原|严格还原|合成).{0,16}(?:logo|标识|徽章|勋章|胸针|领针|商标|标志)|(?:logo|标识|徽章|勋章|胸针|领针).{0,8}(?:贴|印|加|放|戴|还原|合成)/iu

export function instructionRequestsMarkOverlay(instruction: string) {
  return markOverlayLanguagePattern.test(String(instruction ?? ''))
}

export function shouldUseHighFidelityCompose(input: {
  prompt?: string
  parent?: { name?: string } | null
  references?: Array<{ name?: string }>
}) {
  const refs = [input.parent, ...(input.references ?? [])].filter(Boolean) as Array<{ name?: string }>
  return compositionOverlayReferences(refs).length > 0
    || instructionRequestsMarkOverlay(input.prompt ?? '')
}

/** gpt-image-2 合成必须用 high；该模型不允许传 input_fidelity。 */
export function gptImage2EditQuality(job: {
  prompt?: string
  parent?: { name?: string } | null
  references?: Array<{ name?: string }>
  settings?: { resolution?: string }
}) {
  if (shouldUseHighFidelityCompose(job)) return 'high'
  return job.settings?.resolution === '1K' ? 'low' : 'medium'
}

export function shouldPixelOverlayCompose(input: {
  prompt?: string
  maskRegion?: unknown
  references?: Array<{ name?: string }>
  composeMode?: string
}) {
  if (input.composeMode !== 'overlay') return false
  if (!input.maskRegion) return false
  return compositionOverlayReferences(input.references).length > 0
}

export function botanicAgentRegionSelectNotice(instruction: string, targetLabel: string) {
  const label = targetLabel.trim() || '当前结果'
  if (instructionRequestsMarkOverlay(instruction)) {
    return `请在「${label}」上框选标识要贴上去的位置。我们会把参考图原样贴进选区，不会让模型另造徽章。`
  }
  return `请在弹出的「${label}」上框选要重绘的区域；框外画面保持原样。`
}
