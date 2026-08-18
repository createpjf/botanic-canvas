import type { BotanicAgentSkillCatalogItem, BotanicIndexedArtifact } from '../../domain/agent'
import type { AssetRole, AssetSource, GenerationMediaKind, GenerationRecipe } from '../../domain/canvas'

export type AgentDockTarget = {
  id: string
  label: string
  image: string
  rootRecipe: GenerationRecipe
}

export type AgentArtifactIndexState = {
  projectId: string
  artifacts: BotanicIndexedArtifact[]
  nextBefore?: string
  status: 'idle' | 'loading' | 'loading-more' | 'ready' | 'error'
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
