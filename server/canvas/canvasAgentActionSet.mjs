// @ts-check

import { canonicalHash } from '../canonicalHash.mjs'
import { canvasAgentEntityHash } from './canvasAgentEntityHash.mjs'
import { canvasAgentArtifactHash, projectCanvasResultFromArtifact } from './canvasAgentArtifactProjection.mjs'
import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'
import { CANVAS_LAYOUT_MODES, layoutCanvasAgentNodes } from './canvasAgentLayout.mjs'
import { CANVAS_FRAME_STAGES, applyCanvasFrameMembership, applyCanvasFrameUpdate, assertCanvasFrameData } from './canvasAgentFrameRules.mjs'
import {
  applyBotanicAgentCanvasNodeDeletion,
  applyBotanicAgentCanvasOrganization,
  applyBotanicAgentCanvasTextUpdate,
  applyBotanicAgentGenerateSettingsUpdate,
  CANVAS_NODE_LABEL_LIMIT,
  CANVAS_TEXT_CONTENT_LIMIT,
} from './canvasAgentEditRules.mjs'

const MAX_OPERATIONS = 20
const OPERATION_KINDS = new Set(['create_text', 'create_generate', 'project_artifact', 'connect_reference', 'update_text', 'update_generate_settings', 'organize_nodes', 'layout_nodes', 'create_frame', 'update_frame', 'delete_nodes'])
const CONSTRAINT_DIMENSIONS = new Set(['person', 'garment', 'product', 'scene', 'style', 'pose', 'composition', 'lighting', 'aspect_ratio', 'copy_space'])

const nodeId = { type: 'string', maxLength: 160 }
export const CANVAS_ACTION_SET_PARAMETERS = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    operations: { type: 'array', minItems: 1, maxItems: MAX_OPERATIONS, items: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...OPERATION_KINDS] }, temporaryId: { type: 'string', maxLength: 80 },
        nodeId, nodeIds: { type: 'array', maxItems: 20, items: nodeId }, sourceNodeId: nodeId, targetNodeId: nodeId,
        mode: { type: 'string', enum: [...CANVAS_LAYOUT_MODES] }, gap: { type: 'number' }, columns: { type: 'number' },
        stage: { type: 'string', enum: [...CANVAS_FRAME_STAGES] }, width: { type: 'number' }, height: { type: 'number' },
        anchor: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        label: { type: 'string', maxLength: CANVAS_NODE_LABEL_LIMIT }, content: { type: 'string', maxLength: CANVAS_TEXT_CONTENT_LIMIT },
        prompt: { type: 'string', maxLength: CANVAS_TEXT_CONTENT_LIMIT }, batchCount: { type: 'number' }, settings: { type: 'object' },
        artifactId: nodeId, artifactHash: { type: 'string', maxLength: 100 }, placements: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, properties: { nodeId, position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, label: { type: 'string', maxLength: CANVAS_NODE_LABEL_LIMIT }, frameId: { oneOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }] } }, required: ['nodeId', 'position'] } }, constraints: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { dimension: { type: 'string', enum: [...CONSTRAINT_DIMENSIONS] }, mode: { type: 'string', enum: ['preserve', 'change'] } }, required: ['dimension', 'mode'] } },
      }, required: ['kind'],
    } },
    preconditions: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false,
      properties: { nodeId, hash: { type: 'string', maxLength: 100 } }, required: ['nodeId', 'hash'] } },
  }, required: ['operations'],
})

