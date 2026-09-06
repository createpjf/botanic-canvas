import { Button } from '@/components/ui/button'
import { cn } from '@/components/ui/utils'
import type { ComponentProps } from 'react'

export function Suggestions({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="suggestions" className={cn('ai-suggestions', className)} {...props} />
}

export function Suggestion({ suggestion, onClick, className, children, ...props }: Omit<ComponentProps<typeof Button>, 'onClick'> & { suggestion: string; onClick?: (suggestion: string) => void }) {
  return <Button data-slot="suggestion" type="button" variant="outline" className={cn('ai-suggestion', className)} onClick={() => onClick?.(suggestion)} {...props}>{children ?? suggestion}</Button>
}
