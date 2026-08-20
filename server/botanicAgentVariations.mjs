function clipBotanicAgentNodeTitle(value) {
  if (typeof value !== 'string') return ''
  return Array.from(value.replace(/[\s·.,，。:：；;、\-_/\\]+/gu, '')).slice(0, 8).join('')
}

const canvasPromptMetaPattern = /^(?:说明一下(?:来源)?|来源说明|补充说明)[:：]/u
const canvasPromptMetaBodyPattern = /(?:我没有读取到|当前项目上下文里|根据(?:之前的)?对话上下文)/u
const plannerNarrationPattern = /(?:项目没有配置|没有配置批量|没有启用批量|缺(?:少)?(?:\d+个)?字段|只差.{0,12}字段|批量(?:变体)?\s*Skill|当前无法批量|请确认.{0,12}取值|按推荐值继续|确认前不会(?:执行|生成)|待确认计划)/u

export function botanicAgentLooksLikePlannerNarration(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) return false
  return canvasPromptMetaPattern.test(value)
    || canvasPromptMetaBodyPattern.test(value)
    || plannerNarrationPattern.test(value)
}

/** 创作简报附录是给规划器的上下文，不是画面描述；与客户端 compileBriefPrompt 的格式对应。 */
function stripCreativeBriefNotes(text) {
  return text.replace(/\n{2,}创作简报：[\s\S]*$/u, '').trim()
}

// 与 src/domain/agent.ts 的同名函数保持逐行一致；一致性由 scripts/fixtures 的镜像夹具锁定。
export function botanicAgentVisualGenerationPrompt(prompt, fallback = '') {
  const text = typeof prompt === 'string' ? stripCreativeBriefNotes(prompt.trim()) : ''
  const blocks = text.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean)
  const visual = blocks.filter((block) => !botanicAgentLooksLikePlannerNarration(block)).join('\n\n').trim()
  if (visual && !botanicAgentLooksLikePlannerNarration(visual)) return visual
  const fallbackText = typeof fallback === 'string' ? stripCreativeBriefNotes(fallback.trim()) : ''
  if (fallbackText && !botanicAgentLooksLikePlannerNarration(fallbackText)) return fallbackText
  return ''
}

const variationDimensionPattern = '人物|模特|角色|场景|背景|画面|环境|肤色|族裔|人种|动作|姿势|姿态|风格|服装|衣服|穿搭|版本|变体'

function stripPreserveClauses(instruction) {
  return String(instruction ?? '').replace(/(?:保持|保留)[^，。,；;\n]{0,40}?(?:不变|一致)/gu, ' ')
}

export function instructionRequestsBatchVariation(instruction) {
  const text = stripPreserveClauses(instruction).trim()
  if (!text) return false
  if (/(?:批量|多图|多张|逐一|多来几|来几个|多出几|多肤色)/u.test(text)) return true
  if (/(?:\d+|两|二|三|四|五|六|七|八|九|十)\s*张/u.test(text)) return true
  if (new RegExp(`(?:\\d+|两|三|四|五|六|七|八|九|十)(?:种|档)(?:不同(?:的)?)?(?:${variationDimensionPattern})`, 'u').test(text)) return true
  if (new RegExp(`(?:[2-9]|[1-9]\\d|十|两|三|四|五|六|七|八|九)个(?:不同(?:的)?)?(?:[\\u4e00-\\u9fff]{0,6})?(?:${variationDimensionPattern})`, 'u').test(text)) return true
  if (new RegExp(`(?:多个|多种|几种|几个|一组|一批)(?:不同(?:的)?)?(?:${variationDimensionPattern})`, 'u').test(text)) return true
  return false
}

export function resolveBotanicAgentIntent(instruction, requestedIntent) {
  if (instructionRequestsBatchVariation(instruction)) return 'batch_variation'
  return requestedIntent
}

export const botanicAgentVariationBranchLimit = 20
export const botanicAgentVariationValueMin = 2
export const botanicAgentVariationValueMax = 8





export const botanicAgentVariationClarificationFieldIds = ['variation_values', 'variation_combine']