function fail(code, message, statusCode = 422) {
  throw new AgentToolRuntimeError(code, message, statusCode)
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CANVAS_ACTION_SET_INVALID', name + '格式无效。')
  return value
}
function text(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('CANVAS_ACTION_SET_INVALID', name + '格式无效。')
  return value.trim()
}
function optionalText(value, name, max) {
  return value === undefined ? undefined : text(value, name, max)
}
function generationSettings(value) {
  const input = object(value, '生成设置')
  const settings = {
    ...(input.model === undefined ? {} : { model: text(input.model, '模型', 80) }),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: text(input.aspectRatio, '画面比例', 16) }),
    ...(input.resolution === undefined ? {} : { resolution: text(input.resolution, '清晰度', 16) }),
  }
  if (Object.keys(input).some((key) => !['model', 'aspectRatio', 'resolution'].includes(key))) fail('CANVAS_ACTION_NOT_ALLOWED', '生成设置包含不允许修改的字段。')
  return settings
}
function position(value) {
  const input = object(value, '节点位置')
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || Math.abs(input.x) > 1_000_000 || Math.abs(input.y) > 1_000_000) fail('CANVAS_ACTION_SET_INVALID', '节点位置格式无效。')
  return { x: Number(input.x), y: Number(input.y) }
}
function node(document, id) {
  return (document.nodes ?? []).find((item) => item.id === id)
}
function resolvedId(value, ids) {
  const id = text(value, '节点标识')
  return ids.get(id) ?? id
}
function deterministicId(actionId, temporaryId, prefix) {
  return prefix + '-' + canonicalHash({ actionId, temporaryId }).slice(0, 22)
}
function referenceEdgeId(actionId, source, target) {
  return 'agent-reference-' + canonicalHash({ actionId, source, target }).slice(0, 22)
}
function governedPrompt(prompt, constraints = []) {
  if (!constraints.length) return prompt
  const contract = constraints.map((item) => `${item.mode === 'preserve' ? 'PRESERVE' : 'CHANGE'} ${item.dimension}`).join('; ')
  return `Execution contract (PRESERVE cannot be overridden): ${contract}.\n\n${prompt}`
}

