import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentAttachmentCategory,
  attachmentFromArtifact,
  attachmentFromContextItem,
  attachmentFromSkill,
} from './agentWorkspace.types.ts'

test('附件类别投影：视频优先于图片，文字为文档，无媒体节点为画布节点', () => {
  assert.equal(agentAttachmentCategory({ kind: '素材', mediaKind: 'video', image: '/a.mp4' }), 'video')
  assert.equal(agentAttachmentCategory({ kind: '结果', image: '/a.png' }), 'image')
  assert.equal(agentAttachmentCategory({ kind: '文字' }), 'document')
  assert.equal(agentAttachmentCategory({ kind: '节点' }), 'canvas-node')

  const context = attachmentFromContextItem({ id: 'n1', label: '海报', kind: '文字', content: '柔光棚拍' })
  assert.deepEqual(context, { id: 'n1', label: '海报', category: 'document', mediaType: '文字', content: '柔光棚拍' })
  assert.deepEqual(attachmentFromSkill({ id: 's1', name: '品牌规范', source: 'project' }), { id: 's1', label: '品牌规范', category: 'skill' })
})

test('Artifact 投影：仅媒体类带预览 URL，文档类 URL 不当图片渲染', () => {
  const image = attachmentFromArtifact({ id: 'a1', label: '主图', kind: 'image', url: '/api/media/a1' })
  assert.equal(image.category, 'image')
  assert.equal(image.image, '/api/media/a1')
  // 文档/workflow 的 url 是打开链接不是图片：绝不能进 <img src>。
  const doc = attachmentFromArtifact({ id: 'a2', label: '文案', kind: 'document', url: 'https://example.com/doc', content: '正文' })
  assert.equal(doc.category, 'document')
  assert.equal(doc.image, undefined)
  assert.equal(doc.content, '正文')
})
