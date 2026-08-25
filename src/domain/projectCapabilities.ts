import type { ProductLocale } from '../i18n/core'

/**
 * 项目能力模型（Epic 10）。
 *
 * 服务端随项目读模型下发**调用者在本项目的能力集合**。此前客户端只知道工作区角色
 * （owner/member），完全不知道自己在某个项目里是不是 viewer —— 因此没有依据去隐藏
 * 点不动的入口，Viewer 会看到「生成」「发布 Skill」「决定评审」这些按钮，点下去才 403。
 *
 * 两条边界，都不能松：
 *
 * - **拿能力，不拿角色。** 界面若拿到角色再自己映射一遍权限，就出现了第二份权威；
 *   两份映射迟早漂移，表现是「按钮显示了但一点就 403」，或更糟的「该藏的没藏」。
 * - **隐藏不是鉴权。** 服务端始终是唯一的鉴权边界。这里只决定给不给看，
 *   任何「反正界面藏了」的推论都是错的 —— 请求可以手工构造。
 */

/** 与服务端 `projectPermissions` 同一份词表。两边不一致会让能力判断变得不可信。 */
export const PROJECT_CAPABILITIES = [
  'read',
  'edit',
  'create-generation',
  'delete-content',
  'modify-workflow',
  'execute-external-tool',
  'manage-members',
  'delete-project',
  'read-audit',
  'read-operational',
] as const

export type ProjectCapability = typeof PROJECT_CAPABILITIES[number]

/**
 * 能力集合尚未取到时的**保守缺省**。
 *
 * 缺省成「什么都能做」会让一次读取失败变成越权入口全部显示；缺省成「什么都不能做」
 * 又会让正常用户在加载期间看到一个空工作台。折中是只给 `read` —— 能看，不能改。
 */
export const FALLBACK_PROJECT_CAPABILITIES: ProjectCapability[] = ['read']

export function hasProjectCapability(
  capabilities: readonly string[] | undefined,
  capability: ProjectCapability,
) {
  return (capabilities ?? FALLBACK_PROJECT_CAPABILITIES).includes(capability)
}

/**
 * 界面入口 → 它需要的能力。
 *
 * 声明式：新增一个受限入口必须同时说明它要哪个能力。散落在组件里各写各的判断，
 * 迟早出现「这个按钮忘了判」。取值与服务端 `agentActionGovernance` 的权限表对应 ——
 * 那里决定放不放行，这里决定给不给看，两者必须指向同一个能力。
 */
export const PROJECT_ENTRY_CAPABILITY = {
  /** 提交生成任务（会产生费用）。 */
  submitGeneration: 'create-generation',
  /** 发布 / 修改项目 Skill。与服务端 `skill_create` / `skill_apply` 同一能力。 */
  publishSkill: 'modify-workflow',
  /** 对评审候选做人工决定。与服务端 `review_decide` 同一能力。 */
  decideReview: 'edit',
  /** 发布或修改生产工作流。与服务端 `workflow_publish` / `workflow_create` 同一能力。 */
  modifyWorkflow: 'modify-workflow',
  /** 编辑画布内容。 */
  editCanvas: 'edit',
  /** 删除画布内容。 */
  deleteContent: 'delete-content',
  /** 调用外部 MCP 工具。 */
  runExternalTool: 'execute-external-tool',
  /** 管理项目成员。 */
  manageMembers: 'manage-members',
} as const satisfies Record<string, ProjectCapability>

export type ProjectEntry = keyof typeof PROJECT_ENTRY_CAPABILITY

/** 某个界面入口是否该显示。 */
export function canUseProjectEntry(capabilities: readonly string[] | undefined, entry: ProjectEntry) {
  return hasProjectCapability(capabilities, PROJECT_ENTRY_CAPABILITY[entry])
}

/**
 * 只读用户：能看但什么都改不了。
 *
 * 单独给出来是因为界面需要一处**整体提示**。逐个按钮消失而不解释原因，用户只会以为
 * 功能坏了 —— 「你对这个项目只有查看权限」是一句必须说出口的话。
 */
export function isReadOnlyProject(capabilities: readonly string[] | undefined) {
  const resolved = capabilities ?? FALLBACK_PROJECT_CAPABILITIES
  return resolved.includes('read') && !resolved.includes('edit')
}

/**
 * 只读提示文案。
 *
 * 必须说清**为什么**看不到那些入口，而不是只说「无权限」——后者读起来像出错了。
 */
export function readOnlyProjectNotice(locale: ProductLocale = 'zh-CN') {
  return locale === 'en'
    ? 'You have view-only access to this project. Generation, workflow, Skill and review actions are hidden because they are not available to you.'
    : '你对该项目只有查看权限。生成、工作流、Skill 与评审决定的入口已隐藏，因为你无法执行它们。'
}
