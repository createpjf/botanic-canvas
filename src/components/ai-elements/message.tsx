import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import type { ComponentProps } from 'react'
import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { cn } from '@/components/ui/utils'

export type MessageResponseProps = ComponentProps<typeof Streamdown>

const streamdownPlugins = { cjk, code }

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => <Streamdown
    className={cn('w-full', className)}
    plugins={streamdownPlugins}
    {...props}
  />,
)

MessageResponse.displayName = 'MessageResponse'
