import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/components/ui/utils'
import { ChevronDownIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { createContext, useContext, useMemo } from 'react'
import { Shimmer } from './shimmer'

type PlanContextValue = { isStreaming: boolean }
const PlanContext = createContext<PlanContextValue | null>(null)

function usePlan() {
  const context = useContext(PlanContext)
  if (!context) throw new Error('Plan components must be used within <Plan>.')
  return context
}

export type PlanProps = ComponentProps<typeof Collapsible> & { isStreaming?: boolean }

export function Plan({ className, isStreaming = false, children, ...props }: PlanProps) {
  const value = useMemo(() => ({ isStreaming }), [isStreaming])
  return <PlanContext.Provider value={value}>
    <Collapsible data-slot="plan" className={cn('ai-plan', className)} {...props}>{children}</Collapsible>
  </PlanContext.Provider>
}

export function PlanHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="plan-header" className={cn('ai-plan__header', className)} {...props} />
}

export function PlanTitle({ className, children, ...props }: ComponentProps<'h3'> & { children?: ReactNode }) {
  const { isStreaming } = usePlan()
  return <h3 data-slot="plan-title" className={cn('ai-plan__title', className)} {...props}>{isStreaming && typeof children === 'string' ? <Shimmer as="span" className="ai-plan__shimmer">{children}</Shimmer> : children}</h3>
}

export function PlanDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="plan-description" className={cn('ai-plan__description', className)} {...props} />
}

export function PlanAction({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="plan-action" className={cn('ai-plan__action', className)} {...props} />
}

export function PlanContent({ className, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return <CollapsibleContent data-slot="plan-content" className={cn('ai-plan__content', className)} {...props} />
}

export function PlanFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="plan-footer" className={cn('ai-plan__footer', className)} {...props} />
}

export function PlanTrigger({ className, children, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return <CollapsibleTrigger asChild>
    <button type="button" data-slot="plan-trigger" className={cn('ai-plan__trigger', className)} aria-label="Toggle plan" {...props}>
      {children ?? <ChevronDownIcon aria-hidden="true" />}
    </button>
  </CollapsibleTrigger>
}
