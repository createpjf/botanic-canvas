import { cn } from '@/components/ui/utils'
import { ExternalLinkIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

export function isSafeWebPreviewUrl(value?: string) {
  if (!value || value.length > 2048) return false
  if (value.startsWith('/api/media/')) return true
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

export function WebPreview({ className, title, url, children, ...props }: ComponentProps<'section'> & { title?: string; url?: string }) {
  return <section data-slot="web-preview" className={cn('ai-web-preview', className)} {...props}>
    {children ?? <><WebPreviewNavigation><WebPreviewUrl url={url} title={title} /></WebPreviewNavigation><WebPreviewBody title={title} url={url} /></>}
  </section>
}

export function WebPreviewNavigation({ className, ...props }: ComponentProps<'header'>) {
  return <header data-slot="web-preview-navigation" className={cn('ai-web-preview__navigation', className)} {...props} />
}

export function WebPreviewUrl({ className, url, title, ...props }: ComponentProps<'a'> & { url?: string; title?: string }) {
  const safe = isSafeWebPreviewUrl(url)
  return safe ? <a data-slot="web-preview-url" className={cn('ai-web-preview__url', className)} href={url} target="_blank" rel="noreferrer" {...props}>{title ?? url}<ExternalLinkIcon aria-hidden="true" /></a> : <span data-slot="web-preview-url" className={cn('ai-web-preview__url is-unavailable', className)} {...props}>{title ?? 'Preview unavailable'}</span>
}

export function WebPreviewBody({ className, children, url, title, ...props }: ComponentProps<'div'> & { url?: string; title?: string }) {
  return <div data-slot="web-preview-body" className={cn('ai-web-preview__body', className)} {...props}>{children ?? <><span aria-hidden="true">↗</span><strong>{title ?? url ?? 'Preview unavailable'}</strong></>}</div>
}

export function WebPreviewEmpty({ children = 'No preview available', className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="web-preview-empty" className={cn('ai-web-preview__empty', className)} {...props}>{children}</p>
}
