import { BotanicSelect, type BotanicSelectOption } from '@/components/BotanicSelect'
import { cn } from '@/components/ui/utils'
import type { ComponentProps, ReactNode } from 'react'

export type ModelSelectorProps = Omit<ComponentProps<typeof BotanicSelect>, 'className'> & { className?: string; label?: ReactNode }

/** 保留 Botanic Select 的键盘、portal 与品牌图标能力，只增加 Elements 的语义包装。 */
export function ModelSelector({ className, label, ...props }: ModelSelectorProps) {
  return <span data-slot="model-selector" className={cn('ai-model-selector', className)} aria-label={typeof label === 'string' ? label : undefined}>
    <BotanicSelect {...props} className="ai-model-selector__select" />
  </span>
}

export function ModelSelectorName({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="model-selector-name" className={cn('ai-model-selector__name', className)} {...props} />
}

export function ModelSelectorLogo({ provider, className, ...props }: Omit<ComponentProps<'img'>, 'src' | 'alt'> & { provider: string }) {
  return <img data-slot="model-selector-logo" src={`https://models.dev/logos/${provider}.svg`} alt={`${provider} logo`} className={cn('ai-model-selector__logo', className)} {...props} />
}

export type { BotanicSelectOption }
