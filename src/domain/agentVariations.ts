import type {
  BotanicAgentClarification,
  BotanicAgentIntent,
  BotanicAgentPlan,
  CreativeConstraint,
  CreativeDimension,
} from './agent.ts'
import {
  botanicAgentLooksLikePlannerNarration,
  botanicAgentVisualGenerationPrompt,
  clipBotanicAgentNodeTitle,
  instructionRequestsBatchVariation,
  resolveBotanicAgentIntent,
} from './agent.ts'

export { instructionRequestsBatchVariation }

export const botanicAgentVariationBranchLimit = 20
export const botanicAgentVariationValueMin = 2
export const botanicAgentVariationValueMax = 8

export type BotanicAgentVariationValue = {
  label: string
  promptDelta: string
}

export type BotanicAgentVariationAxis = {
  key: string
  label: string
  values: BotanicAgentVariationValue[]
}

export type BotanicAgentVariationSpec = {
  axes: BotanicAgentVariationAxis[]
  combine: boolean
}

export type BotanicAgentBranchVariation = {
  label: string
  promptDelta: string
  values: Array<{ key: string; axisLabel: string; valueLabel: string }>
}

export const botanicAgentVariationClarificationFieldIds = ['variation_values', 'variation_combine'] as const
export type BotanicAgentVariationClarificationFieldId = typeof botanicAgentVariationClarificationFieldIds[number]

type VariationAxisCatalogItem = {
  key: string
  label: string
  names: string[]
  promptDelta: (value: string) => string
}

const axisCatalog: VariationAxisCatalogItem[] = [
  { key: 'skin_tone', label: '肤色', names: ['肤色', '皮肤色', '肤质色'], promptDelta: (value) => `人物肤色为${value}，保持五官与身份不变。` },
  { key: 'scene', label: '场景', names: ['场景', '背景'], promptDelta: (value) => `场景替换为${value}，保持人物、服装与商品不变。` },
  { key: 'pose', label: '动作', names: ['动作', '姿势', '姿态'], promptDelta: (value) => `动作调整为${value}，保持人物身份与服装不变。` },
  { key: 'style', label: '风格', names: ['风格', '调性'], promptDelta: (value) => `视觉风格调整为${value}，保持人物、服装与商品不变。` },
  { key: 'person', label: '人物', names: ['人物', '模特'], promptDelta: (value) => `人物替换为${value}，保持服装、商品与场景不变。` },
  { key: 'garment', label: '服装', names: ['服装', '衣服', '球衣'], promptDelta: (value) => `服装替换为${value}，保持人物身份与场景不变。` },
]

const axisNameValues = new Set([
  '人物', '模特', '角色', '场景', '背景', '画面', '环境',
  '肤色', '动作', '姿势', '姿态', '风格', '调性', '服装', '衣服', '穿搭', '球衣',
])
const valueJunkPattern = /^(?:各种|多种|一些|任意|几个|多图|多张|变体|版本|图片|生成|层次|细节|道具|质感|细腻|更细腻|档位|字段|推荐值|说明|选项)$/u
const combineLanguagePattern = /组合|相乘|交叉|笛卡尔|[×x]\s*\d|全部组合|逐一组合/u
const chineseCountByToken: Record<string, number> = {
  两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const groupRoleByKey: Record<string, string> = {
  scene: '场景', person: '模特', garment: '商品', style: '调性',
}

function isUsableVariationValue(label: string) {
  if (!label || Array.from(label).length > 8) return false
  if (axisNameValues.has(label) || valueJunkPattern.test(label)) return false
  if (/[更最]/.test(label) || /(?:层次|细节|道具)$/u.test(label)) return false
  return true
}

function uniqueLabels(values: string[]) {
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const label = clipBotanicAgentNodeTitle(value)
    if (!isUsableVariationValue(label) || seen.has(label)) return []
    seen.add(label)
    return [label]
  }).slice(0, botanicAgentVariationValueMax)
}

