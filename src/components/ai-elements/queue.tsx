import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/components/ui/utils'
import { ChevronDownIcon, PaperclipIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

export function Queue({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="queue" className={cn('ai-queue', className)} {...props} />
}

export function QueueSection({ className, defaultOpen = true, ...props }: ComponentProps<typeof Collapsible>) {
  return <Collapsible data-slot="queue-section" className={cn('ai-queue__section', className)} defaultOpen={defaultOpen} {...props} />
}

export function QueueSectionTrigger({ className, children, ...props }: ComponentProps<'button'>) {
  return <CollapsibleTrigger asChild>
    <button type="button" data-slot="queue-section-trigger" className={cn('ai-queue__section-trigger', className)} {...props}>{children}</button>
  </CollapsibleTrigger>
}

export function QueueSectionLabel({ className, count, label, icon, ...props }: ComponentProps<'span'> & { count?: number; label: string; icon?: ReactNode }) {
  return <span className={cn('ai-queue__section-label', className)} {...props}>
    <ChevronDownIcon aria-hidden="true" />{icon}<span>{count === undefined ? label : `${count} ${label}`}</span>
  </span>
}

export function QueueSectionContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent data-slot="queue-section-content" className={cn('ai-queue__section-content', className)} {...props} />
}

export function QueueList({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="queue-list" className={cn('ai-queue__list', className)} {...props} />
}

export function QueueItem({ className, ...props }: ComponentProps<'li'>) {
  return <li data-slot="queue-item" className={cn('ai-queue__item', className)} {...props} />
}

export function QueueItemIndicator({ completed = false, className, ...props }: ComponentProps<'span'> & { completed?: boolean }) {
  return <span data-slot="queue-item-indicator" aria-hidden="true" className={cn('ai-queue__indicator', completed && 'is-completed', className)} {...props} />
}

export function QueueItemContent({ completed = false, className, ...props }: ComponentProps<'span'> & { completed?: boolean }) {
  return <span data-slot="queue-item-content" className={cn('ai-queue__item-content', completed && 'is-completed', className)} {...props} />
}

export function QueueItemDescription({ completed = false, className, ...props }: ComponentProps<'div'> & { completed?: boolean }) {
  return <div data-slot="queue-item-description" className={cn('ai-queue__item-description', completed && 'is-completed', className)} {...props} />
}

export function QueueItemActions({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="queue-item-actions" className={cn('ai-queue__item-actions', className)} {...props} />
}

export function QueueItemAction({ className, ...props }: ComponentProps<'button'>) {
  return <button type="button" data-slot="queue-item-action" className={cn('ai-queue__item-action', className)} {...props} />
}

export function QueueItemFile({ children, className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="queue-item-file" className={cn('ai-queue__file', className)} {...props}><PaperclipIcon aria-hidden="true" />{children}</span>
}