const axisCatalog = [
  { key: 'skin_tone', label: '肤色', names: ['肤色', '皮肤色', '肤质色'], promptDelta: (value) => `人物肤色为${value}，保持五官与身份不变。` },
  { key: 'ethnicity', label: '族裔', names: ['族裔', '人种'], promptDelta: (value) => `人物族裔特征调整为${value}，保持五官结构、发型与服装不变。` },
  { key: 'scene', label: '场景', names: ['场景', '背景'], promptDelta: (value) => `场景替换为${value}，保持人物、服装与商品不变。` },
  { key: 'pose', label: '动作', names: ['动作', '姿势', '姿态'], promptDelta: (value) => `动作调整为${value}，保持人物身份与服装不变。` },
  { key: 'style', label: '风格', names: ['风格', '调性'], promptDelta: (value) => `视觉风格调整为${value}，保持人物、服装与商品不变。` },
  { key: 'person', label: '人物', names: ['人物', '模特'], promptDelta: (value) => `人物替换为${value}，保持服装、商品与场景不变。` },
  { key: 'garment', label: '服装', names: ['服装', '衣服', '球衣'], promptDelta: (value) => `服装替换为${value}，保持人物身份与场景不变。` },
]

const axisNameValues = new Set([
  '人物', '模特', '角色', '场景', '背景', '画面', '环境',
  '肤色', '族裔', '人种', '动作', '姿势', '姿态', '风格', '调性', '服装', '衣服', '穿搭', '球衣',
])
const valueJunkPattern = /^(?:各种|多种|一些|任意|几个|多图|多张|变体|版本|图片|生成|层次|细节|道具|质感|细腻|更细腻|档位|字段|推荐值|说明|选项)$/u
/** 含这些元话语的片段是指令本身而不是取值：「生成在不同背景下」不是一个背景。 */
const valueMetaPattern = /不同|生成|出图|比方|例如|譬如/u
const combineLanguagePattern = /组合|相乘|交叉|笛卡尔|[×x]\s*\d|全部组合|逐一组合/u
const chineseCountByToken = {
  两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const groupRoleByKey = {
  scene: '场景', person: '模特', garment: '商品', style: '调性',
}

function isUsableVariationValue(label) {
  if (!label || Array.from(label).length > 8) return false
  // 「不同背景下的」这类表达剥掉轴名后只剩方位助词，不是取值。
  if (/^(?:[的地得了着]|[在于下里中上旁边处]{0,2}的)$/u.test(label)) return false
  if (axisNameValues.has(label) || valueJunkPattern.test(label) || valueMetaPattern.test(label)) return false
  if (/[更最]/.test(label) || /(?:层次|细节|道具)$/u.test(label)) return false
  return true
}

function uniqueLabels(values) {
  const seen = new Set()
  return values.flatMap((value) => {
    // 截断前先按原文拒绝：@ 引用与元话语片段截短后会伪装成合法取值。
    if (value.includes('@') || valueMetaPattern.test(value)) return []
    const label = clipBotanicAgentNodeTitle(value)
    if (!isUsableVariationValue(label) || seen.has(label)) return []
    seen.add(label)
    return [label]
  }).slice(0, botanicAgentVariationValueMax)
}

/** 「一个白人一个黑人」这类并列计数枚举：计数词后的短词是取值，「一个在」交给方位并列。 */
const counterEnumPattern = /(?:一个|一位|一名)(?!在)([\u4e00-\u9fff]{1,8}?)(?=一个|一位|一名|[，。,；;、\s]|$)/gu

function normalizeVariationToken(chunk) {
  return chunk
    .replace(/[，,]\s*(?:多图|多张|多出几张).*$/u, '')
    .replace(/^(?:比方说|比如说|比如|例如|譬如)/u, '')
    .replace(/^一个在/u, '')
    // 「一个白人」的计数词不是取值前缀；连写的「一个X一个Y」保留原文交给并列拆分。
    .replace(/^(?:一个|一位|一名)(?=[\u4e00-\u9fff])(?![\s\S]*(?:一个|一位|一名))/u, '')
    .replace(/^在(?=[\u4e00-\u9fff])/u, '')
    .replace(/里$/u, '')
    .trim()
}

function splitValueList(raw) {
  return uniqueLabels(raw.split(/[、，,;/＋+|]/u).flatMap((item) => {
    const chunk = normalizeVariationToken(item
      .replace(/(?:等)?\s*(?:\d+|两|三|四|五|六|七|八|九|十)\s*(?:种|个|档).*$/u, '')
      .replace(/^(?:分别是|分别|包括|比方说|比如说|比如|例如|譬如)/u, '')
      .replace(/^(?:换成|换为|替换为|改为|改成|使用|用)/u, '')
      // 「换肤色」「改背景」是动宾指令：剥掉动词后剩下的轴名会被取值过滤拒绝。
      .replace(/^[换改](?=(?:肤色|场景|背景|风格|动作|姿势|姿态|服装|衣服|人物|模特|调性))/u, '')
      .trim())
    if (!chunk || /不变|保持/.test(chunk)) return []
    const counterParts = [...chunk.matchAll(counterEnumPattern)].map((match) => match[1])
    if (counterParts.length >= 2) return counterParts
    // 「和」切分只认两侧都是 ≥2 字的短词：「海边和沙漠」是枚举，「柔和的自然光」不是。
    const parts = chunk.split(/(?:(?<=\S)和(?=\S))/u).map((part) => normalizeVariationToken(part)).filter(Boolean)
    if (parts.length === 2 && parts.every((part) => {
      const length = Array.from(part).length
      return length >= 2 && length <= 8
    })) return parts
    return chunk ? [chunk] : []
  }))
}

function splitNumberedList(text) {
  if (!/(?:^|[\s\n])\d+[\.．、)]/u.test(text) && !/\(\d+\)/.test(text)) return []
  const parts = text.split(/(?:^|[\s\n]+)(?:\d+[\.．、)]|\(\d+\))\s*/u)
    .map((part) => normalizeVariationToken(part))
    .filter(Boolean)
  return uniqueLabels(parts)
}