/** @param {any} raw */
export function normalizeCanvasActionSet(raw) {
  const input = object(raw, '画布行动集')
  const actionId = text(input.actionId, '行动标识', 240)
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > MAX_OPERATIONS) {
    fail('CANVAS_ACTION_SET_INVALID', '画布行动集必须包含 1–20 个操作。')
  }
  const temporaryIds = new Set()
  const operations = input.operations.map((rawOperation, index) => {
    const operation = object(rawOperation, '画布操作')
    const kind = text(operation.kind, '操作类型', 40)
    if (!OPERATION_KINDS.has(kind)) fail('CANVAS_ACTION_NOT_ALLOWED', '不支持的画布操作：' + kind + '。')
    const result = { kind }
    if (kind === 'create_text' || kind === 'create_generate' || kind === 'project_artifact' || kind === 'create_frame') {
      const temporaryId = text(operation.temporaryId, '临时节点标识', 80)
      if (temporaryIds.has(temporaryId)) fail('CANVAS_ACTION_SET_INVALID', '临时节点标识不能重复：' + temporaryId + '。')
      temporaryIds.add(temporaryId)
      Object.assign(result, { temporaryId, position: position(operation.position), label: optionalText(operation.label, '节点名称', CANVAS_NODE_LABEL_LIMIT) })
      if (kind === 'create_text') result.content = text(operation.content, '文字内容', CANVAS_TEXT_CONTENT_LIMIT)
      else if (kind === 'create_frame') Object.assign(result, assertCanvasFrameData(operation))
      else if (kind === 'project_artifact') {
        result.artifactId = text(operation.artifactId, 'Artifact 标识', 240)
        result.artifactHash = optionalText(operation.artifactHash, 'Artifact hash', 100)
      } else {
        result.prompt = text(operation.prompt, '生成描述', CANVAS_TEXT_CONTENT_LIMIT)
        result.batchCount = Number(operation.batchCount ?? 1)
        if (!Number.isInteger(result.batchCount) || result.batchCount < 1 || result.batchCount > 8) fail('CANVAS_ACTION_SET_INVALID', '生成数量必须是 1–8 的整数。')
        result.settings = generationSettings(operation.settings)
        const constraints = Array.isArray(operation.constraints) ? operation.constraints.map((entry) => {
          const constraint = object(entry, '保留/修改约束')
          const dimension = text(constraint.dimension, '约束维度', 40)
          const mode = text(constraint.mode, '约束模式', 16)
          if (!CONSTRAINT_DIMENSIONS.has(dimension) || !['preserve', 'change'].includes(mode)) fail('CANVAS_ACTION_SET_INVALID', '保留/修改约束无效。')
          return { dimension, mode }
        }) : []
        if (new Set(constraints.map((item) => item.dimension)).size !== constraints.length) fail('CANVAS_ACTION_SET_INVALID', '同一维度不能重复声明约束。')
        if (constraints.length) result.constraints = constraints
      }
    } else if (kind === 'connect_reference') {
      result.sourceNodeId = text(operation.sourceNodeId, '参考来源节点')
      result.targetNodeId = text(operation.targetNodeId, '参考目标节点')
    } else if (kind === 'organize_nodes') {
      if (!Array.isArray(operation.placements) || !operation.placements.length || operation.placements.length > 20) fail('CANVAS_ACTION_SET_INVALID', '组织节点必须包含 1–20 个位置。')
      result.placements = operation.placements.map((entry) => {
        const placement = object(entry, '节点组织位置')
        const frameId = placement.frameId === null ? null : optionalText(placement.frameId, 'Frame 标识')
        return { nodeId: text(placement.nodeId, '节点标识'), position: position(placement.position), label: optionalText(placement.label, '节点名称', CANVAS_NODE_LABEL_LIMIT), ...(placement.frameId === undefined ? {} : { frameId }) }
      })
      if (new Set(result.placements.map((item) => item.nodeId)).size !== result.placements.length) fail('CANVAS_ACTION_SET_INVALID', '同一节点不能重复组织。')
    } else if (kind === 'layout_nodes') {
      if (!Array.isArray(operation.nodeIds) || !operation.nodeIds.length || operation.nodeIds.length > 20) fail('CANVAS_ACTION_SET_INVALID', '布局必须包含 1–20 个节点。')
      result.nodeIds = operation.nodeIds.map((id) => text(id, '布局节点标识'))
      if (new Set(result.nodeIds).size !== result.nodeIds.length) fail('CANVAS_ACTION_SET_INVALID', '布局节点不能重复。')
      result.mode = text(operation.mode, '布局模式', 40)
      if (!CANVAS_LAYOUT_MODES.includes(result.mode)) fail('CANVAS_ACTION_SET_INVALID', '布局模式无效。')
      if (operation.anchor !== undefined) result.anchor = position(operation.anchor)
      if (operation.gap !== undefined) {
        result.gap = Number(operation.gap)
        if (!Number.isFinite(result.gap) || result.gap < 16 || result.gap > 400) fail('CANVAS_ACTION_SET_INVALID', '布局间距必须在 16–400 之间。')
      }
      if (operation.columns !== undefined) {
        result.columns = Number(operation.columns)
        if (!Number.isInteger(result.columns) || result.columns < 1 || result.columns > 10 || result.mode !== 'grid') fail('CANVAS_ACTION_SET_INVALID', '网格列数必须是 1–10 的整数且仅用于 grid。')
      }
      if (result.mode.startsWith('distribute_') && result.nodeIds.length < 3) fail('CANVAS_ACTION_SET_INVALID', '分布布局至少需要 3 个节点。')
    } else if (kind === 'update_frame') {
      result.nodeId = text(operation.nodeId, 'Frame 节点标识')
      if (operation.label !== undefined) result.label = text(operation.label, 'Frame 名称', CANVAS_NODE_LABEL_LIMIT)
      if (operation.stage !== undefined) result.stage = text(operation.stage, 'Frame 阶段', 40)
      if (operation.width !== undefined) result.width = Number(operation.width)
      if (operation.height !== undefined) result.height = Number(operation.height)
      if (result.label === undefined && result.stage === undefined && result.width === undefined && result.height === undefined) fail('CANVAS_ACTION_SET_INVALID', 'Frame 更新至少包含一项。')
    } else if (kind === 'delete_nodes') {
      if (!Array.isArray(operation.nodeIds) || !operation.nodeIds.length || operation.nodeIds.length > 12) fail('CANVAS_ACTION_SET_INVALID', '删除节点必须包含 1–12 个标识。')
      result.nodeIds = [...new Set(operation.nodeIds.map((id) => text(id, '删除节点标识')))]
    } else {
      result.nodeId = text(operation.nodeId, '节点标识')
      if (kind === 'update_text') {
        result.content = optionalText(operation.content, '文字内容', CANVAS_TEXT_CONTENT_LIMIT)
        result.label = optionalText(operation.label, '节点名称', CANVAS_NODE_LABEL_LIMIT)
        if (result.content === undefined && result.label === undefined) fail('CANVAS_ACTION_SET_INVALID', '文字更新至少要包含正文或名称。')
      } else {
        if (operation.settings !== undefined) result.settings = generationSettings(operation.settings)
        if (operation.batchCount !== undefined) {
          result.batchCount = Number(operation.batchCount)
          if (!Number.isInteger(result.batchCount) || result.batchCount < 1 || result.batchCount > 8) fail('CANVAS_ACTION_SET_INVALID', '生成数量必须是 1–8 的整数。')
        }
        if (result.settings === undefined && result.batchCount === undefined) fail('CANVAS_ACTION_SET_INVALID', '生成设置更新至少要包含一项参数。')
      }
    }
    return result
  })
  const preconditions = Array.isArray(input.preconditions) ? input.preconditions.map((entry) => {
    const item = object(entry, '触达实体前置条件')
    return { nodeId: text(item.nodeId, '前置节点标识'), hash: text(item.hash, '前置条件 hash', 100) }
  }) : []
  return { actionId, operations, preconditions }
}

