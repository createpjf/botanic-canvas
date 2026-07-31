type ImageNodeDoubleClickInput = {
  id: string
  type: 'result' | 'asset'
  image?: string
  label?: string
}

export type ImageNodeDoubleClickIntent =
  | { kind: 'open-generation-menu'; resultNodeId: string }
  | { kind: 'preview-image'; image: string; name: string }

/**
 * 固定图片节点双击语义：结果图进入有来源的生成分支，素材图仅预览。
 */
export function imageNodeDoubleClickIntent(
  node: ImageNodeDoubleClickInput,
): ImageNodeDoubleClickIntent | null {
  if (!node.image) return null
  if (node.type === 'result') {
    return { kind: 'open-generation-menu', resultNodeId: node.id }
  }
  return {
    kind: 'preview-image',
    image: node.image,
    name: node.label ?? '图片素材',
  }
}