function parallelLocationValues(text) {
  return uniqueLabels([...text.matchAll(/一个在([\u4e00-\u9fff]{1,8}?)(?=一个在|[，。,；;、\s]|$)/gu)].map((match) => match[1]))
}

function parallelCounterValues(text) {
  return uniqueLabels([...text.matchAll(counterEnumPattern)].map((match) => match[1]))
}

function inferInstructionValues(text) {
  const numbered = splitNumberedList(text)
  if (numbered.length >= botanicAgentVariationValueMin) return numbered
  const parallel = parallelLocationValues(text)
  if (parallel.length >= botanicAgentVariationValueMin) return parallel
  const counters = parallelCounterValues(text)
  if (counters.length >= botanicAgentVariationValueMin) return counters
  return listedValuesFromText(text)
}

function parseCountToken(token) {
  if (chineseCountByToken[token] != null) return chineseCountByToken[token]
  const count = Number(token)
  return Number.isInteger(count) && count >= 2 && count <= botanicAgentVariationBranchLimit ? count : null
}

function statedAxisCount(text, names) {
  for (const name of names) {
    const patterns = [
      new RegExp(`(\\d+|两|二|三|四|五|六|七|八|九|十)\\s*(?:种|个|档)(?:不同(?:的)?)?${name}`, 'u'),
      new RegExp(`${name}[^。；\\n]{0,16}?(\\d+|两|二|三|四|五|六|七|八|九|十)\\s*(?:种|个|档)`, 'u'),
    ]
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (!match) continue
      const count = parseCountToken(match[1])
      if (count != null) return count
    }
  }
  return null
}

function axisCountMismatch(axis, instruction) {
  if (axis.values.length < botanicAgentVariationValueMin) return false
  const item = axisCatalog.find((entry) => entry.key === axis.key)
  const count = statedAxisCount(instruction, item ? [item.label, ...item.names] : [axis.label])
  return count != null && axis.values.length !== count
}

function statedOutputCount(text) {
  for (const match of text.matchAll(/(\d+|两|二|三|四|五|六|七|八|九|十)\s*张(?:图|照片|画面)?/gu)) {
    const count = parseCountToken(match[1])
    if (count != null) return count
  }
  return null
}

function listedValuesFromText(text) {
  const numbered = splitNumberedList(text)
  if (numbered.length >= botanicAgentVariationValueMin) return numbered
  const segments = text.includes('|')
    ? text.split('|').map((cell) => cell.trim()).filter(Boolean)
    : [text]
  for (const segment of segments) {
    const values = splitValueList(segment)
    if (values.length >= botanicAgentVariationValueMin && /[、，,;/＋+]/u.test(segment)) return values
  }
  const values = splitValueList(text)
  if (values.length >= botanicAgentVariationValueMin && /[、，,;/＋+|]/u.test(text)) return values
  return []
}