function touchedExistingNodeIds(operations) {
  const temporaryIds = new Set(operations.filter((item) => item.temporaryId).map((item) => item.temporaryId))
  const requiredIds = new Set()
  for (const operation of operations) {
    if (operation.nodeId && !temporaryIds.has(operation.nodeId)) requiredIds.add(operation.nodeId)
    for (const id of operation.nodeIds ?? []) if (!temporaryIds.has(id)) requiredIds.add(id)
    for (const item of operation.placements ?? []) {
      if (!temporaryIds.has(item.nodeId)) requiredIds.add(item.nodeId)
      if (item.frameId && !temporaryIds.has(item.frameId)) requiredIds.add(item.frameId)
    }
    for (const id of [operation.sourceNodeId, operation.targetNodeId]) if (id && !temporaryIds.has(id)) requiredIds.add(id)
  }
  return requiredIds
}

function assertActionSetDocumentSafety(document, actionSet) {
  const existingIds = new Set((document.nodes ?? []).map((item) => item.id))
  const temporaryIds = new Set(actionSet.operations.flatMap((item) => item.temporaryId ? [item.temporaryId] : []))
  if ([...temporaryIds].some((id) => existingIds.has(id))) fail('CANVAS_ACTION_SET_CONFLICT', '临时节点标识与既有节点冲突。', 409)
  if (actionSet.operations.some((item) => item.kind === 'delete_nodes' && item.nodeIds.some((id) => temporaryIds.has(id)))) {
    fail('CANVAS_ACTION_NOT_ALLOWED', '同一行动集不能创建后删除临时节点。')
  }
}

function assertPreconditions(document, actionSet) {
  const requiredIds = touchedExistingNodeIds(actionSet.operations)
  const providedIds = new Set(actionSet.preconditions.map((item) => item.nodeId))
  if ([...requiredIds].some((id) => !providedIds.has(id))) fail('CANVAS_ACTION_SET_PRECONDITION_REQUIRED', '既有触达节点必须包含查询所得的 entityHash。', 409)
  for (const item of actionSet.preconditions) {
    if (canvasAgentEntityHash(document, item.nodeId) !== item.hash) {
      fail('CANVAS_ACTION_SET_CONFLICT', '画布节点已变化，请重新查询并确认：' + item.nodeId + '。', 409)
    }
  }
}

