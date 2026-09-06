export type TimelineJobFailure = {
  id: string
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  errorCode?: string
  createdAt?: number
  startedAt?: number
  updatedAt?: number
  completedAt?: number
  variants?: readonly { status?: string; startedAt?: number; completedAt?: number }[]
}

export function resolveBranchJob(
  branch: { activeJobId?: string; jobIds?: readonly string[] },
  jobs?: readonly TimelineJobFailure[],
) {
  if (!jobs?.length) return undefined
  if (branch.activeJobId) {
    const active = jobs.find((job) => job.id === branch.activeJobId)
    if (active) return active
  }
  for (let index = (branch.jobIds?.length ?? 0) - 1; index >= 0; index -= 1) {
    const found = jobs.find((job) => job.id === branch.jobIds?.[index])
    if (found) return found
  }
}

export function validTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

/** 仅时间线展示；不写入 Turn/Run。等待确认会冻结该阶段，不叫思考时长。 */
export type TimelineOperationTiming = { startedAt?: number; endedAt?: number; live: boolean }

export function timelineOperationTiming(record: { createdAt?: number; updatedAt?: number; status?: string }): TimelineOperationTiming {
  const live = ['queued', 'running', 'executing', 'cancelling'].includes(record.status ?? '')
  return { startedAt: validTimestamp(record.createdAt), endedAt: live ? undefined : validTimestamp(record.updatedAt), live }
}

/** 同一操作的 Turn → Run，保留最早起点；后继仍运行时不能沿用前阶段终点。 */
export function joinTimelineTiming(earlier: TimelineOperationTiming | undefined, later: TimelineOperationTiming): TimelineOperationTiming {
  const starts = [earlier?.startedAt, later.startedAt].filter((value): value is number => value !== undefined)
  return { ...later, startedAt: starts.length ? Math.min(...starts) : undefined }
}

export function timelineJobTiming(job: TimelineJobFailure | undefined) {
  if (!job) return undefined
  const variants = job.variants ?? []
  const variantStarts = variants.map((variant) => validTimestamp(variant.startedAt)).filter((value): value is number => value !== undefined)
  const variantEnds = variants.map((variant) => validTimestamp(variant.completedAt)).filter((value): value is number => value !== undefined)
  const startedAt = validTimestamp(job.startedAt) ?? (variantStarts.length ? Math.min(...variantStarts) : validTimestamp(job.createdAt))
  if (startedAt === undefined) return undefined
  const terminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
  const endedAt = terminal
    ? validTimestamp(job.completedAt) ?? (variantEnds.length ? Math.max(...variantEnds) : validTimestamp(job.updatedAt))
    : undefined
  return { startedAt, ...(endedAt !== undefined ? { endedAt } : {}) }
}

export function firstTimelineJobCreatedAt(
  branches: readonly { jobIds?: readonly string[] }[],
  jobs?: readonly TimelineJobFailure[],
) {
  const createdAt = branches.flatMap((branch) => branch.jobIds ?? [])
    .map((id) => jobs?.find((job) => job.id === id))
    .map((job) => validTimestamp(job?.createdAt))
    .filter((value): value is number => value !== undefined)
  return createdAt.length ? Math.min(...createdAt) : undefined
}
