/**
 * 多图合成：images/edits 第一张是底图。标识类参考必须排在后面，
 * 并在 Prompt 里写明「原样使用」，不能再套「不要添加品牌标识」。
 * 与 src/domain/generationComposition.ts 的识别/排序规则保持同一份语义。
 */

export const generationMarkNamePattern =
  /logo|wordmark|word[\s-]?mark|标识|徽章|勋章|胸针|领针|袖标|臂章|商标|标志|标牌|emblem|badge|crest|monogram|insignia/iu

export function isGenerationMarkReference(reference) {
  const name = typeof reference?.name === 'string' ? reference.name.trim() : ''
  return Boolean(name) && generationMarkNamePattern.test(name)
}

export function orderCompositionReferences(references = []) {
  if (!Array.isArray(references) || references.length < 2) return [...(references ?? [])]
  const bases = []
  const marks = []
  for (const reference of references) {
    if (isGenerationMarkReference(reference)) marks.push(reference)
    else bases.push(reference)
  }
  if (!marks.length || !bases.length) return [...references]
  return [...bases, ...marks]
}

/**
 * 计算供应商实际接收的输入图像。这是 images/edits 端点的接收顺序：
 * parent 优先（若存在），否则使用排序后的 references。parent 出现在
 * references 里时需去重（按 buffer 相等性）。蒙版物化点与 generateImages
 * 都必须调用此函数，确保它们对「首张输入图」的理解同源，防止参考再排序时
 * 蒙版与实际传出的首图尺寸错配。
 */
export function providerInputImages(job) {
  const orderedReferences = orderCompositionReferences(job.references ?? [])
  if (job.parent) {
    return [job.parent, ...orderedReferences.filter((reference) => !reference.buffer.equals(job.parent.buffer))]
  }
  return orderedReferences
}

export function compositionOverlayReferences(references) {
  return (Array.isArray(references) ? references : []).filter((reference) => isGenerationMarkReference(reference))
}

export const markOverlayLanguagePattern =
  /(?:添加|加上|贴上|印上|放上|戴上|还原|严格还原|合成).{0,16}(?:logo|标识|徽章|勋章|胸针|领针|商标|标志)|(?:logo|标识|徽章|勋章|胸针|领针).{0,8}(?:贴|印|加|放|戴|还原|合成)/iu

export function instructionRequestsMarkOverlay(instruction) {
  return markOverlayLanguagePattern.test(String(instruction ?? ''))
}

export function shouldUseHighFidelityCompose(input = {}) {
  const refs = [input.parent, ...(input.references ?? [])].filter(Boolean)
  return compositionOverlayReferences(refs).length > 0
    || instructionRequestsMarkOverlay(input.prompt ?? '')
}

export function creativeExecutionContract(job) {
  // CreativePlanCompiler 已把同一份契约编译进执行 Prompt；Provider 只应补充
  // 旧版/外部工作流尚未编译的元数据，避免锁定约束在供应商提示词里重复出现。
  const prompt = typeof job?.prompt === 'string' ? job.prompt.trim() : ''
  if (/^(?:执行契约：|Creative execution contract:)/u.test(prompt)) return []
  const constraints = Array.isArray(job?.constraints) ? job.constraints : []
  const lines = constraints.map((constraint) => `${constraint.mode === 'preserve' ? '必须保持' : '允许变化'}：${constraint.dimension}${constraint.sourceAssetGroupId ? `（素材组 ${constraint.sourceAssetGroupId}）` : ''}。`)
  const branch = typeof job?.branchPromptDelta === 'string' && job.branchPromptDelta.trim()
    ? [`本分支变化：${job.branchPromptDelta.trim()}`]
    : []
  const intent = typeof job?.creativeIntent === 'string' && job.creativeIntent.trim()
    ? [`任务意图：${job.creativeIntent.trim()}。`]
    : []
  return [...intent, ...lines, ...branch]
}

/** gpt-image-2 合成必须用 high；该模型不允许传 input_fidelity。 */
export function gptImage2EditQuality(job) {
  if (shouldUseHighFidelityCompose(job)) return 'high'
  return job.settings?.resolution === '1K' ? 'low' : 'medium'
}

export function shouldPixelOverlayCompose(input = {}) {
  if (input.composeMode !== 'overlay') return false
  if (!input.maskRegion) return false
  return compositionOverlayReferences(input.references).length > 0
}

