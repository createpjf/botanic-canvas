import type { FileUIPart, SourceDocumentUIPart } from 'ai'
import { FileTextIcon, GlobeIcon, ImageIcon, Music2Icon, PaperclipIcon, VideoIcon, XIcon } from 'lucide-react'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { createContext, useContext, useMemo } from 'react'
import { cn } from '@/components/ui/utils'

export type AttachmentData = (FileUIPart & { id: string }) | (SourceDocumentUIPart & { id: string })
export type AttachmentMediaCategory = 'image' | 'video' | 'audio' | 'document' | 'source' | 'unknown'
export type AttachmentVariant = 'grid' | 'inline' | 'list'

export function getMediaCategory(data: AttachmentData): AttachmentMediaCategory {
  if (data.type === 'source-document') return 'source'
  const mediaType = data.mediaType ?? ''
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('video/')) return 'video'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType.startsWith('application/') || mediaType.startsWith('text/')) return 'document'
  return 'unknown'
}

export function getAttachmentLabel(data: AttachmentData) {
  if (data.type === 'source-document') return data.title || data.filename || 'Source'
  return data.filename || (getMediaCategory(data) === 'image' ? 'Image' : 'Attachment')
}

const icons = { audio: Music2Icon, document: FileTextIcon, image: ImageIcon, source: GlobeIcon, unknown: PaperclipIcon, video: VideoIcon }
const AttachmentsState = createContext<AttachmentVariant>('grid')
const AttachmentState = createContext<{ data: AttachmentData; category: AttachmentMediaCategory; onRemove?: () => void; variant: AttachmentVariant } | null>(null)

function useAttachment() {
  const value = useContext(AttachmentState)
  if (!value) throw new Error('Attachment components must be used within <Attachment>.')
  return value
}

export function Attachments({ variant = 'grid', className, ...props }: HTMLAttributes<HTMLDivElement> & { variant?: AttachmentVariant }) {
  return <AttachmentsState.Provider value={variant}><div data-slot="attachments" className={cn('ai-attachments', `is-${variant}`, className)} {...props} /></AttachmentsState.Provider>
}

export function Attachment({ data, onRemove, className, ...props }: HTMLAttributes<HTMLDivElement> & { data: AttachmentData; onRemove?: () => void }) {
  const variant = useContext(AttachmentsState)
  const category = getMediaCategory(data)
  const value = useMemo(() => ({ data, category, onRemove, variant }), [category, data, onRemove, variant])
  return <AttachmentState.Provider value={value}><div data-slot="attachment" className={cn('ai-attachment', `is-${variant}`, className)} {...props} /></AttachmentState.Provider>
}

export function AttachmentPreview({ fallbackIcon, className, ...props }: HTMLAttributes<HTMLDivElement> & { fallbackIcon?: ReactNode }) {
  const { data, category, variant } = useAttachment()
  const Icon = icons[category]
  const url = data.type === 'file' ? data.url : undefined
  return <div data-slot="attachment-preview" className={cn('ai-attachment__preview', `is-${variant}`, className)} {...props}>
    {category === 'image' && url ? <img src={url} alt={getAttachmentLabel(data)} /> : category === 'video' && url ? <video src={url} muted playsInline preload="metadata" aria-label={getAttachmentLabel(data)} /> : fallbackIcon ?? <Icon aria-hidden="true" />}
  </div>
}

export function AttachmentInfo({ showMediaType = false, className, ...props }: HTMLAttributes<HTMLDivElement> & { showMediaType?: boolean }) {
  const { data, variant } = useAttachment()
  if (variant === 'grid') return null
  return <div data-slot="attachment-info" className={cn('ai-attachment__info', className)} {...props}><span>{getAttachmentLabel(data)}</span>{showMediaType && data.mediaType ? <small>{data.mediaType}</small> : null}</div>
}

export function AttachmentRemove({ label = 'Remove', className, ...props }: ComponentProps<'button'> & { label?: string }) {
  const { onRemove } = useAttachment()
  if (!onRemove) return null
  return <button type="button" data-slot="attachment-remove" className={cn('ai-attachment__remove', className)} aria-label={label} {...props} onClick={(event) => { event.stopPropagation(); onRemove(); }}><XIcon aria-hidden="true" /></button>
}

export function AttachmentEmpty({ children = 'No attachments', className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="attachment-empty" className={cn('ai-attachment__empty', className)} {...props}>{children}</div>
}