function splitValueList(raw: string) {
  return uniqueLabels(raw.split(/[、，,;/＋+|]/u).flatMap((item) => {
    const chunk = item
      .replace(/(?:等)?\s*(?:\d+|两|三|四|五|六|七|八|九|十)\s*(?:种|个|档).*$/u, '')
      .replace(/^(?:分别是|分别|包括)/u, '')
      .replace(/^(?:换成|换为|替换为|改为|改成|使用|用)/u, '')
      .trim()
    if (/不变|保持/.test(chunk)) return []
    const parts = chunk.split(/(?:(?<=\S)和(?=\S))/u).map((part) => part.trim()).filter(Boolean)
    if (parts.length === 2 && parts.every((part) => Array.from(part).length <= 8)) return parts
    return chunk ? [chunk] : []
  }))
}

function parseCountToken(token: string) {
  if (chineseCountByToken[token] != null) return chineseCountByToken[token]
  const count = Number(token)
  return Number.isInteger(count) && count >= 2 && count <= botanicAgentVariationBranchLimit ? count : null
}

function statedAxisCount(text: string, names: string[]) {
  for (const name of names) {
    const patterns = [
      new RegExp(`(\\d+|两|二|三|四|五|六|七|八|九|十)\\s*(?:种|个|档)${name}`, 'u'),
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

function axisCountMismatch(axis: BotanicAgentVariationAxis, instruction: string) {
  if (axis.values.length < botanicAgentVariationValueMin) return false
  const item = axisCatalog.find((entry) => entry.key === axis.key)
  const count = statedAxisCount(instruction, item ? [item.label, ...item.names] : [axis.label])
  return count != null && axis.values.length !== count
}

function listedValuesFromText(text: string) {
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

function extractEnumeration(text: string, label: string) {
  const index = text.lastIndexOf(label)
  if (index < 0) return []
  let before = text.slice(0, index)
  for (const other of axisCatalog.flatMap((item) => item.names)) {
    if (other === label) continue
    const otherIndex = before.lastIndexOf(other)
    if (otherIndex >= 0) before = before.slice(otherIndex + other.length)
  }
  before = before.replace(/^[，,、。；:\s]+/u, '')
  const after = text.slice(index + label.length).split(/[。；\n]/u)[0]
    .replace(/^[为是用：:\s]+/u, '')
  const fromAfter = listedValuesFromText(after)
  const fromBefore = listedValuesFromText(before)
  if (after.includes('|') && fromAfter.length) return fromAfter
  if (fromBefore.length) return fromBefore
  return fromAfter
}

function axisFromCatalog(item: VariationAxisCatalogItem, values: string[]): BotanicAgentVariationAxis {
  return {
    key: item.key,
    label: item.label,
    values: values.map((label) => ({ label, promptDelta: item.promptDelta(label) })),
  }
}

function customAxis(values: string[]): BotanicAgentVariationAxis {
  return {
    key: 'custom',
    label: '变体',
    values: values.map((label) => ({
      label,
      promptDelta: `画面按「${label}」这一变体调整，其余主体保持不变。`,
    })),
  }
}

function parseAxes(instruction: string): BotanicAgentVariationAxis[] {
  const text = instruction.trim()
  const found: BotanicAgentVariationAxis[] = []
  const seen = new Set<string>()
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
    const values = extractEnumeration(text, item.label)
    if (seen.has(item.key)) continue
    if (values.length < botanicAgentVariationValueMin && !instructionRequestsBatchVariation(text)) continue
    seen.add(item.key)
    found.push(axisFromCatalog(item, values))
  }
  return found
}

function fillAxisValues(axes: BotanicAgentVariationAxis[], answers?: Record<string, string>) {
  const listed = splitValueList(answers?.variation_values ?? '')
  if (!listed.length) return axes
  const incomplete = axes.find((axis) => axis.values.length < botanicAgentVariationValueMin)
  if (incomplete) {
    const catalog = axisCatalog.find((item) => item.key === incomplete.key)
    return axes.map((axis) => axis.key === incomplete.key && catalog
      ? axisFromCatalog(catalog, listed)
      : axis)
  }
  if (!axes.length) {
    const skin = axisCatalog[0]
    const looksLikeSkin = listed.every((label) => /白|麦|棕|黑|冷|暖|自然|健康/.test(label))
    return [looksLikeSkin ? axisFromCatalog(skin, listed) : customAxis(listed)]
  }
  return axes
}

export function expandBotanicAgentVariationBranches(spec: BotanicAgentVariationSpec): BotanicAgentBranchVariation[] {
  const ready = spec.axes.filter((axis) => axis.values.length >= botanicAgentVariationValueMin
    && axis.values.length <= botanicAgentVariationValueMax)
  if (!ready.length) return []
  const selected = spec.combine && ready.length > 1 ? ready : [ready[0]]
  const combos = selected.reduce<Array<Array<{ axis: BotanicAgentVariationAxis; value: BotanicAgentVariationValue }>>>(
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

function variationCount(spec: BotanicAgentVariationSpec) {
  const ready = spec.axes.filter((axis) => axis.values.length >= botanicAgentVariationValueMin)
  if (!ready.length) return 0
  if (!spec.combine) return ready[0].values.length
  return ready.reduce((total, axis) => total * axis.values.length, 1)
}

function createVariationClarification(input: {
  question: string
  helper?: string
  instruction: string
  fields: BotanicAgentClarification['fields']
}): BotanicAgentClarification {
  return {
    id: 'clarification-variation',
    question: input.question,
    helper: input.helper ?? '取值需要具体到 2–8 个短词；张数由展开结果决定，不会立即生成。',
    originalInstruction: input.instruction,
    fields: input.fields,
  }
}

function valuesField(axisLabel: string): BotanicAgentClarification['fields'][number] {
  return {
    id: 'variation_values',
    label: `${axisLabel}取值`,
    required: true,
    control: 'text',
    placeholder: axisLabel === '肤色' ? '例如：白皙、自然、小麦、深棕' : `例如：列出 2 到 8 个${axisLabel}`,
    options: [],
  }
}

function combineField(first: BotanicAgentVariationAxis, second: BotanicAgentVariationAxis, product: number) {
  return {
    id: 'variation_combine' as const,
    label: '是否组合',
    required: true,
    control: 'single_choice' as const,
    defaultValue: 'first',
    options: [
      { value: 'first', label: `只做${first.label} ${first.values.length} 张`, description: '默认只拆一条轴' },
      { value: 'combine', label: `组合 ${product} 张`, description: `${first.label}×${second.label}` },
    ],
  }
}

export type BotanicAgentVariationRequestInput = {
  instruction: string
  requestedIntent?: BotanicAgentIntent
  clarificationAnswers?: Record<string, string>
  assetGroup?: { id: string; role?: string; assetCount: number }
}

export type BotanicAgentVariationRequest =
  | { kind: 'none' }
  | { kind: 'asset_group'; groupId: string; count: number }
  | { kind: 'ask'; clarification: BotanicAgentClarification }
  | { kind: 'ready'; spec: BotanicAgentVariationSpec }

export function resolveBotanicAgentVariationRequest(input: BotanicAgentVariationRequestInput): BotanicAgentVariationRequest {
  const instruction = input.instruction.trim()
  const intent = resolveBotanicAgentIntent(instruction, input.requestedIntent)
  const axes = fillAxisValues(parseAxes(instruction), input.clarificationAnswers)
  const wantsBatch = instructionRequestsBatchVariation(instruction) || intent === 'batch_variation' || axes.some((axis) => axis.values.length >= botanicAgentVariationValueMin)
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
          question: `组合后共 ${product} 张，超过单次 ${botanicAgentVariationBranchLimit} 张上限。请只拆一条轴，或减少取值。`,
          fields: [combineField(readyAxes[0], readyAxes[1], Math.min(product, botanicAgentVariationBranchLimit))],
        }),
      }
    }
    return { kind: 'ready', spec: { axes: readyAxes, combine: true } }
  }

  if (incomplete && readyAxes.length < 1) {
    return {
      kind: 'ask',
      clarification: createVariationClarification({
        instruction,
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
        question: '这次要按哪一个维度出多张？请列出 2 到 8 个具体取值。',
        fields: [valuesField('变体')],
      }),
    }
  }

  return { kind: 'ready', spec: { axes: readyAxes.length > 1 ? readyAxes : readyAxes, combine: false } }
}

