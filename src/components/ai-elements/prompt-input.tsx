import { CornerDownLeftIcon, LoaderCircleIcon, SquareIcon } from 'lucide-react'
import { forwardRef } from 'react'
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  HTMLAttributes,
} from 'react'
import type { ChatStatus } from 'ai'
import { cn } from '@/components/ui/utils'

export type PromptInputProps = ComponentPropsWithoutRef<'form'>

export const PromptInput = forwardRef<HTMLFormElement, PromptInputProps>(function PromptInput(
  { className, ...props },
  ref,
) {
  return <form ref={ref} className={cn('ai-prompt-input', className)} {...props} />
})

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>

export function PromptInputBody({ className, ...props }: PromptInputBodyProps) {
  return <div className={cn('ai-prompt-input__body', className)} {...props} />
}

export type PromptInputTextareaProps = ComponentPropsWithoutRef<'textarea'>

export const PromptInputTextarea = forwardRef<HTMLTextAreaElement, PromptInputTextareaProps>(function PromptInputTextarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn('ai-prompt-input__textarea', className)} {...props} />
})

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>

export function PromptInputFooter({ className, ...props }: PromptInputFooterProps) {
  return <div className={cn('ai-prompt-input__footer', className)} {...props} />
}

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>

export function PromptInputTools({ className, ...props }: PromptInputToolsProps) {
  return <div className={cn('ai-prompt-input__tools', className)} {...props} />
}

export type PromptInputSubmitProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  status?: ChatStatus
  onStop?: () => void
}

export function PromptInputSubmit({
  status = 'ready',
  onStop,
  onClick,
  children,
  type,
  ...props
}: PromptInputSubmitProps) {
  const running = status === 'submitted' || status === 'streaming'
  return <button
    type={type ?? (running ? 'button' : 'submit')}
    onClick={running ? onStop : onClick}
    {...props}
  >
    {children ?? (status === 'submitted'
      ? <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
      : status === 'streaming'
        ? <SquareIcon aria-hidden="true" />
        : <CornerDownLeftIcon aria-hidden="true" />)}
  </button>
}
