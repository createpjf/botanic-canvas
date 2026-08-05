import type { Edge, XYPosition } from '@xyflow/react'
import { normalizeAssetCollection, normalizeAssetRecord } from '../domain/assets.ts'
import { normalizeAssetGroups } from '../domain/assetGroups.ts'
import { createBotanicAgentMemoryItem, type BotanicAgentRun } from '../domain/agent.ts'
import {
  clampBatchCount,
  cloneGenerationRecipe,
  cloneGenerationSettings,
  normalizeGenerateNodeInputs,
} from '../domain/generationRecipe.ts'
import type {
  AssetNodeData,
  CanvasDocument,
  CanvasNode,
  CanvasSnapshot,
  GenerationJob,
  GenerationReference,
  GenerationRecipe,
  GenerationSettings,
  GenerateNodeData,
  PromptNodeData,
  ReferenceGroupNodeData,
  ResultNodeData,
  TextNodeData,
} from '../domain/canvas.ts'
import {
  cloneEdges,
  cloneNodes,
  normalizeSystemOutputEdges,
  workflowTemplateSnapshotFromSnapshot,
} from './canvasDocumentAssets.ts'

function removeLegacyMockCopy(value: string | undefined) {
  if (!value) return value
  const cleaned = value
    .replace(/\s*[·•|｜]\s*mock\s*(?:生成|生图|出图|任务)?/gi, '')
    .replace(/\bmock\s*(?:生成|生图|出图|任务)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned
}

export function cleanDisplayName(value: string | undefined, fallback: string) {
  return removeLegacyMockCopy(value) || fallback
}

function cleanGenerateNodeLabel(value: string | undefined) {
  const label = cleanDisplayName(value, '图像生成')
  // 将旧版本的通用名称统一迁移，避免分支与独立生成都被误称为“首图”。
  return label === '首图生成' ? '图像生成' : label
}

export function canvasNodeDisplayName(node: CanvasNode) {
  if (node.type === 'asset') return (node.data as AssetNodeData).name
  if (node.type === 'text') return (node.data as TextNodeData).label
  if (node.type === 'generate') return (node.data as GenerateNodeData).label
  if (node.type === 'prompt') return (node.data as PromptNodeData).label
  if (node.type === 'reference') return (node.data as ReferenceGroupNodeData).label
  return (node.data as ResultNodeData).label ?? '输出图片'
}

function cleanAssetTags(tags: string[] | undefined) {
  const seen = new Set<string>()
  return (Array.isArray(tags) ? tags : []).flatMap((tag) => {
    const cleaned = removeLegacyMockCopy(tag)
    if (!cleaned || seen.has(cleaned)) return []
    seen.add(cleaned)
    return [cleaned]
  })
}

function normalizeGenerationRecipeCopy(recipe: GenerationRecipe): GenerationRecipe {
  return {
    ...cloneGenerationRecipe(recipe),
    references: recipe.references.map((reference) => ({
      ...reference,
      name: cleanDisplayName(reference.name, '未命名素材'),
    })),
  }
}

function normalizeLegacyCopyNodes(nodes: CanvasNode[]): CanvasNode[] {
  return cloneNodes(nodes).map((node) => {
    if (node.type === 'asset') {
      const data = node.data as AssetNodeData
      return { ...node, data: { ...data, name: cleanDisplayName(data.name, '未命名素材') } }
    }
    if (node.type === 'text') {
      const data = node.data as TextNodeData
      return { ...node, data: { ...data, label: cleanDisplayName(data.label, '生成描述') } }
    }
    if (node.type === 'generate') {
      const data = node.data as GenerateNodeData
      return { ...node, data: { ...data, label: cleanGenerateNodeLabel(data.label) } }
    }
    if (node.type === 'prompt') {
      const data = node.data as PromptNodeData
      return {
        ...node,
        data: {
          ...data,
          label: cleanDisplayName(data.label, data.generationKind === 'refinement' ? '定向精修指令' : '视觉目标'),
        },
      }
    }
    if (node.type === 'reference') {
      const data = node.data as ReferenceGroupNodeData
      return {
        ...node,
        data: {
          ...data,
          label: cleanDisplayName(data.label, '本次参考'),
          recipe: normalizeGenerationRecipeCopy(data.recipe),
        },
      }
    }
    const data = node.data as ResultNodeData
    const generationRecipe = data.generationRecipe ? normalizeGenerationRecipeCopy(data.generationRecipe) : undefined
    const rootRecipe = data.rootRecipe
      ? normalizeGenerationRecipeCopy(data.rootRecipe)
      : generationRecipe
        ? cloneGenerationRecipe(generationRecipe)
        : undefined
    return {
      ...node,
      data: {
        ...data,
        label: data.label ? cleanDisplayName(data.label, data.generationKind === 'refinement' ? '定向精修结果' : '首图结果') : data.label,
        generationRecipe,
        rootRecipe,
      },
    }
  }) as CanvasNode[]
}

function withoutAsset(snapshotValue: CanvasSnapshot, assetId: string): CanvasSnapshot {
  const filteredNodes = snapshotValue.nodes.filter((node) => node.type !== 'asset' || (node.data as AssetNodeData).assetId !== assetId)
  const nodeIds = new Set(filteredNodes.map((node) => node.id))
  const edges = cloneEdges(snapshotValue.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)))
  return {
    ...snapshotValue,
    nodes: normalizeGenerateNodeInputs(cloneNodes(filteredNodes), edges),
    edges,
  }
}

