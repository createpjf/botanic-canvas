import type { CollaborationActivity } from '../domain/collaborationActivity'
import { productRequest } from './productSession'

export async function listProjectCollaborationActivities(
  projectId: string,
  options: { limit?: number; before?: string } = {},
) {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.before) query.set('before', options.before)
  const suffix = query.size ? `?${query.toString()}` : ''
  return productRequest<{ activities: CollaborationActivity[]; nextBefore?: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/collaboration-activities${suffix}`,
  )
}

export async function updateProjectCollaborationActivityReceipt(projectId: string, action: 'read' | 'clear') {
  return productRequest<{ receipt: { readAt: number; clearedAt: number; updatedAt: number } }>(
    `/api/projects/${encodeURIComponent(projectId)}/collaboration-activity-receipt`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    },
  )
}
