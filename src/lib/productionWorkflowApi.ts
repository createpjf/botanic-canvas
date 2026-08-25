import type {
  ProductionWorkflow,
  ProductionWorkflowDefinition,
  ProductionWorkflowRun,
  ProductionWorkflowSource,
} from '../domain/canvas'
import { productAuthorizationHeader, productRequest } from './productSession'

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
  /** 发布来源必须显式提交；服务端按项目权威文档校验归属后才写入版本。 */
  source: ProductionWorkflowSource
}) {
  return (await productRequest<{ workflow: ProductionWorkflow }>(projectPath(input.projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: input.id, name: input.name, definition: input.definition, source: input.source }),
  })).workflow
}

export async function readProductionWorkflow(projectId: string, workflowId: string) {
  return (await productRequest<{ workflow: ProductionWorkflow }>(workflowPath(projectId, workflowId))).workflow
}

export async function listProductionWorkflowRuns(projectId: string, workflowId: string) {
  return (await productRequest<{ runs: ProductionWorkflowRun[] }>(runsPath(projectId, workflowId))).runs
}

/**
 * 启动批量运行。
 *
 * `items` 允许不带 `id`：服务端按业务身份（SKU → 渠道 → 语言）派生项标识，
 * 取不到才退回位置。位置标识在重排或补项之后会指向另一行，重试就会打到错误的项上。
 */
export async function startProductionWorkflowRun(input: {
  projectId: string
  workflowId: string
  id: string
  workflowVersion: number
  items: Array<Record<string, unknown> & { id?: string }>
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

/**
 * 下载交付包（Epic 7）。
 *
 * 不走 `productRequest`：那条路径按 JSON 解析响应，而这里是 zip 字节流。
 *
 * 用 blob 而不是直接把地址交给浏览器：下载需要带鉴权头，`<a download>` 发不出
 * 自定义头。代价是整包先进内存 —— 对交付包（几十 MB 到几 GB）是真实成本，因此
 * 失败时**照实抛错**而不是退回一个打不开的链接：一个下载了一半的 zip 解压时才
 * 报错，比当场失败难查得多。
 */
export async function downloadProductionWorkflowRunPackage(projectId: string, runId: string) {
  const headers = new Headers({ Accept: 'application/zip' })
  for (const [key, value] of Object.entries(await productAuthorizationHeader())) headers.set(key, value)
  const response = await fetch(`${runPath(projectId, runId)}/package`, { credentials: 'include', headers })
  if (!response.ok) {
    // 服务端在写第一个字节之前就把清单级问题（无已批准候选、文件名冲突）报出来，
    // 因此这里拿到的是可读的错误，而不是一个截断的包。
    const detail = await response.json().catch(() => undefined)
    const error = new Error(detail?.error?.message ?? '交付包下载失败。')
    Object.assign(error, { code: detail?.error?.code ?? 'DELIVERY_PACKAGE_FAILED' })
    throw error
  }
  const blob = await response.blob()
  const fileName = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1]
    ?? `delivery-${runId}.zip`
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  return { fileName, byteSize: blob.size }
}