export function normalizeAssetReferenceNodes(nodes: CanvasNode[]): CanvasNode[] {
  let primaryAssigned = false
  let normalized = cloneNodes(nodes).map((node, index) => {
    if (node.type !== 'asset') return node
    const asset = node.data as AssetNodeData
    const enabled = asset.referenceEnabled !== false
    const primary = enabled && asset.role === '商品' && Boolean(asset.primary) && !primaryAssigned
    if (primary) primaryAssigned = true
    return {
      ...node,
      data: {
        ...asset,
        mediaKind: asset.mediaKind ?? 'image',
        referenceEnabled: enabled,
        primary,
        referencePriority: Number.isInteger(asset.referencePriority) && asset.referencePriority! > 0
          ? asset.referencePriority
          : index + 1,
      },
    }
  }) as CanvasNode[]

  const hasPrimaryProduct = normalized.some((node) => node.type === 'asset'
    && (node.data as AssetNodeData).role === '商品'
    && (node.data as AssetNodeData).referenceEnabled !== false
    && Boolean((node.data as AssetNodeData).primary))

  if (!hasPrimaryProduct) {
    const firstEnabledProduct = normalized.find((node) => node.type === 'asset'
      && (node.data as AssetNodeData).role === '商品'
      && (node.data as AssetNodeData).referenceEnabled !== false)
    if (firstEnabledProduct?.type === 'asset') {
      normalized = normalized.map((node) => node.id === firstEnabledProduct.id
        ? { ...node, data: { ...(node.data as AssetNodeData), primary: true } }
        : node) as CanvasNode[]
    }
  }

  const ordered = normalized
    .flatMap((node, index) => node.type === 'asset' && (node.data as AssetNodeData).referenceEnabled !== false
      ? [{ node, index, asset: node.data as AssetNodeData }]
      : [])
    .sort((left, right) => {
      if (left.asset.primary !== right.asset.primary) return left.asset.primary ? -1 : 1
      if ((left.asset.referencePriority ?? left.index + 1) !== (right.asset.referencePriority ?? right.index + 1)) {
        return (left.asset.referencePriority ?? left.index + 1) - (right.asset.referencePriority ?? right.index + 1)
      }
      return left.index - right.index
    })
  const priorityById = new Map(ordered.map((item, index) => [item.node.id, index + 1]))

  return normalized.map((node) => node.type === 'asset'
    ? { ...node, data: { ...(node.data as AssetNodeData), referencePriority: priorityById.get(node.id) ?? (node.data as AssetNodeData).referencePriority } }
    : node) as CanvasNode[]
}

