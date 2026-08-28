import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canvasDocumentLifecycleAssistantMessage,
  canvasDocumentReadyAssistantMessage,
} from './canvasDocumentLifecycleCopy.ts'

test('英文模式打开与创建项目不回落中文助手文案', () => {
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'opened', name: 'Creative project 1', locale: 'en' }),
    'Opened “Creative project 1”.',
  )
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'created', name: 'Creative project 1', locale: 'en' }),
    '“Creative project 1” created. Start from assets or a brief.',
  )
  assert.equal(
    canvasDocumentReadyAssistantMessage({ name: 'Blank', nodes: [] }, 'en'),
    '“Blank” created. Start from assets or a brief.',
  )
  assert.equal(
    canvasDocumentReadyAssistantMessage({ name: 'Blank', nodes: [{}] }, 'en'),
    'Opened “Blank”.',
  )
})

test('中文模式保留原项目打开与创建措辞', () => {
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'opened', name: '创意项目 1', locale: 'zh-CN' }),
    '已打开「创意项目 1」。',
  )
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'created', name: '创意项目 1', locale: 'zh-CN' }),
    '「创意项目 1」已创建，可以从素材或一句话开始。',
  )
})

test('同步与重命名助手文案跟随语言', () => {
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'synced', locale: 'en' }),
    'Synced from another device.',
  )
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'renaming', name: 'Lookbook', locale: 'en' }),
    'Renaming to “Lookbook”…',
  )
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'renamed', name: 'Lookbook', locale: 'en' }),
    'Renamed to “Lookbook”.',
  )
  assert.match(
    canvasDocumentLifecycleAssistantMessage({ kind: 'renameFailed', locale: 'en' }),
    /Couldn’t rename/u,
  )
  assert.equal(
    canvasDocumentLifecycleAssistantMessage({ kind: 'synced', locale: 'zh-CN' }),
    '已同步其他设备的更新。',
  )
})