function stripVariationInventory(text: string, spec?: BotanicAgentVariationSpec) {
  let next = text
  const lists = spec?.axes.flatMap((axis) => {
    const joined = axis.values.map((value) => value.label).join('、')
    return joined ? [joined] : []
  }) ?? []
  for (const list of lists) next = next.replace(list, '')
  next = next
    .replace(/(?:[\u4e00-\u9fffA-Za-z0-9]{1,8}[、，,]){1,7}[\u4e00-\u9fffA-Za-z0-9]{1,8}\s*(?:等)?\s*(?:\d+|两|三|四|五|六|七|八|九|十)种?[。]?/gu, '')
    .replace(/(?:多图|多张|多出几张|多种|几个|各种)/gu, '')
    .replace(/(?:两|三|四|五|六|七|八|九|十|\d+)种(?:肤色|场景|动作|风格|人物|服装|变体)?/gu, '')
    .replace(/[、，,\s]{2,}/gu, '，')
    .replace(/^[、，\s]+|[、，\s]+$/gu, '')
    .replace(/，+。/gu, '。')
    .trim()
  return next
}

export function botanicAgentSharedVariationPrompt(prompt: string, instruction: string, spec?: BotanicAgentVariationSpec) {
  const cleaned = botanicAgentVisualGenerationPrompt(prompt, '')
  const source = !cleaned || botanicAgentLooksLikePlannerNarration(cleaned)
    ? botanicAgentVisualGenerationPrompt(instruction, '')
    : cleaned
  const stripped = stripVariationInventory(source, spec)
  if (stripped && !botanicAgentLooksLikePlannerNarration(stripped)) return stripped
  return '保持人物身份、服装与商品不变，仅按变体说明调整画面。'
}