function nodeVisualWidth(node: CanvasNode) {
  if (node.type === 'asset') return 176
  if (node.type === 'result') return 300
  if (node.type === 'generate') return 286
  if (node.type === 'text') return 236
  return 252
}

function taskFlowKey(node: CanvasNode) {
  return node.id.match(/^(?:prompt|reference|result)-task-(.+)$/)?.[1]
}

export function nextTaskFlowStartX(nodes: CanvasNode[]) {
  return Math.max(720, ...nodes.map((node) => node.position.x + nodeVisualWidth(node) + 72))
}

function layoutTaskFlowNodes(nodes: CanvasNode[]): CanvasNode[] {
  const cloned = cloneNodes(nodes)
  const groups = new Map<string, CanvasNode[]>()
  const nonTaskNodes: CanvasNode[] = []

  for (const node of cloned) {
    const key = taskFlowKey(node)
    if (!key) {
      nonTaskNodes.push(node)
      continue
    }
    groups.set(key, [...(groups.get(key) ?? []), node])
  }

  let nextX = nextTaskFlowStartX(nonTaskNodes)
  const positions = new Map<string, XYPosition>()
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => Number(left) - Number(right))
  for (const [, nodesInTask] of orderedGroups) {
    for (const node of nodesInTask) {
      if (node.type === 'prompt') positions.set(node.id, { x: nextX, y: 90 })
      if (node.type === 'reference') positions.set(node.id, { x: nextX, y: 240 })
      if (node.type === 'result') positions.set(node.id, { x: nextX + 300, y: 168 })
    }
    nextX += 680
  }

  return cloned.map((node) => {
    const position = positions.get(node.id)
    return position ? { ...node, position } : node
  }) as CanvasNode[]
}

/**
 * V16 的示例首图沿用了早期紧凑坐标；在实际节点尺寸下会让四张参考图
 * 视觉上贴在一起。仅迁移这组固定的默认节点，不改用户后来手动摆放的节点。
 */
function layoutStarterV03Nodes(nodes: CanvasNode[]): CanvasNode[] {
  const requiredIds = ['asset-product', 'asset-scene', 'asset-model', 'asset-tone', 'text-v03', 'generate-v03', 'result-hero']
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (!requiredIds.every((id) => nodeIds.has(id))) return cloneNodes(nodes)

  const positions: Record<string, XYPosition> = {
    'asset-product': { x: 120, y: 210 },
    'asset-scene': { x: 470, y: 210 },
    'asset-model': { x: 120, y: 560 },
    'asset-tone': { x: 470, y: 560 },
    'text-v03': { x: 860, y: 86 },
    'generate-v03': { x: 860, y: 310 },
    'result-hero': { x: 1330, y: 225 },
  }

  return cloneNodes(nodes).map((node) => positions[node.id]
    ? { ...node, position: positions[node.id] }
    : node) as CanvasNode[]
}

export function hasCrampedStarterV03Layout(nodes: CanvasNode[]) {
  const legacyPositions: Record<string, XYPosition> = {
    'asset-product': { x: 290, y: 225 },
    'asset-scene': { x: 490, y: 225 },
    'asset-model': { x: 290, y: 485 },
    'asset-tone': { x: 490, y: 485 },
    'text-v03': { x: 700, y: 86 },
    'generate-v03': { x: 700, y: 282 },
    'result-hero': { x: 1070, y: 210 },
  }
  return Object.entries(legacyPositions).every(([id, position]) => {
    const node = nodes.find((item) => item.id === id)
    return Boolean(node && Math.abs(node.position.x - position.x) < 8 && Math.abs(node.position.y - position.y) < 8)
  })
}