export function compositionBrandGuard(references = []) {
  return (Array.isArray(references) ? references : []).some((reference) => isGenerationMarkReference(reference))
    ? '参考图中的标识、文字与图形必须原样出现，禁止替换成其他徽章或随机图案。不要添加价格、二维码或水印。'
    : '不要添加参考图中没有的品牌标识、价格、二维码或水印。'
}

function describeCompositionInputs(job) {
  const orderedRefs = orderCompositionReferences(job.references ?? [])
  if (job.parent) {
    return [
      { name: job.parent.name ?? '父版本', role: job.parent.role ?? '底图', mark: isGenerationMarkReference(job.parent), base: true },
      ...orderedRefs.map((reference) => ({
        name: reference.name ?? '参考',
        role: reference.role ?? '参考',
        mark: isGenerationMarkReference(reference),
        base: false,
      })),
    ]
  }
  return orderedRefs.map((reference, index) => ({
    name: reference.name ?? '参考',
    role: reference.role ?? '参考',
    mark: isGenerationMarkReference(reference),
    base: index === 0,
  }))
}

function compositionIntent(job, inputs) {
  const isComposition = inputs.length >= 2
  const hasMask = Boolean(job.mask || job.maskRegion)
  const hasMark = inputs.some((item) => item.mark)
  if (job.kind === 'refinement' && job.refinementMode === 'explore') {
    return '基于首图父版本生成探索型视觉变体；保持商品主体、人物身份与产品识别度，但主动探索不同构图、机位、光影或环境，不要只输出近似复制图。'
  }
  if (hasMark && isComposition) {
    const placement = hasMask
      ? '只改蒙版内区域，把后续 Image 中的标识原样嵌入选区；选区外保持原样。'
      : '把后续 Image 中的标识、图形与文字原样放到 Image 1 用户指定的位置（领针、勋章、胸口、袖标等）。只改标识所在局部，人物身份、服装、构图、光影保持不变。'
    return `GPT Image 多图编辑：按上传顺序，Image 1 是底图，后续 Image 是必须嵌入的原件，不是风格或氛围参考。${placement}禁止另造徽章、花结或把标识改写成普通印刷字。`
  }
  if (job.kind === 'refinement' && hasMask) {
    return isComposition
      ? '局部重绘：只改蒙版内区域，选区外保持原样。Image 1 是底图，后续 Image 是必须原样使用的元素，用来填进选区，不是风格或氛围参考。'
      : '局部重绘：只改蒙版内区域，选区外保持原样。'
  }
  if (job.kind === 'refinement') {
    return isComposition
      ? '多图精修：Image 1 是底图，后续 Image 是必须原样使用的元素，不是风格或氛围参考。保留底图的人物身份、构图与产品识别度，仅按本次要求调整。'
      : '基于首图父版本进行忠实精修；保留构图、主体和产品识别度，仅按本次要求调整。'
  }
  return isComposition
    ? '多图合成：Image 1 是底图（人物、场景或已有画面），后续 Image 是必须原样使用的元素，不是风格或氛围参考。'
    : '生成品牌时尚视觉；主体必须清晰、可识别。'
}

export function buildImageProviderPrompt(job, variationIndex) {
  const inputs = describeCompositionInputs(job)
  const isComposition = inputs.length >= 2
  const imageLines = inputs.map((item, index) => {
    const duty = item.base
      ? '底图，作为编辑起点'
      : item.mark
        ? '必须忠实复原其图形与文字，禁止改成其他图案'
        : '按提示词参与合成，保持可识别'
    return `Image ${index + 1}（${item.role}：${item.name}）：${duty}。`
  }).join('\n')
  const primary = (job.references ?? []).find((reference) => reference.primary)
  return [
    compositionIntent(job, inputs),
    imageLines,
    !isComposition && primary ? `主商品参考：${primary.name}。商品外观、材质、标识应保持可信。` : '',
    job.settings?.aspectRatio
      ? `画面比例：${job.settings.aspectRatio}；输出规格：${job.settings.resolution ?? ''}。`
      : '',
    ...creativeExecutionContract(job),
    `创意目标：${job.prompt}`,
    variationIndex === undefined ? '' : `本张为同批候选 ${variationIndex + 1}；请与同批其他候选形成可见差异，同时保持主体一致。`,
    compositionBrandGuard([job.parent, ...(job.references ?? [])].filter(Boolean)),
  ].filter(Boolean).join('\n')
}
