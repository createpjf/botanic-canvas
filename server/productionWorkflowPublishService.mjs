// @ts-check
import {
  createProductionWorkflowVersion,
  resolveProductionWorkflowSource,
  resolveWorkflowBrandRules,
  resolveWorkflowExecutionContract,
} from './productionWorkflow.mjs'

/**
 * 生产工作流发布的唯一实现。
 *
 * 与分支重试同理：它有两个调用方（HTTP 路由与 Agent 运维工具），而发布会写进
 * **不可变版本**。两份实现只要有一处不同，就会出现「同一次发布在两条入口下固定了
 * 不同的执行契约」，而版本一旦写下就不能改。
 *
 * 校验放在 `updateProject` 的 mutate 回调内：那个回调每次冲突重试都会重新读取项目，
 * 因此并发修改无法在校验与写入之间把来源改掉（来源版本未漂移）。
 *
 * @typedef {{ kind: 'error', status: number, code: string, message: string }} PublishError
 * @typedef {{ kind: 'published', workflow: any }} PublishSuccess
 */

export function createProductionWorkflowPublishService({ productStore, updateProject }) {
  if (!productStore || typeof updateProject !== 'function') {
    throw new TypeError('工作流发布服务缺少 ProductStore 或项目写入器。')
  }

  /**
   * @param {{
   *   userId: string,
   *   projectId: string,
   *   id: string,
   *   name: string,
   *   definition: any,
   *   source: any,
   * }} input
   * @returns {Promise<PublishError | PublishSuccess>}
   */
  return async function publishProductionWorkflow({ userId, projectId, id, name, definition, source }) {
    let created
    try {
      const saved = await updateProject(userId, projectId, (document) => {
        const workflows = Array.isArray(document?.productionWorkflows) ? document.productionWorkflows : []
        const existing = workflows.find((workflow) => workflow.id === id)
        const resolvedSource = resolveProductionWorkflowSource(source, document)
        created = createProductionWorkflowVersion({
          id,
          projectId,
          name,
          // 品牌规则与执行契约都由服务端从权威文档派生，客户端提交的那一份被丢弃：
          // 它绕过激活过滤、也不带版本绑定（ADR 0006 / Epic 7）。
          definition: {
            ...definition,
            ...resolveWorkflowBrandRules(document),
            ...resolveWorkflowExecutionContract(resolvedSource, document),
          },
          source: resolvedSource,
          previous: existing,
        }, { actorId: userId })
        return {
          ...document,
          productionWorkflows: [...workflows.filter((workflow) => workflow.id !== created.id), created],
        }
      })
      if (!saved) return { kind: 'error', status: 404, code: 'PROJECT_NOT_FOUND', message: '未找到项目或你没有访问权限。' }
    } catch (caught) {
      const failure = /** @type {any} */ (caught)
      if (failure?.name !== 'ProductionWorkflowSourceError') throw caught
      return { kind: 'error', status: failure.statusCode ?? 409, code: failure.code, message: failure.message }
    }
    return { kind: 'published', workflow: created }
  }
}
