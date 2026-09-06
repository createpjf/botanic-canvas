import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { cn } from '@/components/ui/utils'

/**
 * Conversation is the presentational shell for a Botanic-owned message viewport.
 * Scroll position, reading anchors and pagination stay with AgentWorkspace.
 */
export const Conversation = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function Conversation(
  { className, ...props },
  ref,
) {
  return <div ref={ref} data-slot="conversation" className={cn('ai-conversation', className)} {...props} />
})

Conversation.displayName = 'Conversation'

export function ConversationContent({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="conversation-content" className={cn('ai-conversation__content', className)} {...props} />
}

export function ConversationEmptyState({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="conversation-empty-state" className={cn('ai-conversation__empty', className)} {...props} />
}

export const ConversationScrollButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(function ConversationScrollButton(
  { className, ...props },
  ref,
) {
  return <button ref={ref} data-slot="conversation-scroll-button" className={cn('ai-conversation__scroll-button', className)} {...props} />
})

ConversationScrollButton.displayName = 'ConversationScrollButton'