function extractEnumeration(text, item) {
  let label = item.label
  let index = -1
  for (const name of item.names) {
    const found = text.lastIndexOf(name)
    if (found > index) {
      index = found
      label = name
    }
  }
  if (index < 0) return []
  let before = text.slice(0, index)
  for (const other of axisCatalog.flatMap((entry) => entry.names)) {
    if (other === label) continue
    const otherIndex = before.lastIndexOf(other)
    if (otherIndex >= 0) before = before.slice(otherIndex + other.length)
  }
  before = before.replace(/^[，,、。；:\s]+/u, '')
  const after = text.slice(index + label.length).split(/[。；\n]/u)[0]
    .replace(/^[为是用：:\s]+/u, '')
  const countableAfter = after.replace(/(?:生成|出|做|来)?\s*(?:\d+|两|二|三|四|五|六|七|八|九|十)\s*张(?:图|照片|画面)?/gu, ' ')
  const countableBefore = before.replace(/(?:生成|出|做|来)?\s*(?:\d+|两|二|三|四|五|六|七|八|九|十)\s*张(?:图|照片|画面)?/gu, ' ')
  const fromAfter = listedValuesFromText(countableAfter)
  const fromBefore = listedValuesFromText(countableBefore)
  if (after.includes('|') && fromAfter.length) return fromAfter
  if (fromBefore.length) return fromBefore
  if (fromAfter.length) return fromAfter
  return inferInstructionValues(countableAfter)
}

function axisFromCatalog(item, values) {
  return {
    key: item.key,
    label: item.label,
    values: values.map((label) => ({ label, promptDelta: item.promptDelta(label) })),
  }
}

function customAxis(values) {
  return {
    key: 'custom',
    label: '变体',
    values: values.map((label) => ({
      label,
      promptDelta: `画面按「${label}」这一变体调整，其余主体保持不变。`,
    })),
  }
}

function catalogNameIsConstraintOnly(text, item) {
  if (item.key !== 'person') return false
  const stripped = text.replace(/同一(?:位|个)?(?:女性|男性)?人物|人物(?:要|需|必须)?(?:全身|半身|站立|出镜)|保持人物|人物身份/gu, '')
  return !item.names.some((name) => stripped.includes(name))
}

function parseAxes(instruction) {
  const text = instruction.trim()
  const found = []
  const seen = new Set()
  const ordered = [...axisCatalog].sort((left, right) => {
    const leftIndex = Math.min(...left.names.map((name) => {
      const index = text.indexOf(name)
      return index < 0 ? Number.POSITIVE_INFINITY : index
    }))
    const rightIndex = Math.min(...right.names.map((name) => {
      const index = text.indexOf(name)
      return index < 0 ? Number.POSITIVE_INFINITY : index
    }))
    return leftIndex - rightIndex
  })
  for (const item of ordered) {
    if (!item.names.some((name) => text.includes(name))) continue
    if (catalogNameIsConstraintOnly(text, item)) continue
    const values = extractEnumeration(text, item)
    if (seen.has(item.key)) continue
    if (values.length < botanicAgentVariationValueMin && !instructionRequestsBatchVariation(text)) continue
    seen.add(item.key)
    found.push(axisFromCatalog(item, values))
  }
  // 「模特换肤色」里的“模特”只是换肤色的宾语：两轴切出同一组取值时，更具体的肤色轴优先。
  const skinAxis = found.find((axis) => axis.key === 'skin_tone')
  const personAxis = found.find((axis) => axis.key === 'person')
  if (skinAxis && personAxis
    && skinAxis.values.length >= botanicAgentVariationValueMin
    && personAxis.values.map((value) => value.label).join('\u0001') === skinAxis.values.map((value) => value.label).join('\u0001')) {
    return found.filter((axis) => axis.key !== 'person')
  }
  return found
}

const skinToneValuePattern = /白|麦|棕|黑|黄|冷|暖|自然|健康|古铜|蜜|橄榄|浅|中|深/u
const sceneValuePattern = /海边|沙漠|宇宙|森林|街道|海滩|雪地|室内|户外|棚拍|夜景|城市|公园|沙滩|沙丘|星空/u

function looksLikeSceneValue(label) {
  return sceneValuePattern.test(label)
}

function axisFromListedValues(listed, axisKey) {
  const known = axisKey ? axisCatalog.find((item) => item.key === axisKey) : undefined
  if (known) return axisFromCatalog(known, listed)
  const scene = axisCatalog.find((item) => item.key === 'scene')
  if (scene && listed.filter(looksLikeSceneValue).length >= botanicAgentVariationValueMin) {
    return axisFromCatalog(scene, listed)
  }
  const skin = axisCatalog[0]
  return listed.every((label) => skinToneValuePattern.test(label))
    ? axisFromCatalog(skin, listed)
    : customAxis(listed)
}

function fillAxisValues(axes, listed, axisKey) {
  if (!listed.length) return axes
  const incomplete = axes.find((axis) => axis.values.length < botanicAgentVariationValueMin)
  if (incomplete) {
    const catalog = axisCatalog.find((item) => item.key === incomplete.key)
    return axes.map((axis) => axis.key === incomplete.key && catalog
      ? axisFromCatalog(catalog, listed)
      : axis)
  }
  if (!axes.length) return [axisFromListedValues(listed, axisKey)]
  return axes
}

