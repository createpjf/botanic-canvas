import type { ProductLocale } from '../i18n/core'

export type CanvasDocumentLifecycleNotice =
  | 'opened'
  | 'created'
  | 'synced'
  | 'renaming'
  | 'renamed'
  | 'renameFailed'

function canvasDocumentLifecycleCopy(locale: ProductLocale) {
  return locale === 'en'
    ? {
      opened: (name: string) => `Opened “${name}”.`,
      created: (name: string) => `“${name}” created. Start from assets or a brief.`,
      synced: 'Synced from another device.',
      renaming: (name: string) => `Renaming to “${name}”…`,
      renamed: (name: string) => `Renamed to “${name}”.`,
      renameFailed: 'Couldn’t rename. Check the connection and retry.',
    }
    : {
      opened: (name: string) => `已打开「${name}」。`,
      created: (name: string) => `「${name}」已创建，可以从素材或一句话开始。`,
      synced: '已同步其他设备的更新。',
      renaming: (name: string) => `正在重命名为「${name}」。`,
      renamed: (name: string) => `项目已重命名为「${name}」。`,
      renameFailed: '项目重命名失败，请检查网络后重试。',
    }
}

/** 项目打开、创建、同步与重命名写给画布助手的本地化说明。 */
export function canvasDocumentLifecycleAssistantMessage(input: {
  kind: CanvasDocumentLifecycleNotice
  name?: string
  locale?: ProductLocale
}) {
  const { kind, name = '', locale = 'zh-CN' } = input
  const copy = canvasDocumentLifecycleCopy(locale)
  if (kind === 'synced' || kind === 'renameFailed') return copy[kind]
  return copy[kind](name)
}

export function canvasDocumentReadyAssistantMessage(document: { name: string, nodes: readonly unknown[] }, locale?: ProductLocale) {
  return canvasDocumentLifecycleAssistantMessage({
    kind: document.nodes.length ? 'opened' : 'created',
    name: document.name,
    locale,
  })
}
