import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentMarkdown, parseAgentPromptSections } from './agentMarkdown.ts'

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

test('agent prompt sections separate copyable prompt, negative prompt and notes', () => {
  const sections = parseAgentPromptSections([
    "Got it — here's the updated 16:9 prompt:",
    '',
    'Prompt (EN):',
    '',
    '> cinematic 16:9 photograph,',
    '> moonlit forest clearing, soft mist.',
    '',
    'Negative prompt:',
    '',
    '> daylight, harsh sunlight, watermark',
    '',
    'Changes vs. the sunny version: cooler moonlight.',
    '',
    'Two reminders: paste this into your image tool.',
  ].join('\n'))

  assert.deepEqual(sections, {
    before: "Got it — here's the updated 16:9 prompt:",
    prompt: 'cinematic 16:9 photograph,\nmoonlit forest clearing, soft mist.',
    promptLabel: 'Prompt (EN)',
    negativePrompt: 'daylight, harsh sunlight, watermark',
    negativePromptLabel: 'Negative prompt',
    after: 'Changes vs. the sunny version: cooler moonlight.\n\nTwo reminders: paste this into your image tool.',
  })
})

test('ordinary assistant copy is not treated as a prompt response', () => {
  assert.equal(parseAgentPromptSections('这是一段普通说明，没有提示词区块。'), null)
})
