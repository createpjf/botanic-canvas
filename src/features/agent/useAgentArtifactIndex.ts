import { useCallback, useEffect, useRef, useState } from 'react'
import { listProjectAgentArtifacts } from '../../lib/agentApi'
import { agentArtifactIndexNextPage, mergeAgentArtifactIndexPage, type AgentArtifactIndexState } from './agentWorkspace.types'

/** 只拥有索引读取和分页；刷新保留缓存，Run/Job 与产物仍以服务端记录为准。 */
export function useAgentArtifactIndex(projectId: string, enabled: boolean, refreshKey: string) {
  const [index, setIndex] = useState<AgentArtifactIndexState>({ projectId, artifacts: [], status: 'idle' })
  const stateRef = useRef(index)
  const requestRef = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null)
  const publish = useCallback((next: AgentArtifactIndexState) => {
    stateRef.current = next
    setIndex(next)
  }, [])

  const read = useCallback((before?: string) => {
    requestRef.current?.controller.abort()
    const controller = new AbortController()
    const current = stateRef.current.projectId === projectId ? stateRef.current : { projectId, artifacts: [] }
    publish({ ...current, status: before === undefined ? 'loading' : 'loading-more' })
    const promise = listProjectAgentArtifacts(projectId, { limit: 100, before, signal: controller.signal }).then((page) => {
      if (!controller.signal.aborted) publish(mergeAgentArtifactIndexPage(stateRef.current, page))
    }).catch(() => {
      if (!controller.signal.aborted) publish({ ...stateRef.current, status: before === undefined ? 'error' : 'error-more' })
    }).finally(() => {
      if (requestRef.current?.controller === controller) requestRef.current = null
    })
    requestRef.current = { controller, promise }
    return promise
  }, [projectId, publish])

  useEffect(() => {
    if (enabled) void read()
    else if (stateRef.current.projectId !== projectId || stateRef.current.status === 'idle') publish({ projectId, artifacts: [], status: 'ready' })
    return () => {
      requestRef.current?.controller.abort()
      requestRef.current = null
    }
  }, [enabled, projectId, publish, read, refreshKey])

  const loadMore = useCallback(() => {
    if (!enabled || stateRef.current.projectId !== projectId) return Promise.resolve()
    if (requestRef.current) return requestRef.current.promise
    const page = agentArtifactIndexNextPage(stateRef.current)
    return page ? read(page.before) : Promise.resolve()
  }, [enabled, projectId, read])

  const visibleIndex: AgentArtifactIndexState = index.projectId === projectId ? index : { projectId, artifacts: [], status: 'idle' }
  return { index: visibleIndex, loadMore }
}
