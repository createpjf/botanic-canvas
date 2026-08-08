import type {
  ProductionWorkflow,
  ProductionWorkflowDefinition,
  ProductionWorkflowRun,
} from '../domain/canvas'
import { productRequest } from './productSession'

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/production-workflows`
const workflowPath = (projectId: string, workflowId: string) => `${projectPath(projectId)}/${encodeURIComponent(workflowId)}`
const runsPath = (projectId: string, workflowId: string) => `${workflowPath(projectId, workflowId)}/runs`
const runPath = (projectId: string, runId: string) => `/api/projects/${encodeURIComponent(projectId)}/production-workflow-runs/${encodeURIComponent(runId)}`

export async function listProductionWorkflows(projectId: string) {
  return (await productRequest<{ workflows: ProductionWorkflow[] }>(projectPath(projectId))).workflows
}

export async function publishProductionWorkflow(input: {
  projectId: string
  id: string
  name: string
  definition: ProductionWorkflowDefinition
}) {
  return (await productRequest<{ workflow: ProductionWorkflow }>(projectPath(input.projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: input.id, name: input.name, definition: input.definition }),
  })).workflow
}

export async function readProductionWorkflow(projectId: string, workflowId: string) {
  return (await productRequest<{ workflow: ProductionWorkflow }>(workflowPath(projectId, workflowId))).workflow
}

export async function listProductionWorkflowRuns(projectId: string, workflowId: string) {
  return (await productRequest<{ runs: ProductionWorkflowRun[] }>(runsPath(projectId, workflowId))).runs
}

export async function startProductionWorkflowRun(input: {
  projectId: string
  workflowId: string
  id: string
  workflowVersion: number
  items: Array<Record<string, unknown> & { id: string }>
}) {
  return (await productRequest<{ run: ProductionWorkflowRun; reused?: boolean }>(runsPath(input.projectId, input.workflowId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: input.id, workflowVersion: input.workflowVersion, items: input.items }),
  }))
}

export async function readProductionWorkflowRun(projectId: string, runId: string) {
  return (await productRequest<{ run: ProductionWorkflowRun }>(runPath(projectId, runId))).run
}

export async function updateProductionWorkflowRun(
  projectId: string,
  runId: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry-failed',
) {
  return (await productRequest<{ run: ProductionWorkflowRun }>(runPath(projectId, runId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })).run
}