function fallbackGenerationRecipe(nodes: CanvasNode[], prompt: string, settings?: Partial<GenerationSettings>, batchCount = 1): GenerationRecipe {
  const references = nodes.flatMap((node, index): GenerationReference[] => {
    if (node.type !== 'asset') return []
    const asset = node.data as AssetNodeData
    return [{
      nodeId: node.id,
      assetId: asset.assetId,
      name: asset.name,
      image: asset.image,
      role: asset.role,
      source: asset.source,
      priority: index + 1,
    }]
  })
  const primary = references.find((reference) => {
    const node = nodes.find((item) => item.id === reference.nodeId && item.type === 'asset')
    return node?.type === 'asset' && (node.data as AssetNodeData).role === '商品' && Boolean((node.data as AssetNodeData).primary)
  }) ?? references.find((reference) => reference.role === '商品')
  return {
    primaryReferenceNodeId: primary?.nodeId,
    references: references.map((reference, index) => ({
      ...reference,
      primary: reference.nodeId === primary?.nodeId,
      priority: index + 1,
    })),
    prompt,
    batchCount: clampBatchCount(batchCount),
    settings: cloneGenerationSettings(settings),
  }
}

export function migrationId(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  const id = `${base}-${suffix}`
  used.add(id)
  return id
}

function migrationEdgeId(base: string, edges: Edge[]) {
  const used = new Set(edges.map((edge) => edge.id))
  return migrationId(base, used)
}

function resultGenerationStatus(result: ResultNodeData): GenerateNodeData['status'] {
  if (result.status === 'ready') return 'succeeded'
  if (result.status === 'failed') return 'failed'
  if (result.status === 'cancelled') return 'cancelled'
  return 'running'
}

export function migrationInputEdge(
  id: string,
  source: string,
  target: string,
  style: Edge['style'] = { stroke: '#b6cfbd', strokeWidth: 1.3 },
  sourceHandle = 'output',
): Edge {
  return {
    id,
    source,
    sourceHandle,
    target,
    targetHandle: 'input',
    type: 'default',
    style,
  }
}

