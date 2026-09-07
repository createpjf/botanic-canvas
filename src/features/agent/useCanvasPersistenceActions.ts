import { useEffect, useRef, useState } from 'react'
import { createLatestOperation } from '../../domain/latestOperation'

export function useCanvasPersistenceActions(projectId: string, locale: string, retry: () => Promise<boolean>, refresh: () => Promise<boolean>) {
  const [action, setAction] = useState<'retry' | 'refresh' | ''>('')
  const [error, setError] = useState('')
  const active = useRef(false)
  const operations = useRef(createLatestOperation())
  const project = useRef(projectId)
  project.current = projectId
  useEffect(() => { active.current = false; setAction(''); setError(''); return () => { operations.current.invalidate(); active.current = false } }, [projectId])
  const run = async (kind: 'retry' | 'refresh') => {
    if (active.current) return
    const token = operations.current.begin(); active.current = true
    setAction(kind); setError('')
    const current = () => operations.current.isCurrent(token) && project.current === projectId
    try {
      const succeeded = await (kind === 'retry' ? retry() : refresh())
      if (!succeeded && current()) setError(locale === 'en'
        ? 'Not synced. Your local draft is kept; review the latest changes before retrying.'
        : '尚未同步，本地草稿已保留。请核对最新变更后再试。')
    } catch {
      if (current()) setError(locale === 'en'
        ? 'Recovery failed. Your local draft is kept. Check the connection and retry.'
        : '恢复失败，本地草稿已保留。请检查连接后重试。')
    } finally {
      if (current()) { active.current = false; setAction('') }
    }
  }
  return { action, error, run }
}
