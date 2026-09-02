// @ts-check

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createCanvasCollaborationRoom } from './canvasCollaborationRoom.mjs'

const clone = (value) => structuredClone(value)

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function canvasProjectMutationId(scope, identity) {
  if (typeof scope !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(scope)) {
    throw new TypeError('画布提交范围无效。')
  }
  const payload = typeof identity === 'string' ? identity : JSON.stringify(canonicalize(identity))
  return `${scope}:${createHash('sha256').update(payload).digest('base64url')}`
}

export function supportsDurableCanvasGraphMutation(productStore) {
  return [
    'readProject',
    'updateProjectDocument',
    'loadCanvasCollaboration',
    'appendCanvasGraphUpdate',
    'compactCanvasGraphUpdates',
  ].every((method) => typeof productStore?.[method] === 'function')
}

function assertSupportedDocumentMutation(current, next) {
  const graphCommitFields = new Set(['nodes', 'edges', 'generationJobs', 'updatedAt'])
  const unsupported = [...new Set([...Object.keys(current), ...Object.keys(next)])]
    .find((key) => !graphCommitFields.has(key) && !isDeepStrictEqual(current[key], next[key]))
  if (unsupported) throw new TypeError(`Canvas Graph commit 不支持同时修改项目字段：${unsupported}。`)
}

function mergeGenerationJobPatch(current = [], base = [], next = []) {
  const baseById = new Map(base.map((record) => [record.id, record]))
  const nextById = new Map(next.map((record) => [record.id, record]))
  const changedIds = new Set([...baseById.keys(), ...nextById.keys()].filter((id) => (
    !isDeepStrictEqual(baseById.get(id), nextById.get(id))
  )))
  const merged = clone(current)
  for (const id of changedIds) {
    const target = nextById.get(id)
    const index = merged.findIndex((record) => record.id === id)
    if (!target) {
      if (index >= 0) merged.splice(index, 1)
      continue
    }
    const currentRecord = index >= 0 ? merged[index] : undefined
    const winner = currentRecord && Number(currentRecord.updatedAt) > Number(target.updatedAt)
      ? currentRecord
      : target
    const dismissedOutputIds = [...new Set([
      ...(currentRecord?.dismissedOutputIds ?? []),
      ...(target.dismissedOutputIds ?? []),
    ])]
    const projectionDismissedAt = Math.max(
      Number(currentRecord?.projectionDismissedAt) || 0,
      Number(target.projectionDismissedAt) || 0,
    ) || undefined
    const outputs = winner.outputs?.filter((output) => !dismissedOutputIds.includes(output.id))
    const record = {
      ...clone(winner),
      outputs,
      outputCount: outputs?.length ?? winner.outputCount,
      dismissedOutputIds: dismissedOutputIds.length ? dismissedOutputIds : undefined,
      projectionDismissedAt,
    }
    if (index >= 0) merged[index] = record
    else merged.unshift(record)
  }
  return merged
}

/**
 * Agent / Generation 的服务端图谱写入入口。
 * 任务投影先落入项目文档，再经 Yjs 增量 + mutationId durable commit；图谱提交失败时，
 * 已写入的 tombstone 仍会阻止迟到 Worker 复活投影。
 */
export async function commitCanvasProjectMutation({
  productStore,
  userId,
  projectId,
  mutationId,
  mutate,
}) {
  if (!supportsDurableCanvasGraphMutation(productStore)) {
    throw new TypeError('ProductStore 缺少 durable Canvas Graph commit 能力。')
  }
  if (typeof mutate !== 'function') throw new TypeError('项目文档更新器无效。')
  const project = await productStore.readProject(userId, projectId)
  if (!project) return undefined
  const state = await productStore.loadCanvasCollaboration(userId, projectId)
  if (!state) return undefined

  let mutationBaseDocument = { ...clone(project.document), ...clone(state.graph) }
  let proposedDocument = mutate(clone(mutationBaseDocument))
  if (proposedDocument) assertSupportedDocumentMutation(mutationBaseDocument, proposedDocument)
  if (!proposedDocument) {
    return {
      saved: project,
      baseRevision: project.revision,
      baseGraphRevision: state.graphRevision,
      graphCommit: {
        changed: false,
        applied: false,
        previousGraph: clone(state.graph),
        graph: clone(state.graph),
        graphRevision: state.graphRevision,
        mutationId,
      },
      changed: false,
    }
  }

  const metadataSaved = await productStore.updateProjectDocument(userId, projectId, (document) => ({
    ...document,
    ...(!isDeepStrictEqual(mutationBaseDocument.generationJobs, proposedDocument.generationJobs)
      ? {
          generationJobs: mergeGenerationJobPatch(
            document.generationJobs,
            mutationBaseDocument.generationJobs,
            proposedDocument.generationJobs,
          ),
        }
      : {}),
    updatedAt: Math.max(Number(document.updatedAt) || 0, Number(proposedDocument.updatedAt) || 0),
    nodes: clone(document.nodes ?? []),
    edges: clone(document.edges ?? []),
  }))
  let metadataDocument = metadataSaved?.document ?? project.document
  let useInitialProposal = true
  const room = createCanvasCollaborationRoom({
    state,
    reload: async (actorId) => {
      const nextState = await productStore.loadCanvasCollaboration(actorId, projectId)
      const nextProject = await productStore.readProject(actorId, projectId)
      if (!nextState || !nextProject) throw new Error('未找到画布协作状态。')
      metadataDocument = nextProject.document
      return nextState
    },
    append: (payload, actorId) => productStore.appendCanvasGraphUpdate(actorId, projectId, payload),
    compact: (payload, actorId) => productStore.compactCanvasGraphUpdates(actorId, projectId, payload),
  })
  let graphCommit
  try {
    graphCommit = await room.commitGraphMutation((graph) => {
      if (useInitialProposal) {
        useInitialProposal = false
        return { nodes: clone(proposedDocument.nodes ?? []), edges: clone(proposedDocument.edges ?? []) }
      }
      mutationBaseDocument = { ...clone(metadataDocument), ...clone(graph) }
      proposedDocument = mutate(clone(mutationBaseDocument))
      if (proposedDocument) assertSupportedDocumentMutation(mutationBaseDocument, proposedDocument)
      return proposedDocument
        ? { nodes: clone(proposedDocument.nodes ?? []), edges: clone(proposedDocument.edges ?? []) }
        : undefined
    }, userId, {
      mutationId,
      syncProtocolEpoch: Number.isInteger(state.syncProtocolEpoch) ? state.syncProtocolEpoch : 1,
    })
    graphCommit = { ...graphCommit, mutationId }
  } finally {
    await room.destroy()
  }
  const saved = await productStore.readProject(userId, projectId) ?? metadataSaved

  return {
    saved,
    baseRevision: project.revision,
    baseGraphRevision: state.graphRevision,
    graphCommit,
    changed: Boolean(graphCommit.changed || metadataSaved),
  }
}
