"use client"

import { Popover as PopoverPrimitive } from 'radix-ui'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/utils'
import type { ComponentProps } from 'react'

function sourceHostname(source: string) {
  try {
    return new URL(source).hostname
  } catch {
    return source
  }
}

export function InlineCitation({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="inline-citation" className={cn('ai-inline-citation', className)} {...props} />
}

export function InlineCitationText({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="inline-citation-text" className={cn('ai-inline-citation__text', className)} {...props} />
}

export type InlineCitationCardProps = ComponentProps<typeof PopoverPrimitive.Root>

export function InlineCitationCard({ ...props }: InlineCitationCardProps) {
  return <PopoverPrimitive.Root {...props} />
}

export type InlineCitationCardTriggerProps = ComponentProps<typeof Badge> & { sources?: string[] }

export function InlineCitationCardTrigger({
  sources = [],
  className,
  children,
  variant = 'secondary',
  asChild: _asChild,
  ref: _ref,
  ...props
}: InlineCitationCardTriggerProps) {
  const hostnames = sources.map(sourceHostname)
  return <PopoverPrimitive.Trigger asChild>
    <Badge asChild variant={variant} className={cn('ai-inline-citation__trigger', className)}>
      <button type="button" data-slot="inline-citation-trigger" {...props}>
        {children ?? <>{hostnames[0] ?? 'source'}{sources.length > 1 ? ` +${sources.length - 1}` : ''}</>}
      </button>
    </Badge>
  </PopoverPrimitive.Trigger>
}

export type InlineCitationCardBodyProps = ComponentProps<typeof PopoverPrimitive.Content> & { closeLabel?: string }

export function InlineCitationCardBody({ className, sideOffset = 6, closeLabel = 'Close', children, ...props }: InlineCitationCardBodyProps) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      data-slot="inline-citation-body"
      sideOffset={sideOffset}
      className={cn('ai-inline-citation__body', className)}
      {...props}
    >
      {children}
      <PopoverPrimitive.Close className="ai-inline-citation__close" aria-label={closeLabel}>{closeLabel}</PopoverPrimitive.Close>
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
}

export function InlineCitationSource({ title, url, description, className, ...props }: ComponentProps<'div'> & { title?: string; url?: string; description?: string }) {
  const safeUrl = (() => {
    if (!url) return undefined
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (!parsed.port || parsed.port === '443')
        ? parsed.href
        : undefined
    } catch {
      return undefined
    }
  })()
  return <div data-slot="inline-citation-source" className={cn('ai-inline-citation__source', className)} {...props}>
    {title ? <strong>{title}</strong> : null}
    {url ? safeUrl ? <a href={safeUrl} target="_blank" rel="noopener noreferrer">{url}</a> : <small>{url}</small> : null}
    {description ? <p>{description}</p> : null}
  </div>
}

export function InlineCitationQuote({ className, ...props }: ComponentProps<'blockquote'>) {
  return <blockquote data-slot="inline-citation-quote" className={cn('ai-inline-citation__quote', className)} {...props} />
}