/** 将 V0.6 的 Prompt → Reference → Result 和更早的素材直连结果，收敛成可编辑图谱。 */
function migrateLegacyWorkflowSnapshot(snapshotValue: CanvasSnapshot): CanvasSnapshot {
  let nodes = cloneNodes(snapshotValue.nodes)
  let edges: Edge[] = cloneEdges(snapshotValue.edges)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const defaultPrompt = '夏日植物与白瓷台面，柔和自然光，顶部留出标题区'

  const taskKeys = [...new Set(nodes
    .filter((node) => node.type === 'prompt' && node.id.startsWith('prompt-task-'))
    .map((node) => node.id.replace('prompt-task-', '')))]

  for (const key of taskKeys) {
    const promptNode = nodes.find((node) => node.id === `prompt-task-${key}` && node.type === 'prompt')
    const referenceNode = nodes.find((node) => node.id === `reference-task-${key}` && node.type === 'reference')
    const resultNode = nodes.find((node) => node.id === `result-task-${key}` && node.type === 'result')
    if (!promptNode || !resultNode) continue

    const prompt = promptNode.data as PromptNodeData
    const reference = referenceNode?.type === 'reference' ? referenceNode.data as ReferenceGroupNodeData : undefined
    const result = resultNode.data as ResultNodeData
    const promptText = prompt.prompt.trim() || reference?.recipe.prompt.trim() || defaultPrompt
    const recipe = cloneGenerationRecipe({
      ...(reference?.recipe ?? result.generationRecipe ?? fallbackGenerationRecipe(nodes, promptText, prompt.settings, prompt.batchCount)),
      prompt: promptText,
      batchCount: clampBatchCount(prompt.batchCount ?? reference?.recipe.batchCount ?? 1),
      settings: cloneGenerationSettings(prompt.settings ?? reference?.recipe.settings ?? result.generationSettings),
    })
    const textNodeId = migrationId(`text-task-${key}`, nodeIds)
    const generateNodeId = migrationId(`generate-task-${key}`, nodeIds)
    const removedIds = new Set([promptNode.id, referenceNode?.id].filter(Boolean) as string[])
    const externalInputs = edges.filter((edge) => removedIds.has(edge.target) && !removedIds.has(edge.source))
    edges = edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target))

    nodes = nodes
      .filter((node) => !removedIds.has(node.id))
      .map((node) => node.id === resultNode.id
        ? {
            ...node,
            data: {
              ...(node.data as ResultNodeData),
              generationKind: prompt.generationKind ?? result.generationKind ?? 'generation',
              generationSettings: cloneGenerationSettings(recipe.settings),
              generationRecipe: cloneGenerationRecipe(recipe),
            },
          }
        : node) as CanvasNode[]

    nodes.push(
      {
        id: textNodeId,
        type: 'text',
        position: { ...promptNode.position },
        draggable: true,
        data: { kind: 'text', label: prompt.label || '生成描述', content: promptText },
      },
      {
        id: generateNodeId,
        type: 'generate',
        position: { ...(referenceNode?.position ?? { x: promptNode.position.x + 286, y: promptNode.position.y + 56 }) },
        draggable: true,
        data: {
          kind: 'generate',
          label: prompt.generationKind === 'refinement' ? '定向精修' : '图像生成',
          prompt: '',
          batchCount: recipe.batchCount,
          settings: cloneGenerationSettings(recipe.settings),
          status: prompt.status,
          generationKind: prompt.generationKind,
          jobId: prompt.jobId,
          error: prompt.error,
        },
      },
    )

    const addEdge = (edge: Edge) => {
      if (edges.some((item) => item.source === edge.source && item.target === edge.target)) return
      edges.push({ ...edge, id: migrationEdgeId(edge.id, edges) })
    }
    for (const edge of externalInputs) {
      const source = nodes.find((node) => node.id === edge.source)
      if (!source) continue
      addEdge(migrationInputEdge(`task-parent-generate-${key}`, source.id, generateNodeId, source.type === 'result'
        ? { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' }
        : { stroke: '#b6cfbd', strokeWidth: 1.3 }, source.type === 'asset' ? 'asset-output' : 'output'))
    }
    for (const item of recipe.references) {
      if (!nodes.some((node) => node.id === item.nodeId && node.type === 'asset')) continue
      addEdge(migrationInputEdge(`task-asset-generate-${key}-${item.nodeId}`, item.nodeId, generateNodeId, undefined, 'asset-output'))
    }
    addEdge(migrationInputEdge(`task-text-generate-${key}`, textNodeId, generateNodeId))
    addEdge({
      id: `task-generate-result-${key}`,
      source: generateNodeId,
      sourceHandle: 'output',
      target: resultNode.id,
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
    })
  }

  const results = nodes.filter((node) => node.type === 'result')
  for (const resultNode of results) {
    const hasGenerateInput = edges.some((edge) => edge.target === resultNode.id
      && nodes.some((node) => node.id === edge.source && node.type === 'generate'))
    const directInputs = edges.filter((edge) => edge.target === resultNode.id
      && nodes.some((node) => node.id === edge.source && (node.type === 'asset' || node.type === 'text')))
    if (hasGenerateInput || !directInputs.length) continue

    const result = resultNode.data as ResultNodeData
    const inputText = directInputs
      .map((edge) => nodes.find((node) => node.id === edge.source && node.type === 'text'))
      .find((node): node is CanvasNode => Boolean(node))
    const textContent = inputText?.type === 'text'
      ? (inputText.data as TextNodeData).content.trim() || result.generationRecipe?.prompt || defaultPrompt
      : result.generationRecipe?.prompt || defaultPrompt
    const recipe = cloneGenerationRecipe(result.generationRecipe ?? fallbackGenerationRecipe(nodes, textContent, result.generationSettings))
    const generateNodeId = migrationId(resultNode.id === 'result-hero' ? 'generate-v03' : `generate-legacy-${resultNode.id}`, nodeIds)
    const needsText = !inputText
    const textNodeId = needsText
      ? migrationId(resultNode.id === 'result-hero' ? 'text-v03' : `text-legacy-${resultNode.id}`, nodeIds)
      : inputText!.id
    const originalPosition = { ...resultNode.position }

    nodes = nodes.map((node) => node.id === resultNode.id
      ? {
          ...node,
          position: { x: originalPosition.x + 370, y: originalPosition.y + 54 },
          data: {
            ...(node.data as ResultNodeData),
            generationKind: result.generationKind ?? 'generation',
            generationSettings: cloneGenerationSettings(recipe.settings),
            generationRecipe: cloneGenerationRecipe(recipe),
          },
        }
      : node) as CanvasNode[]
    if (needsText) {
      nodes.push({
        id: textNodeId,
        type: 'text',
        position: { x: originalPosition.x, y: originalPosition.y - 170 },
        draggable: true,
        data: { kind: 'text', label: '首图创意描述', content: textContent },
      })
    }
    nodes.push({
      id: generateNodeId,
      type: 'generate',
      position: { x: originalPosition.x, y: originalPosition.y + 34 },
      draggable: true,
      data: {
        kind: 'generate',
        label: result.generationKind === 'refinement' ? '定向精修' : '图像生成',
        prompt: '',
        batchCount: recipe.batchCount,
        settings: cloneGenerationSettings(recipe.settings),
        status: resultGenerationStatus(result),
        generationKind: result.generationKind ?? 'generation',
        jobId: result.jobId,
        error: result.error,
      },
    })
    edges = edges.map((edge) => directInputs.some((input) => input.id === edge.id)
      ? { ...edge, target: generateNodeId, targetHandle: 'input' }
      : edge)
    const addEdge = (edge: Edge) => {
      if (edges.some((item) => item.source === edge.source && item.target === edge.target)) return
      edges.push({ ...edge, id: migrationEdgeId(edge.id, edges) })
    }
    if (needsText) addEdge(migrationInputEdge(`legacy-text-generate-${resultNode.id}`, textNodeId, generateNodeId))
    addEdge({
      id: `legacy-generate-result-${resultNode.id}`,
      source: generateNodeId,
      sourceHandle: 'output',
      target: resultNode.id,
      type: 'default',
      style: { stroke: '#2a5238', strokeWidth: 1.7 },
    })
  }

  edges = edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (source?.type === 'asset' && target?.type === 'generate') {
      return { ...edge, sourceHandle: 'asset-output', targetHandle: 'input' }
    }
    if (source?.type === 'text' && target?.type === 'generate') {
      return { ...edge, sourceHandle: 'output', targetHandle: 'input' }
    }
    if (source?.type === 'result' && target?.type === 'generate') {
      return {
        ...edge,
        sourceHandle: 'output',
        targetHandle: 'input',
        style: { stroke: '#7e9785', strokeWidth: 1.2, strokeDasharray: '4 3' },
      }
    }
    if (source?.type === 'generate' && target?.type === 'result') {
      return { ...edge, sourceHandle: 'output', targetHandle: 'input' }
    }
    return edge
  })

  return {
    ...snapshotValue,
    nodes: normalizeAssetReferenceNodes(nodes),
    edges,
  }
}