export function expandBotanicAgentVariationBranches(spec) {
  const ready = spec.axes.filter((axis) => axis.values.length >= botanicAgentVariationValueMin
    && axis.values.length <= botanicAgentVariationValueMax)
  if (!ready.length) return []
  const selected = spec.combine && ready.length > 1 ? ready : [ready[0]]
  const combos = selected.reduce(
    (accumulator, axis) => {
      if (!accumulator.length) return axis.values.map((value) => [{ axis, value }])
      return accumulator.flatMap((combo) => axis.values.map((value) => [...combo, { axis, value }]))
    },
    [],
  )
  return combos.map((combo) => ({
    label: clipBotanicAgentNodeTitle(combo.map((item) => item.value.label).join('')) || combo[0].value.label,
    promptDelta: combo.map((item) => item.value.promptDelta).join('\n'),
    values: combo.map((item) => ({
      key: item.axis.key,
      axisLabel: item.axis.label,
      valueLabel: item.value.label,
    })),
  }))
}

function variationCount(spec) {
  const ready = spec.axes.filter((axis) => axis.values.length >= botanicAgentVariationValueMin)
  if (!ready.length) return 0
  if (!spec.combine) return ready[0].values.length
  return ready.reduce((total, axis) => total * axis.values.length, 1)
}

function finalizeReadySpec(instruction, spec) {
  const count = variationCount(spec)
  const stated = statedOutputCount(instruction)
  if (stated != null && count !== stated) {
    const axisLabel = spec.axes[0]?.label ?? '变体'
    return {
      kind: 'ask',
      clarification: createVariationClarification({
        instruction,
        question: `你说了生成 ${stated} 张，但我按当前变化轴会展开成 ${count} 张。请确认最终张数，或把每个${axisLabel}单独写清楚。`,
        fields: [valuesField(axisLabel)],
      }),
    }
  }
  return { kind: 'ready', spec }
}

function createVariationClarification(input) {
  const brief = input.brief
    ? { ...input.brief, variation: { ...(input.axisKey ? { axisKey: input.axisKey } : {}), values: [] } }
    : undefined
  return {
    id: 'clarification-variation',
    question: input.question,
    helper: input.helper ?? '取值需要具体到 2–8 个短词；张数由展开结果决定，不会立即生成。',
    originalInstruction: input.instruction,
    ...(brief ? { brief } : {}),
    fields: input.fields,
  }
}

function valuesField(axisLabel) {
  return {
    id: 'variation_values',
    label: `${axisLabel}取值`,
    required: true,
    control: 'text',
    placeholder: axisLabel === '肤色' ? '例如：白皙、自然、小麦、深棕' : `例如：列出 2 到 8 个${axisLabel}`,
    options: [],
  }
}

function combineField(first, second, product) {
  return {
    id: 'variation_combine',
    label: '是否组合',
    required: true,
    control: 'single_choice',
    defaultValue: 'first',
    options: [
      { value: 'first', label: `只做${first.label} ${first.values.length} 张`, description: '默认只拆一条轴' },
      { value: 'combine', label: `组合 ${product} 张`, description: `${first.label}×${second.label}` },
    ],
  }
}

function stripCreativeBriefAppendix(instruction) {
  return String(instruction ?? '').replace(/\n{2,}创作简报：[\s\S]*$/u, '').trim()
}

