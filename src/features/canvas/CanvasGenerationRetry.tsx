import { useState } from 'react'
import { generationRetryState } from '../../domain/generationRecovery'
import { useProductI18n } from '../../i18n/react'
import { useCanvasStore } from '../../store/canvasStore'

export function CanvasGenerationRetry({ jobId }: { jobId?: string }) {
  const { locale } = useProductI18n()
  const jobs = useCanvasStore(state => state.document.generationJobs)
  const runs = useCanvasStore(state => state.document.agentRuns)
  const retryMissing = useCanvasStore(state => state.retryMissingGeneration)
  const [submitting, setSubmitting] = useState(false)
  const retry = generationRetryState(jobs.find(job => job.id === jobId), jobs, runs)
  if (!retry.canRetry && !retry.pending && !submitting) return null
  const pending = submitting || retry.pending
  return <div className="result-node__partial nodrag nowheel" onPointerDown={event => event.stopPropagation()}>
    <span>{pending ? (locale === 'en' ? 'Filling missing results…' : '正在补图…') : `${retry.requestedCount - retry.missingCount}/${retry.requestedCount}`}</span>
    <button type="button" disabled={pending || !retry.canRetry} onClick={async event => {
      event.stopPropagation()
      if (!jobId || pending) return
      setSubmitting(true)
      try { await retryMissing(jobId) } finally { setSubmitting(false) }
    }}>{locale === 'en' ? pending ? 'Filling…' : `Fill ${retry.missingCount}` : pending ? '补图中…' : `补 ${retry.missingCount} 张`}</button>
  </div>
}