function migrateGenerationJobs(jobs: GenerationJob[]) {
  return jobs.map((job) => {
    const key = job.promptNodeId?.match(/^prompt-task-(.+)$/)?.[1]
    if (!key) return {
      ...job,
      outputs: job.outputs?.map((output) => ({ ...output })),
      dismissedOutputIds: job.dismissedOutputIds ? [...job.dismissedOutputIds] : undefined,
    }
    const { promptNodeId: _promptNodeId, referenceNodeId: _referenceNodeId, ...rest } = job
    return {
      ...rest,
      generateNodeId: job.generateNodeId ?? `generate-task-${key}`,
      outputs: job.outputs?.map((output) => ({ ...output })),
      dismissedOutputIds: job.dismissedOutputIds ? [...job.dismissedOutputIds] : undefined,
    }
  })
}

function normalizeCanvasSnapshot(snapshotValue: CanvasSnapshot, layoutTaskNodes = false, migrateWorkflow = false): CanvasSnapshot {
  const normalizedNodes = normalizeLegacyCopyNodes(normalizeAssetReferenceNodes(snapshotValue.nodes))
  const normalized = {
    ...snapshotValue,
    name: cleanDisplayName(snapshotValue.name, '未命名画布'),
    nodes: layoutTaskNodes ? layoutTaskFlowNodes(normalizedNodes) : normalizedNodes,
    edges: cloneEdges(snapshotValue.edges),
    viewport: { ...snapshotValue.viewport },
  }
  const migrated = migrateWorkflow ? migrateLegacyWorkflowSnapshot(normalized) : normalized
  const nodes = normalizeGenerateNodeInputs(normalizeLegacyCopyNodes(migrated.nodes), migrated.edges)
  return {
    ...migrated,
    nodes,
    edges: normalizeSystemOutputEdges(nodes, migrated.edges),
  }
}

