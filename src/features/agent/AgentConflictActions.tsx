import { useState } from 'react'
import './AgentConflictActions.css'

export function AgentConflictActions({ locale, action, error, onKeepLocal, onUseRemote }: {
  locale: string
  action: 'retry' | 'refresh' | ''
  error: string
  onKeepLocal: () => void
  onUseRemote: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const en = locale === 'en'
  return <section className="agent-conflict-actions" aria-label={en ? 'Resolve sync conflict' : '处理同步冲突'} aria-busy={Boolean(action)}>
    {error ? <p role="alert">{error}</p> : null}
    {confirming ? <p>{en ? 'Replace this local draft with the cloud version?' : '确定用云端版本替换当前本地草稿吗？'}</p> : null}
    <div>
      <button type="button" disabled={Boolean(action)} onClick={confirming ? () => setConfirming(false) : onKeepLocal}>
        {confirming ? (en ? 'Cancel' : '取消') : action === 'retry' ? (en ? 'Retrying…' : '正在重试…') : (en ? 'Keep local and retry' : '保留本地并重试')}
      </button>
      <button type="button" className="is-primary" disabled={Boolean(action)} onClick={() => {
        if (!confirming) { setConfirming(true); return }
        setConfirming(false); onUseRemote()
      }}>
        {action === 'refresh' ? (en ? 'Reading…' : '正在读取…') : confirming ? (en ? 'Confirm replacement' : '确认使用云端') : (en ? 'Discard local and use remote' : '放弃本地，使用云端')}
      </button>
    </div>
  </section>
}
