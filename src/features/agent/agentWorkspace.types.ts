import type { BotanicAgentArtifact, BotanicAgentSkillCatalogItem, BotanicIndexedArtifact } from '../../domain/agent'
import type { AssetRole, AssetSource, GenerationMediaKind, GenerationRecipe } from '../../domain/canvas'

export type AgentDockTarget = {
  id: string
  label: string
  image: string
  rootRecipe: GenerationRecipe
}

export function isMediaArtifact(artifact: Pick<BotanicAgentArtifact, 'kind' | 'url'>) {
  return artifact.kind === 'image' || artifact.kind === 'video'
}

export type AgentArtifactIndexState = {
  projectId: string
  artifacts: BotanicIndexedArtifact[]
  nextBefore?: string
  status: 'idle' | 'loading' | 'loading-more' | 'ready' | 'error' | 'error-more'
}

export function agentArtifactIndexNextPage(index: AgentArtifactIndexState): { before?: string } | null {
  if (index.status === 'error') return {}
  if ((index.status === 'ready' || index.status === 'error-more') && index.nextBefore !== undefined) return { before: index.nextBefore }
  return null
}

/** 合并一页历史索引；游标属于本次读取，不从缓存数量推断历史是否穷尽。 */
export function mergeAgentArtifactIndexPage(
  current: AgentArtifactIndexState,
  page: { artifacts: BotanicIndexedArtifact[]; nextBefore?: string },
): AgentArtifactIndexState {
  const merged = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]))
  for (const artifact of page.artifacts) {
    const previous = merged.get(artifact.id)
    if (!previous || artifact.updatedAt >= previous.updatedAt) merged.set(artifact.id, artifact)
  }
  return { ...current, artifacts: [...merged.values()], nextBefore: page.nextBefore, status: 'ready' }
}

export type AgentContextItem = {
  id: string
  label: string
  kind: '素材' | '结果' | '文字' | '节点'
  /** 文字节点的正文；进入计划时作为补充描述拼进提示词。 */
  content?: string
  image?: string
  assetId?: string
  role?: AssetRole
  mediaKind?: GenerationMediaKind
  source?: AssetSource
}

export type AgentSkillOption = Pick<BotanicAgentSkillCatalogItem, 'id' | 'name' | 'source'>

// —— Agent 附件家族的数据投影（模式对齐 AI Elements getMediaCategory）。纯函数，供组件与测试共用。 ——

export type AgentAttachmentCategory = 'image' | 'video' | 'document' | 'skill' | 'canvas-node'

export type AgentAttachmentData = {
  id: string
  label: string
  category: AgentAttachmentCategory
  image?: string
  /** list variant 的次行说明（媒体类型 / 节点类别）。 */
  mediaType?: string
  /** hover 预览与 title 的补充正文（如文字节点内容）。 */
  content?: string
}

/** 类别只由媒体与语义派生，不看文件名。 */
export function agentAttachmentCategory(input: { kind?: string; mediaKind?: string; image?: string }): AgentAttachmentCategory {
  if (input.mediaKind === 'video') return 'video'
  if (input.image) return 'image'
  if (input.kind === '文字') return 'document'
  return 'canvas-node'
}

/** content 只做摘要展示（title / hover 浮层）：截断，不塞整篇文字节点正文。 */
const attachmentContentLimit = 240
const clipAttachmentContent = (content?: string) => {
  const text = content?.trim()
  if (!text) return undefined
  return text.length > attachmentContentLimit ? `${text.slice(0, attachmentContentLimit - 1)}…` : text
}

export function attachmentFromContextItem(item: Pick<AgentContextItem, 'id' | 'label' | 'kind' | 'image' | 'mediaKind' | 'content'>): AgentAttachmentData {
  const content = clipAttachmentContent(item.content)
  return {
    id: item.id,
    label: item.label,
    category: agentAttachmentCategory(item),
    ...(item.image ? { image: item.image } : {}),
    mediaType: item.kind,
    ...(content ? { content } : {}),
  }
}

export function attachmentFromSkill(skill: AgentSkillOption): AgentAttachmentData {
  return { id: skill.id, label: skill.name, category: 'skill' }
}

export function attachmentFromArtifact(artifact: Pick<BotanicAgentArtifact, 'id' | 'label' | 'kind' | 'url' | 'content'>): AgentAttachmentData {
  const category: AgentAttachmentCategory = artifact.kind === 'image' ? 'image' : artifact.kind === 'video' ? 'video' : 'document'
  const content = clipAttachmentContent(artifact.content)
  return {
    id: artifact.id,
    label: artifact.label,
    category,
    ...(artifact.url && (category === 'image' || category === 'video') ? { image: artifact.url } : {}),
    mediaType: artifact.kind,
    ...(content ? { content } : {}),
  }
}
