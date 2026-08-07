import type { CollaborationActivity } from '../domain/collaborationActivity'
import { productRequest } from './productSession'

export async function listProjectCollaborationActivities(projectId: string) {
  return productRequest<{ activities: CollaborationActivity[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/collaboration-activities`,
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
