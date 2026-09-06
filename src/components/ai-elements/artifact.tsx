import { cn } from '@/components/ui/utils'
import { XIcon } from 'lucide-react'
import type { ComponentProps, ComponentType } from 'react'

export function Artifact({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="artifact" className={cn('ai-artifact', className)} {...props} />
}

export function ArtifactHeader({ className, ...props }: ComponentProps<'header'>) {
  return <header data-slot="artifact-header" className={cn('ai-artifact__header', className)} {...props} />
}

export function ArtifactTitle({ className, ...props }: ComponentProps<'h4'>) {
  return <h4 data-slot="artifact-title" className={cn('ai-artifact__title', className)} {...props} />
}

export function ArtifactDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="artifact-description" className={cn('ai-artifact__description', className)} {...props} />
}

export function ArtifactActions({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="artifact-actions" className={cn('ai-artifact__actions', className)} {...props} />
}

export function ArtifactAction({ icon: Icon, label, className, children, ...props }: ComponentProps<'button'> & { icon?: ComponentType<{ className?: string }>; label?: string }) {
  return <button type="button" data-slot="artifact-action" className={cn('ai-artifact__action', className)} aria-label={label} title={label} {...props}>{Icon ? <Icon className="ai-artifact__action-icon" /> : children}</button>
}

export function ArtifactClose({ className, children, ...props }: ComponentProps<'button'>) {
  return <button type="button" data-slot="artifact-close" className={cn('ai-artifact__action', className)} aria-label="Close" {...props}>{children ?? <XIcon aria-hidden="true" />}</button>
}

export function ArtifactContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="artifact-content" className={cn('ai-artifact__content', className)} {...props} />
}