/** 全部操作只作用于内存副本；任一操作失败时调用者不会得到部分文档。 */
export function applyCanvasActionSet(document, raw, models, now = Date.now(), artifacts = new Map()) {
  const actionSet = normalizeCanvasActionSet(raw)
  assertActionSetDocumentSafety(document, actionSet)
  assertPreconditions(document, actionSet)
  let current = structuredClone(document)
  const ids = new Map()
  const createdNodeIds = []
  const createdEdgeIds = []
  const updatedNodeIds = []
  const removedNodeIds = []
  for (const operation of actionSet.operations) {
    if (operation.kind === 'create_text' || operation.kind === 'create_generate' || operation.kind === 'project_artifact' || operation.kind === 'create_frame') {
      const prefix = operation.kind === 'create_text' ? 'text' : operation.kind === 'create_generate' ? 'generate' : operation.kind === 'create_frame' ? 'frame' : 'result'
      const id = deterministicId(actionSet.actionId, operation.temporaryId, prefix)
      if (node(current, id)) fail('CANVAS_ACTION_SET_CONFLICT', '确定性节点标识已被占用。', 409)
      let created
      if (operation.kind === 'create_frame') {
        created = { id, type: 'frame', position: operation.position, draggable: true, selected: false, data: { kind: 'frame', ...assertCanvasFrameData(operation) } }
      } else if (operation.kind === 'project_artifact') {
        const artifact = artifacts.get(operation.artifactId)
        if (!artifact || canvasAgentArtifactHash(artifact) !== operation.artifactHash) fail('CANVAS_ARTIFACT_CONFLICT', '历史 Artifact 已变化，请重新确认：' + operation.artifactId + '。', 409)
        created = projectCanvasResultFromArtifact(artifact, { id, position: operation.position, label: operation.label })
      } else {
        const data = operation.kind === 'create_text'
          ? { kind: 'text', label: operation.label ?? '文字', content: operation.content }
          : { kind: 'generate', label: operation.label ?? '生成', prompt: governedPrompt(operation.prompt, operation.constraints), batchCount: operation.batchCount, settings: operation.settings, status: 'idle', ...(operation.constraints ? { constraints: operation.constraints } : {}) }
        created = { id, type: operation.kind === 'create_text' ? 'text' : 'generate', position: operation.position, draggable: true, selected: false, data }
      }
      current = { ...current, nodes: [...(current.nodes ?? []), created], updatedAt: now }
      if (operation.kind === 'create_generate') current = applyBotanicAgentGenerateSettingsUpdate(current, { nodeId: id, settings: operation.settings, batchCount: operation.batchCount }, models, now).document
      ids.set(operation.temporaryId, id)
      createdNodeIds.push(id)
    } else if (operation.kind === 'connect_reference') {
      const source = resolvedId(operation.sourceNodeId, ids)
      const target = resolvedId(operation.targetNodeId, ids)
      const sourceNode = node(current, source)
      const targetNode = node(current, target)
      if (!sourceNode || targetNode?.type !== 'generate' || source === target) fail('CANVAS_ACTION_NOT_ALLOWED', '参考连线必须从既有素材/结果/参考节点连接到生成节点。')
      if (!['asset', 'result', 'reference'].includes(sourceNode.type)) fail('CANVAS_ACTION_NOT_ALLOWED', '该节点不能作为生成参考。')
      const id = referenceEdgeId(actionSet.actionId, source, target)
      if (!(current.edges ?? []).some((edge) => edge.source === source && edge.target === target)) {
        const model = (models ?? []).find((item) => item.id === targetNode.data?.settings?.model)
        const connected = (current.edges ?? []).filter((edge) => edge.target === target)
          .map((edge) => node(current, edge.source)).filter((item) => ['asset', 'result', 'reference'].includes(item?.type))
        if (connected.length >= Number(model?.maximumReferences ?? 8)) fail('CANVAS_REFERENCE_LIMIT', '该生成模型的参考素材数量已达上限。')
        if (sourceNode.type === 'result' && model?.mediaKind !== 'video' && connected.some((item) => item.type === 'result')) {
          fail('CANVAS_ACTION_NOT_ALLOWED', '图片生成节点只能连接一个结果节点作为父图。')
        }
        const nextTarget = { ...targetNode, data: { ...targetNode.data, inputOrder: [...new Set([...(targetNode.data?.inputOrder ?? []), source])] } }
        current = { ...current,
          nodes: current.nodes.map((item) => item.id === target ? nextTarget : item),
          edges: [...(current.edges ?? []), { id, source, sourceHandle: sourceNode.type === 'asset' ? 'asset-output' : 'output', target, targetHandle: 'input', type: 'default', data: { role: 'reference' }, reconnectable: true }], updatedAt: now }
        createdEdgeIds.push(id); updatedNodeIds.push(target)
      }
    } else if (operation.kind === 'update_text') {
      const id = resolvedId(operation.nodeId, ids)
      const applied = applyBotanicAgentCanvasTextUpdate(current, { nodeId: id, content: operation.content, label: operation.label }, now)
      current = applied.document; updatedNodeIds.push(id)
    } else if (operation.kind === 'update_generate_settings') {
      const id = resolvedId(operation.nodeId, ids)
      const applied = applyBotanicAgentGenerateSettingsUpdate(current, { nodeId: id, settings: operation.settings, batchCount: operation.batchCount }, models, now)
      current = applied.document; updatedNodeIds.push(id)
    } else if (operation.kind === 'organize_nodes') {
      const placements = operation.placements.map((item) => ({ ...item, nodeId: resolvedId(item.nodeId, ids) }))
      const applied = applyBotanicAgentCanvasOrganization(current, { placements }, now)
      current = applied.document; updatedNodeIds.push(...applied.updatedNodeIds)
      const memberships = placements.filter((item) => Object.hasOwn(item, 'frameId')).map((item) => ({
        nodeId: item.nodeId, frameId: item.frameId === null ? null : resolvedId(item.frameId, ids),
      }))
      if (memberships.length) {
        const framed = applyCanvasFrameMembership(current, memberships, now)
        current = framed.document; updatedNodeIds.push(...framed.updatedNodeIds)
      }
    } else if (operation.kind === 'update_frame') {
      const id = resolvedId(operation.nodeId, ids)
      const applied = applyCanvasFrameUpdate(current, { ...operation, nodeId: id }, now)
      current = applied.document; updatedNodeIds.push(id)
    } else if (operation.kind === 'layout_nodes') {
      const nodeIds = operation.nodeIds.map((id) => resolvedId(id, ids))
      const placements = layoutCanvasAgentNodes(current, { ...operation, nodeIds })
      const applied = applyBotanicAgentCanvasOrganization(current, { placements }, now)
      current = applied.document; updatedNodeIds.push(...applied.updatedNodeIds)
    } else {
      const nodeIds = operation.nodeIds.map((id) => resolvedId(id, ids))
      const applied = applyBotanicAgentCanvasNodeDeletion(current, { nodeIds }, now)
      current = applied.document; removedNodeIds.push(...applied.removedNodeIds); updatedNodeIds.push(...(applied.updatedNodeIds ?? []))
    }
  }
  return { document: current, actionSet, createdNodeIds, createdEdgeIds, updatedNodeIds: [...new Set(updatedNodeIds)], removedNodeIds: [...new Set(removedNodeIds)] }
}

