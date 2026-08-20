const roleOrder = new Map([
  ['模特', 10],
  ['人物', 10],
  ['商品', 20],
  ['场景', 30],
  ['调性', 40],
  ['首图', 50],
  ['参考', 60],
])

function referenceOrder(reference, index) {
  const role = typeof reference?.role === 'string' ? reference.role : '参考'
  return [
    reference?.primary ? 0 : 1,
    roleOrder.get(role) ?? 90,
    Number.isFinite(Number(reference?.priority)) ? Number(reference.priority) : index,
    index,
  ]
}

/** 让主体/人物先于标识、场景等叠加参考进入供应商。 */
export function orderCompositionReferences(references = []) {
  return references
    .map((reference, index) => ({ reference, index, order: referenceOrder(reference, index) }))
    .sort((left, right) => left.order.find((value, index) => value !== right.order[index]) - right.order.find((value, index) => value !== left.order[index]))
    .map(({ reference }) => reference)
}

/** 父结果已经单独作为 base image，局部重绘只继承非主参考叠加层。 */
export function compositionOverlayReferences(references = []) {
  return references.filter((reference) => !reference?.primary)
}

function brandReference(reference) {
  const text = `${reference?.role ?? ''} ${reference?.name ?? ''}`.toLowerCase()
  return /logo|brand|mark|badge|seal|watermark|标识|徽标|商标|勋章|文字/.test(text)
}

/** 多图合成时明确品牌/文字参考的保真约束，防止供应商把它当普通风格参考。 */
export function compositionBrandGuard(references = []) {
  if (!references.some(brandReference)) return ''
  return '多图合成：品牌标识、徽标、勋章与文字参考必须忠实复原，保持字形、比例、位置与可识别细节，不得改写或虚构。'
}

export function buildImageProviderPrompt(job, variationIndex = 0) {
  const references = Array.isArray(job?.references) ? job.references : []
  const composition = references.length > 1
    ? `多图合成：按参考素材的角色组合画面；主体参考保持身份与关键外观，其他参考只用于其声明的内容。`
    : ''
  const variation = variationIndex > 0
    ? `同批候选 ${variationIndex + 1}：保持主体与品牌细节一致，形成克制且可见的构图或光线差异。`
    : ''
  return [job?.prompt, composition, compositionBrandGuard(references), variation].filter(Boolean).join('\n')
}