export function resolveBotanicAgentVariationRequest(input) {
  const instruction = stripCreativeBriefAppendix(input.instruction.trim())
  const intent = resolveBotanicAgentIntent(instruction, input.requestedIntent)
  const answered = splitValueList(input.clarificationAnswers?.variation_values ?? '')
  const confirmed = answered.length ? answered : uniqueLabels(input.brief?.variation?.values ?? [])
  const explicitBatch = instructionRequestsBatchVariation(instruction) || intent === 'batch_variation'
  // 隐式枚举挖掘只对短指令生效：长文本是画面描述（如模型综合的 Prompt），
  // 里面的逗号列表是句子成分而不是取值，挖出来只会产生伪变体和碎片分支。
  const implicitMiningAllowed = explicitBatch || Array.from(instruction).length <= 40
  const allowCustomAxis = explicitBatch || confirmed.length >= botanicAgentVariationValueMin
  const inferred = confirmed.length ? confirmed : implicitMiningAllowed ? inferInstructionValues(instruction) : []
  const axes = fillAxisValues(implicitMiningAllowed ? parseAxes(instruction) : [], inferred, input.brief?.variation?.axisKey)
    .filter((axis) => axis.key !== 'custom' || allowCustomAxis)
  const wantsBatch = explicitBatch
    || confirmed.length >= botanicAgentVariationValueMin
    || axes.some((axis) => axis.key !== 'custom' && axis.values.length >= botanicAgentVariationValueMin)
  const group = input.assetGroup
  const groupMatches = Boolean(group?.id && group.assetCount > 0 && axes[0] && groupRoleByKey[axes[0].key] === group.role)
    || Boolean(group?.id && group.assetCount > 0 && wantsBatch && !axes.some((axis) => axis.key === 'skin_tone') && !parseAxes(instruction).length)
  if (groupMatches && group && (!axes.length || axes.every((axis) => axis.values.length < botanicAgentVariationValueMin))) {
    return { kind: 'asset_group', groupId: group.id, count: group.assetCount }
  }
  if (!wantsBatch && !axes.length) return { kind: 'none' }

  const combineAnswer = input.clarificationAnswers?.variation_combine?.trim()
  const combineRequested = combineAnswer === 'combine' || (combineAnswer !== 'first' && combineLanguagePattern.test(instruction))
  const readyAxes = axes.filter((axis) => axis.values.length >= botanicAgentVariationValueMin && !axisCountMismatch(axis, instruction))
  const incomplete = axes.find((axis) => axis.key && (axis.values.length < botanicAgentVariationValueMin || axisCountMismatch(axis, instruction)))
    ?? (wantsBatch && !axes.length ? { key: 'custom', label: '变体', values: [] } : undefined)

  if (readyAxes.length >= 2 && combineRequested) {
    const product = readyAxes.reduce((total, axis) => total * axis.values.length, 1)
    if (product > botanicAgentVariationBranchLimit) {
      return {
        kind: 'ask',
        clarification: createVariationClarification({
          instruction,
          brief: input.brief,
          question: `组合后共 ${product} 张，超过单次 ${botanicAgentVariationBranchLimit} 张上限。请只拆一条轴，或减少取值。`,
          fields: [combineField(readyAxes[0], readyAxes[1], Math.min(product, botanicAgentVariationBranchLimit))],
        }),
      }
    }
    return finalizeReadySpec(instruction, { axes: readyAxes, combine: true })
  }

  if (incomplete && readyAxes.length < 1) {
    return {
      kind: 'ask',
      clarification: createVariationClarification({
        instruction,
        brief: input.brief,
        axisKey: incomplete.key,
        question: incomplete.label === '肤色'
          ? '这次要按几种肤色出图？请列出 2 到 8 个具体取值，例如白皙、自然、小麦、深棕。'
          : `这次要按「${incomplete.label}」出多张。请列出 2 到 8 个具体取值，不要用「各种」代替。`,
        fields: [valuesField(incomplete.label)],
      }),
    }
  }

  if (!readyAxes.length) {
    return {
      kind: 'ask',
      clarification: createVariationClarification({
        instruction,
        brief: input.brief,
        question: '这次要按哪一个维度出多张？请列出 2 到 8 个具体取值。',
        fields: [valuesField('变体')],
      }),
    }
  }

  return finalizeReadySpec(instruction, { axes: readyAxes, combine: false })
}

/**
 * 结构化变体请求：语义理解已由回合模型完成（每个变体的短名与差异描述），
 * 这里只做确定性校验——去重、条数上限、与用户口头张数一致性。校验不过仍然追问，护栏留在代码里。
 */
export function botanicAgentStructuredVariationRequest(input) {
  const instruction = stripCreativeBriefAppendix(input.instruction.trim())
  const seen = new Set()
  const values = []
  for (const variant of input.variants) {
    const label = clipBotanicAgentNodeTitle(variant.label?.trim() ?? '')
    const promptDelta = variant.promptDelta?.trim() ?? ''
    if (!label || !promptDelta || seen.has(label)) continue
    seen.add(label)
    values.push({ label, promptDelta })
  }
  if (values.length < botanicAgentVariationValueMin) return { kind: 'none' }
  const axisLabel = clipBotanicAgentNodeTitle(input.axisLabel?.trim() ?? '') || '变体'
  if (values.length > botanicAgentVariationValueMax) {
    return {
      kind: 'ask',
      clarification: createVariationClarification({
        instruction,
        brief: input.brief,
        question: `一次最多展开 ${botanicAgentVariationValueMax} 个${axisLabel}变体，这次列了 ${values.length} 个。请挑出最重要的 ${botanicAgentVariationValueMax} 个以内取值。`,
        fields: [valuesField(axisLabel)],
      }),
    }
  }
  return finalizeReadySpec(instruction, {
    axes: [{ key: 'custom', label: axisLabel, values }],
    combine: false,
  })
}