export function normalizeCanvasDocumentBase(stored: CanvasDocument | undefined, fallbackDocument: CanvasDocument): CanvasDocument {
  if (!stored) return fallbackDocument

  const legacy = stored as Partial<CanvasDocument>
  const needsTaskLayoutMigration = (legacy.schemaVersion ?? 0) < 8
  const needsWorkflowMigration = (legacy.schemaVersion ?? 0) < 12
  const needsTemplateBlueprintMigration = (legacy.schemaVersion ?? 0) < 14
  // 首批 V17 快照已经带上版本号，但仍保存了 V16 的紧凑示例坐标；用坐标兜底仅迁移这一组确定的默认节点。
  const needsStarterSpacingMigration = (legacy.schemaVersion ?? 0) < 17 || hasCrampedStarterV03Layout(legacy.nodes ?? [])
  const templates = (legacy.templates ?? fallbackDocument.templates).map((template) => {
    const normalizedSnapshot = normalizeCanvasSnapshot(template.snapshot, needsTaskLayoutMigration, needsWorkflowMigration)
    return {
    ...template,
    name: cleanDisplayName(template.name, '未命名模板'),
    snapshot: needsTemplateBlueprintMigration
      ? workflowTemplateSnapshotFromSnapshot(normalizedSnapshot, cleanDisplayName(template.name, '未命名模板'))
      : normalizedSnapshot,
  }
  })
  const history = (legacy.history ?? fallbackDocument.history).map((entry) => ({
    ...entry,
    name: cleanDisplayName(entry.name, '未命名版本'),
    generationRecipe: entry.generationRecipe ? normalizeGenerationRecipeCopy(entry.generationRecipe) : undefined,
    rootRecipe: entry.rootRecipe
      ? normalizeGenerationRecipeCopy(entry.rootRecipe)
      : entry.generationRecipe
        ? normalizeGenerationRecipeCopy(entry.generationRecipe)
        : undefined,
    snapshot: normalizeCanvasSnapshot(entry.snapshot, needsTaskLayoutMigration, needsWorkflowMigration),
  }))
  const normalizedRootSnapshot = normalizeCanvasSnapshot({
    name: legacy.name ?? fallbackDocument.name,
    nodes: legacy.nodes ?? fallbackDocument.nodes,
    edges: legacy.edges ?? fallbackDocument.edges,
    viewport: legacy.viewport ?? fallbackDocument.viewport,
  }, needsTaskLayoutMigration, needsWorkflowMigration)
  const rootSnapshot = needsStarterSpacingMigration
    ? {
        ...normalizedRootSnapshot,
        nodes: layoutStarterV03Nodes(normalizedRootSnapshot.nodes),
        // 同步清除旧画布的默认 100% 视角，让首次打开按完整图谱适配。
        viewport: { x: 0, y: 0, zoom: 1 },
    }
    : normalizedRootSnapshot
  // 任务的输出以服务端 generation_jobs 为准。不能因本地快照暂时缺 outputs
  // 就把成功任务改为失败，否则会抢在历史/实时回填前永久遮住真实图片。
  const reconciledResultNodes = rootSnapshot.nodes
  const generationJobs = migrateGenerationJobs(legacy.generationJobs ?? [])
  const document: CanvasDocument = {
    ...fallbackDocument,
    ...legacy,
    schemaVersion: 25,
    name: cleanDisplayName(legacy.name, fallbackDocument.name),
    viewport: rootSnapshot.viewport,
    nodes: reconciledResultNodes,
    edges: rootSnapshot.edges,
    // V16 起品牌素材存在全局库，CanvasDocument 仅保留项目上传/生成资产。
    assets: (legacy.assets ?? fallbackDocument.assets).filter((asset) => asset.source !== 'brand').map((asset) => {
      const matchingResult = reconciledResultNodes.find((node) => node.type === 'result'
        && (node.data as ResultNodeData).image === asset.image)
      return normalizeAssetRecord({
        ...asset,
        name: cleanDisplayName(asset.name, '未命名素材'),
        collection: normalizeAssetCollection(asset.collection),
        tags: cleanAssetTags(asset.tags),
      }, (matchingResult?.data as ResultNodeData | undefined)?.mediaKind)
    }),
    assetGroups: normalizeAssetGroups(legacy.assetGroups),
    templates,
    history,
    deliveries: (legacy.deliveries ?? fallbackDocument.deliveries).map((delivery) => ({
      ...delivery,
      targetLabel: cleanDisplayName(delivery.targetLabel, '已选首图'),
      title: removeLegacyMockCopy(delivery.title) ?? delivery.title,
      subtitle: removeLegacyMockCopy(delivery.subtitle) ?? delivery.subtitle,
    })),
    generationJobs,
    batchVariationRuns: (legacy.batchVariationRuns ?? []).map((run) => ({
      ...run,
      settings: cloneGenerationSettings(run.settings),
      items: Array.isArray(run.items) ? run.items.map((item) => ({ ...item })) : [],
    })),
    agentRuns: (legacy.agentRuns ?? []).map((run: BotanicAgentRun) => ({
      ...run,
      branches: Array.isArray(run.branches) ? run.branches.map((branch) => ({ ...branch, jobIds: [...(branch.jobIds ?? [])] })) : [],
      completedBranchCount: run.completedBranchCount ?? 0,
      failedBranchCount: run.failedBranchCount ?? 0,
      plan: {
        ...run.plan,
        references: run.plan.references.map((reference) => ({ ...reference })),
        constraints: run.plan.constraints.map((constraint) => ({ ...constraint })),
        settings: cloneGenerationSettings(run.plan.settings),
        rootRecipe: cloneGenerationRecipe(run.plan.rootRecipe),
      },
    })),
    agentSessions: (legacy.agentSessions ?? []).map((session) => ({
      ...session,
      contextNodeIds: [...new Set(Array.isArray(session.contextNodeIds) ? session.contextNodeIds.filter(Boolean) : [])],
      messages: Array.isArray(session.messages) ? session.messages.map((message) => ({ ...message })) : [],
    })),
    agentMemory: (legacy.agentMemory ?? []).flatMap((memory) => {
      try {
        return [createBotanicAgentMemoryItem({
          id: memory.id,
          now: memory.updatedAt ?? memory.createdAt,
          kind: memory.kind,
          content: memory.content,
          sourceNodeIds: memory.sourceNodeIds,
        })]
      } catch { return [] }
    }),
    activeAgentSessionId: legacy.activeAgentSessionId,
    activeVersionId: legacy.activeVersionId ?? fallbackDocument.activeVersionId,
  }
  return document
}