function previewNode(node) {
  const x = Number(node.position?.x), y = Number(node.position?.y)
  return { id: String(node.id).slice(0, 160), type: String(node.type).slice(0, 40), label: String(node.data?.label ?? node.data?.name ?? node.id).slice(0, 160),
    position: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 } }
}

/** 服务端在提案时重建前置条件并预演；返回值可直接冻结到 Proposal。 */
export function prepareCanvasActionSetProposal(document, raw, models, actionId, artifacts = new Map()) {
  const normalized = normalizeCanvasActionSet({ ...raw, actionId, preconditions: [] })
  const operations = normalized.operations.map((operation) => {
    if (operation.kind !== 'project_artifact') return operation
    const artifact = artifacts.get(operation.artifactId)
    if (!artifact) fail('CANVAS_ARTIFACT_NOT_FOUND', '未找到历史 Artifact：' + operation.artifactId + '。', 404)
    return { ...operation, artifactHash: canvasAgentArtifactHash(artifact) }
  })
  const preconditions = [...touchedExistingNodeIds(operations)].sort().map((nodeId) => {
    const hash = canvasAgentEntityHash(document, nodeId)
    if (!hash) fail('CANVAS_NODE_NOT_FOUND', '未找到画布节点：' + nodeId + '。', 404)
    return { nodeId, hash }
  })
  const argumentsValue = { operations, preconditions }
  const applied = applyCanvasActionSet(document, { ...argumentsValue, actionId }, models, Date.now(), artifacts)
  const before = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  const after = new Map((applied.document.nodes ?? []).map((node) => [node.id, node]))
  const created = applied.createdNodeIds.map((id) => previewNode(after.get(id)))
  const removed = applied.removedNodeIds.map((id) => previewNode(before.get(id)))
  const updated = applied.updatedNodeIds.filter((id) => before.has(id) && after.has(id))
    .map((id) => ({ before: previewNode(before.get(id)), after: previewNode(after.get(id)) }))
  const connections = applied.createdEdgeIds.map((id) => {
    const edge = applied.document.edges.find((item) => item.id === id)
    return { id, sourceNodeId: edge.source, targetNodeId: edge.target, role: edge.data?.role ?? 'reference' }
  })
  const changedIds = new Set([...applied.createdNodeIds, ...applied.updatedNodeIds, ...applied.removedNodeIds])
  const contextIds = [...new Set(connections.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]))].filter((id) => !changedIds.has(id)).sort()
  const context = contextIds.map((id) => previewNode(after.get(id) ?? before.get(id)))
  const preview = { context, created, updated, removed, connections,
    summary: { created: created.length, updated: updated.length, removed: removed.length, connected: connections.length } }
  return { arguments: argumentsValue, preview, previewHash: canonicalHash({ actionId, arguments: argumentsValue, preview }) }
}