function variationLabels(spec) {
  return spec?.axes.flatMap((axis) => axis.values.map((value) => value.label)) ?? []
}

function stillEnumeratesValues(text, spec) {
  const labels = variationLabels(spec).filter((label) => Array.from(label).length >= 2)
  return labels.filter((label) => text.includes(label)).length >= 2
}

function stripVariationInventory(text, spec) {
  let next = text
  const lists = spec?.axes.flatMap((axis) => {
    const joined = axis.values.map((value) => value.label).join('、')
    return joined ? [joined] : []
  }) ?? []
  for (const list of lists) next = next.replace(list, '')
  next = next
    .replace(/(?:^|\n)\s*(?:\d+[\.．、)]|\(\d+\))\s*[^\n]*/gu, ' ')
    .replace(/一个在[^\s、，,。；;]{1,8}/gu, ' ')
  for (const label of variationLabels(spec)) {
    if (Array.from(label).length >= 2) next = next.split(label).join('')
  }
  next = next
    // 数字后是比例分隔符时不是「N 种」清单（如「画面比例 3:4」），不能连片吃掉。
    .replace(/(?:[\u4e00-\u9fffA-Za-z0-9]{1,8}[、，,]){1,7}[\u4e00-\u9fffA-Za-z0-9]{1,8}\s*(?:等)?\s*(?:\d+(?![:：\d])|两|三|四|五|六|七|八|九|十)种?[。]?/gu, '')
    .replace(/(?:多图|多张|多出几张|多种|几个|各种)/gu, '')
    .replace(/(?:两|三|四|五|六|七|八|九|十|\d+)种(?:肤色|场景|动作|风格|人物|服装|变体)?/gu, '')
    .replace(/[、，,\s]{2,}/gu, '，')
    .replace(/^[、，\s]+|[、，\s]+$/gu, '')
    .replace(/，+。/gu, '。')
    .trim()
  return next
}

function usableSharedPrompt(text, spec) {
  // 回退源可能是未清洗的原指令：先剥创作简报附录，否则清理折叠换行后附录会混进提示词正文。
  const stripped = stripVariationInventory(stripCreativeBriefAppendix(text), spec)
  if (!stripped || botanicAgentLooksLikePlannerNarration(stripped) || stillEnumeratesValues(stripped, spec)) return ''
  return stripped
}

export function botanicAgentSharedVariationPrompt(prompt, instruction, spec, fallbackPrompt = '') {
  const cleaned = botanicAgentVisualGenerationPrompt(prompt, '')
  const source = !cleaned || botanicAgentLooksLikePlannerNarration(cleaned)
    ? botanicAgentVisualGenerationPrompt(instruction, '')
    : cleaned
  return usableSharedPrompt(source, spec)
    || usableSharedPrompt(fallbackPrompt, spec)
    || usableSharedPrompt(instruction, spec)
    || '保持人物身份、服装与商品不变，仅按变体说明调整画面。'
}

export function botanicAgentBranchGenerationPrompt(prompt, promptDelta, fallback = '') {
  const base = botanicAgentVisualGenerationPrompt(prompt, fallback)
  const delta = promptDelta?.trim()
  return delta ? `${base}\n\n${delta}` : base
}

export function botanicAgentPlanOutputLabel(plan) {
  if (plan.output.mode === 'single' && plan.output.count <= 1) return '1 个版本'
  if (plan.output.mode === 'single') return `${plan.output.count} 个版本`
  return `${plan.output.count} 个分支`
}


export function botanicAgentConfirmBranchDrafts(plan, options = {}) {
  const group = options?.group
  // 成套方案的分支就是方案条目本身：异构（图片/视频混排）由条目携带，不进变体展开。
  if (plan.composition?.items?.length) {
    return plan.composition.items.map((item) => ({
      label: clipBotanicAgentNodeTitle(item.title) || `第 ${item.index} 项`,
      item,
    }))
  }
  if (plan.output.mode === 'batch_by_asset' && group?.assetIds.length) {
    return group.assetIds.map((assetId, index) => ({
      assetId,
      label: clipBotanicAgentNodeTitle(group.names[index] || plan.title || `分支${index + 1}`) || `分支${index + 1}`,
    }))
  }
  if (plan.output.mode === 'batch_by_variation' && plan.variation) {
    return expandBotanicAgentVariationBranches(plan.variation).map((variation) => ({
      label: variation.label,
      variation,
    }))
  }
  return [{ label: clipBotanicAgentNodeTitle(plan.title || '') || '新版本' }]
}


