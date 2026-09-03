// @ts-check

import { canonicalHash } from '../canonicalHash.mjs'
import { canvasAgentEntityHash } from './canvasAgentEntityHash.mjs'
import { AgentToolRuntimeError } from '../agent/tools/agentToolRuntime.mjs'
import {
  applyBotanicAgentCanvasNodeDeletion,
  applyBotanicAgentCanvasTextUpdate,
  applyBotanicAgentGenerateSettingsUpdate,
  CANVAS_NODE_LABEL_LIMIT,
  CANVAS_TEXT_CONTENT_LIMIT,
} from './canvasAgentEditRules.mjs'

const MAX_OPERATIONS = 20
const OPERATION_KINDS = new Set(['create_text', 'create_generate', 'connect_reference', 'update_text', 'update_generate_settings', 'delete_nodes'])

const nodeId = { type: 'string', maxLength: 160 }
export const CANVAS_ACTION_SET_PARAMETERS = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    operations: { type: 'array', minItems: 1, maxItems: MAX_OPERATIONS, items: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...OPERATION_KINDS] }, temporaryId: { type: 'string', maxLength: 80 },
        nodeId, nodeIds: { type: 'array', maxItems: 12, items: nodeId }, sourceNodeId: nodeId, targetNodeId: nodeId,
        position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        label: { type: 'string', maxLength: CANVAS_NODE_LABEL_LIMIT }, content: { type: 'string', maxLength: CANVAS_TEXT_CONTENT_LIMIT },
        prompt: { type: 'string', maxLength: CANVAS_TEXT_CONTENT_LIMIT }, batchCount: { type: 'number' }, settings: { type: 'object' },
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
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) fail('CANVAS_ACTION_SET_INVALID', '节点位置格式无效。')
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
    if (kind === 'create_text' || kind === 'create_generate') {
      const temporaryId = text(operation.temporaryId, '临时节点标识', 80)
      if (temporaryIds.has(temporaryId)) fail('CANVAS_ACTION_SET_INVALID', '临时节点标识不能重复：' + temporaryId + '。')
      temporaryIds.add(temporaryId)
      Object.assign(result, { temporaryId, position: position(operation.position), label: optionalText(operation.label, '节点名称', CANVAS_NODE_LABEL_LIMIT) })
      if (kind === 'create_text') result.content = text(operation.content, '文字内容', CANVAS_TEXT_CONTENT_LIMIT)
      else {
        result.prompt = text(operation.prompt, '生成描述', CANVAS_TEXT_CONTENT_LIMIT)
        result.batchCount = Number(operation.batchCount ?? 1)
        if (!Number.isInteger(result.batchCount) || result.batchCount < 1 || result.batchCount > 8) fail('CANVAS_ACTION_SET_INVALID', '生成数量必须是 1–8 的整数。')
        result.settings = generationSettings(operation.settings)
      }
    } else if (kind === 'connect_reference') {
      result.sourceNodeId = text(operation.sourceNodeId, '参考来源节点')
      result.targetNodeId = text(operation.targetNodeId, '参考目标节点')
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
    for (const id of [operation.sourceNodeId, operation.targetNodeId]) if (id && !temporaryIds.has(id)) requiredIds.add(id)
  }
  return requiredIds
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
export function applyCanvasActionSet(document, raw, models, now = Date.now()) {
  const actionSet = normalizeCanvasActionSet(raw)
  assertPreconditions(document, actionSet)
  let current = structuredClone(document)
  const ids = new Map()
  const createdNodeIds = []
  const createdEdgeIds = []
  const updatedNodeIds = []
  const removedNodeIds = []
  for (const operation of actionSet.operations) {
    if (operation.kind === 'create_text' || operation.kind === 'create_generate') {
      const id = deterministicId(actionSet.actionId, operation.temporaryId, operation.kind === 'create_text' ? 'text' : 'generate')
      if (node(current, id)) fail('CANVAS_ACTION_SET_CONFLICT', '确定性节点标识已被占用。', 409)
      const data = operation.kind === 'create_text'
        ? { kind: 'text', label: operation.label ?? '文字', content: operation.content }
        : { kind: 'generate', label: operation.label ?? '生成', prompt: operation.prompt, batchCount: operation.batchCount, settings: operation.settings, status: 'idle' }
      current = { ...current, nodes: [...(current.nodes ?? []), { id, type: operation.kind === 'create_text' ? 'text' : 'generate', position: operation.position, draggable: true, selected: false, data }], updatedAt: now }
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
    } else {
      const nodeIds = operation.nodeIds.map((id) => resolvedId(id, ids))
      const applied = applyBotanicAgentCanvasNodeDeletion(current, { nodeIds }, now)
      current = applied.document; removedNodeIds.push(...applied.removedNodeIds)
    }
  }
  return { document: current, actionSet, createdNodeIds, createdEdgeIds, updatedNodeIds: [...new Set(updatedNodeIds)], removedNodeIds: [...new Set(removedNodeIds)] }
}

function previewNode(node) {
  return { id: node.id, type: node.type, label: node.data?.label ?? node.data?.name ?? node.id }
}

/** 服务端在提案时重建前置条件并预演；返回值可直接冻结到 Proposal。 */
export function prepareCanvasActionSetProposal(document, raw, models, actionId) {
  const normalized = normalizeCanvasActionSet({ ...raw, actionId, preconditions: [] })
  const preconditions = [...touchedExistingNodeIds(normalized.operations)].sort().map((nodeId) => {
    const hash = canvasAgentEntityHash(document, nodeId)
    if (!hash) fail('CANVAS_NODE_NOT_FOUND', '未找到画布节点：' + nodeId + '。', 404)
    return { nodeId, hash }
  })
  const argumentsValue = { operations: normalized.operations, preconditions }
  const applied = applyCanvasActionSet(document, { ...argumentsValue, actionId }, models)
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
  const preview = { created, updated, removed, connections,
    summary: { created: created.length, updated: updated.length, removed: removed.length, connected: connections.length } }
  return { arguments: argumentsValue, preview, previewHash: canonicalHash({ actionId, arguments: argumentsValue, preview }) }
}