export function botanicAgentBranchGenerationPrompt(prompt: string, promptDelta?: string, fallback = '') {
  const base = botanicAgentVisualGenerationPrompt(prompt, fallback)
  const delta = promptDelta?.trim()
  return delta ? `${base}\n\n${delta}` : base
}

export function botanicAgentPlanOutputLabel(plan: Pick<BotanicAgentPlan, 'output'>) {
  if (plan.output.mode === 'single' && plan.output.count <= 1) return '1 个版本'
  if (plan.output.mode === 'single') return `${plan.output.count} 个版本`
  return `${plan.output.count} 个分支`
}

export type BotanicAgentConfirmBranchDraft = {
  label: string
  assetId?: string
  variation?: BotanicAgentBranchVariation
}

export function botanicAgentConfirmBranchDrafts(
  plan: Pick<BotanicAgentPlan, 'output' | 'title' | 'intent' | 'constraints' | 'variation'>,
  options: { group?: { assetIds: string[]; names: string[] } } = {},
): BotanicAgentConfirmBranchDraft[] {
  const group = options?.group
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

type VariationPlanDraft = Pick<BotanicAgentPlan, 'intent' | 'instruction' | 'summary' | 'prompt' | 'constraints' | 'output'> & {
  title?: string
  assetGroupId?: string
  variation?: BotanicAgentVariationSpec
}

function varyConstraintForAxis(axis: BotanicAgentVariationAxis): CreativeConstraint[] {
  const dimension: CreativeDimension | undefined = axis.key === 'skin_tone'
    ? undefined
    : axis.key === 'custom'
      ? 'style'
      : axisCatalog.some((item) => item.key === axis.key)
        ? axis.key as CreativeDimension
        : 'style'
  if (axis.key === 'skin_tone') {
    return [
      { dimension: 'person', mode: 'preserve' },
      { dimension: 'garment', mode: 'preserve' },
      { dimension: 'product', mode: 'preserve' },
      { dimension: 'scene', mode: 'preserve' },
      { dimension: 'style', mode: 'vary' },
    ]
  }
  const preserve: CreativeDimension[] = ['person', 'garment', 'product', 'scene', 'style', 'pose']
  return preserve.map((item) => ({
    dimension: item,
    mode: item === dimension ? 'vary' : 'preserve',
  }))
}

export function applyBotanicAgentVariationToPlan(
  plan: VariationPlanDraft,
  input: BotanicAgentVariationRequestInput,
): { kind: 'plan'; plan: VariationPlanDraft } | { kind: 'clarification'; clarification: BotanicAgentClarification } {
  const request = resolveBotanicAgentVariationRequest({
    instruction: input.instruction || plan.instruction,
    requestedIntent: input.requestedIntent ?? plan.intent,
    clarificationAnswers: input.clarificationAnswers,
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
      intent: 'batch_variation',
      prompt: botanicAgentSharedVariationPrompt(plan.prompt, plan.instruction, request.spec),
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
