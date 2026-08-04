export type ProjectOperationDisposition = 'apply' | 'detached' | 'superseded'

export function projectOperationDisposition({
  originProjectId,
  activeProjectId,
  requestId,
  latestRequestId,
}: {
  originProjectId: string
  activeProjectId: string
  requestId: number
  latestRequestId: number
}): ProjectOperationDisposition {
  if (originProjectId !== activeProjectId) return 'detached'
  if (requestId !== latestRequestId) return 'superseded'
  return 'apply'
}
