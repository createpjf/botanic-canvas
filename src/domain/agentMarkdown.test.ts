import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentMarkdown } from './agentMarkdown.ts'

test('agent markdown keeps headings, emphasis, lists and code blocks as safe blocks', () => {
  const blocks = parseAgentMarkdown('**说明**\n\n## 三个变量\n- **光线**：柔光\n- 场景\n\n---\n\n```json\n{"ok":true}\n```')
  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: '**说明**' },
    { kind: 'heading', level: 2, text: '三个变量' },
    { kind: 'unordered-list', items: ['**光线**：柔光', '场景'] },
    { kind: 'rule' },
    { kind: 'code', language: 'json', text: '{"ok":true}' },
  ])
})

test('agent markdown does not treat html as executable markup', () => {
  const [block] = parseAgentMarkdown('<script>alert(1)</script>\n\n下一段')
  assert.equal(block?.kind, 'paragraph')
  assert.equal(block?.text, '<script>alert(1)</script>')
})