const identityAxisKeys = new Set(['skin_tone', 'ethnicity'])
const creativeDimensionKeys = new Set(['person', 'garment', 'product', 'scene', 'style', 'pose', 'composition', 'lighting', 'aspect_ratio', 'copy_space'])

function varyConstraintForAxis(axis) {
  const dimension = identityAxisKeys.has(axis.key)
    ? undefined
    : creativeDimensionKeys.has(axis.key)
      ? axis.key
      : 'style'
  if (identityAxisKeys.has(axis.key)) {
    return [
      { dimension: 'person', mode: 'preserve' },
      { dimension: 'garment', mode: 'preserve' },
      { dimension: 'product', mode: 'preserve' },
      { dimension: 'scene', mode: 'preserve' },
      { dimension: 'style', mode: 'vary' },
    ]
  }
  const preserve = ['person', 'garment', 'product', 'scene', 'style', 'pose']
  return preserve.map((item) => ({
    dimension: item,
    mode: item === dimension ? 'vary' : 'preserve',
  }))
}

export function applyBotanicAgentVariationToPlan(plan, input) {
  // 模型已结构化声明变体时不再挖自然语言；声明不可用（去重后不足 2 条）则退回正则解析。
  const structured = input.structuredVariants?.length
    ? botanicAgentStructuredVariationRequest({
      instruction: input.instruction || plan.instruction,
      variants: input.structuredVariants,
      axisLabel: input.variationAxisLabel,
      brief: input.brief,
    })
    : undefined
  const request = structured && structured.kind !== 'none' ? structured : resolveBotanicAgentVariationRequest({
    instruction: input.instruction || plan.instruction,
    requestedIntent: input.requestedIntent ?? plan.intent,
    clarificationAnswers: input.clarificationAnswers,
    brief: input.brief,
    assetGroup: input.assetGroup,
  })
  if (request.kind === 'none') return { kind: 'plan', plan }
  if (request.kind === 'asset_group') {
    if (plan.output.mode === 'batch_by_asset' && plan.assetGroupId === request.groupId) return { kind: 'plan', plan }
    return {
      kind: 'plan',
      plan: {
        ...plan,
        output: { mode: 'batch_by_asset', count: request.count, candidatesPerItem: 1 },
        assetGroupId: request.groupId,
      },
    }
  }
  if (request.kind === 'ask') return { kind: 'clarification', clarification: request.clarification }
  const branches = expandBotanicAgentVariationBranches(request.spec)
  const count = variationCount(request.spec)
  const axis = request.spec.axes[0]
  return {
    kind: 'plan',
    plan: {
      ...plan,
      intent: plan.intent === 'initial_generation' ? 'initial_generation' : 'batch_variation',
      prompt: botanicAgentSharedVariationPrompt(plan.prompt, plan.instruction, request.spec, input.fallbackPrompt),
      summary: request.spec.combine && request.spec.axes.length > 1
        ? `按「${request.spec.axes.map((item) => item.label).join('×')}」生成 ${count} 张。`
        : `按「${axis.label}」生成 ${count} 张。`,
      title: clipBotanicAgentNodeTitle(`${axis.label}变体`) || '变体',
      constraints: varyConstraintForAxis(axis),
      output: { mode: 'batch_by_variation', count: branches.length, candidatesPerItem: 1 },
      variation: request.spec,
      assetGroupId: undefined,
    },
  }
}

export function mergeVariationClarification(clarification, input) {
  const needed = resolveBotanicAgentVariationRequest({
    instruction: input.instruction,
    requestedIntent: input.requestedIntent,
    clarificationAnswers: input.clarificationAnswers,
    assetGroup: input.assetGroup,
  })
  if (needed.kind !== 'ask' || !clarification || !Array.isArray(clarification.fields)) return clarification
  const existing = new Set(clarification.fields.map((field) => field.id))
  if (existing.has('variation_values') || existing.has('variation_combine')) return clarification
  return {
    ...clarification,
    question: needed.clarification.question,
    helper: needed.clarification.helper ?? clarification.helper,
    fields: [...needed.clarification.fields, ...clarification.fields].slice(0, 3),
  }
}
