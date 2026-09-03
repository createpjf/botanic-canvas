import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import { CloseIcon, FileTextIcon, ImageIcon, SparkleIcon, WrenchIcon } from '../../components/BotanicIcons'
import { useProductI18n } from '../../i18n/react'
import type { AgentAttachmentCategory, AgentAttachmentData } from './agentWorkspace.types'

/**
 * Agent 面板统一附件家族（模式对齐 Vercel AI Elements Attachments：
 * grid / inline / list 三个 variant + Preview / Info / Remove / Empty 组合件）。
 * 只做展示投影；数据契约（AgentContextItem / BotanicAgentArtifact / Skill）不变。
 */

export {
  agentAttachmentCategory,
  attachmentFromArtifact,
  attachmentFromContextItem,
  attachmentFromSkill,
  type AgentAttachmentCategory,
  type AgentAttachmentData,
} from './agentWorkspace.types'

type AttachmentContextValue = { data: AgentAttachmentData; onRemove?: () => void; hasHoverPreview?: boolean }
const AttachmentContext = createContext<AttachmentContextValue | undefined>(undefined)
function useAttachment() {
  const value = useContext(AttachmentContext)
  if (!value) throw new Error('AgentAttachment 子组件必须放在 <AgentAttachment> 内。')
  return value
}

export function AgentAttachments({
  variant,
  children,
  ...props
}: { variant: 'grid' | 'inline' | 'list'; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`agent-attachments is-${variant}${props.className ? ` ${props.className}` : ''}`}>{children}</div>
}

function hasHoverPreviewChild(children: ReactNode): boolean {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child && typeof child === 'object' && 'type' in child && child.type === AgentAttachmentHoverPreview) return true
  }
  return false
}

export function AgentAttachment({
  data,
  onRemove,
  onActivate,
  selected,
  flipId,
  children,
  ...props
}: {
  data: AgentAttachmentData
  onRemove?: () => void
  /** 点击整卡（如图片选择器的勾选）；提供时整卡渲染为 button。 */
  onActivate?: () => void
  selected?: boolean
  /** 透传 data-flip-id 供 GSAP Flip 增删动效。 */
  flipId?: string
  children: ReactNode
} & React.HTMLAttributes<HTMLElement>) {
  const className = `agent-attachment is-${data.category}${selected ? ' is-selected' : ''}${props.className ? ` ${props.className}` : ''}`
  // 自带 hover 浮层时不再设原生 title，避免系统 tooltip 与浮层同时出现。
  const hoverPreview = hasHoverPreviewChild(children)
  const title = props.title ?? (hoverPreview ? undefined : data.content ? `${data.label}: ${data.content}` : data.label)
  const shared = { ...props, className, 'data-flip-id': flipId, title }
  return <AttachmentContext.Provider value={{ data, onRemove }}>
    {onActivate
      ? <button {...shared} type="button" aria-pressed={selected} onClick={onActivate}>{children}</button>
      : <div {...shared}>{children}</div>}
  </AttachmentContext.Provider>
}

const categoryIcon: Record<AgentAttachmentCategory, ReactNode> = {
  image: <ImageIcon />,
  video: <ImageIcon />,
  document: <FileTextIcon />,
  skill: <SparkleIcon />,
  'canvas-node': <WrenchIcon />,
}

export function AgentAttachmentPreview({ fallbackIcon, decorative = true }: { fallbackIcon?: ReactNode; decorative?: boolean } = {}) {
  const { data } = useAttachment()
  const label = decorative ? undefined : data.label
  if (data.image && data.category === 'video') return <video className="agent-attachment__preview" src={data.image} muted playsInline preload="metadata" aria-label={label} />
  if (data.image) return <img className="agent-attachment__preview" src={data.image} alt={label ?? ''} />
  return <span className="agent-attachment__preview is-icon" aria-hidden="true">{fallbackIcon ?? categoryIcon[data.category]}</span>
}

export function AgentAttachmentInfo({ showMediaType = false }: { showMediaType?: boolean } = {}) {
  const { data } = useAttachment()
  return <span className="agent-attachment__info">
    <b>{data.label}</b>
    {showMediaType && data.mediaType ? <small>{data.mediaType}</small> : null}
  </span>
}

export function AgentAttachmentRemove({ label }: { label?: string } = {}) {
  const { data, onRemove } = useAttachment()
  const { locale } = useProductI18n()
  if (!onRemove) return null
  const text = label ?? `${locale === 'en' ? 'Remove' : '移除'} ${data.label}`
  return <button
    type="button"
    className="agent-attachment__remove"
    aria-label={text}
    title={text}
    onClick={(event) => { event.stopPropagation(); onRemove() }}
  ><CloseIcon /></button>
}

/** inline chip 的悬停放大预览：纯 CSS 定位浮层，不引 HoverCard。 */
export function AgentAttachmentHoverPreview() {
  const { data } = useAttachment()
  if (!data.image && !data.content) return null
  return <span className="agent-attachment__hover" role="presentation">
    {data.image
      ? data.category === 'video'
        ? <video src={data.image} muted playsInline preload="metadata" />
        : <img src={data.image} alt="" />
      : <p>{data.content}</p>}
    <b>{data.label}</b>
  </span>
}

export function AgentAttachmentEmpty({ children }: { children: ReactNode }) {
  return <p className="agent-attachment__empty">{children}</p>
}
