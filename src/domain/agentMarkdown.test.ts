import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAgentMarkdown,
  parseAgentPromptSections,
  resolveAgentChatPrompt,
  resolveAgentPromptSections,
  localizeAgentSourceLabel,
  splitAgentMessageSources,
  stripAgentMarkdownHashes,
} from './agentMarkdown.ts'

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

test('#### 与 ###### 也解析成标题，文本不含 #，展示层压到 h3', () => {
  const blocks = parseAgentMarkdown('#### 1. Lighting & Environmental Realism\n\n正文\n\n###### Deep note')
  assert.deepEqual(blocks, [
    { kind: 'heading', level: 3, text: '1. Lighting & Environmental Realism' },
    { kind: 'paragraph', text: '正文' },
    { kind: 'heading', level: 3, text: 'Deep note' },
  ])
  for (const block of blocks) {
    if (block.kind === 'heading') assert.doesNotMatch(block.text, /#/)
  }
})

test('段落行首残留井号会被剥掉，界面不露 #；末段来源收成 chips 数据', () => {
  assert.equal(stripAgentMarkdownHashes('####NoSpaceTitle'), 'NoSpaceTitle')
  assert.equal(stripAgentMarkdownHashes('## 有空格'), '有空格')
  const { body, sources } = splitAgentMessageSources('结论如下。\n\n来源: 项目 Skill、画布')
  assert.equal(body, '结论如下。')
  assert.deepEqual(sources, ['项目 Skill', '画布'])
  const english = splitAgentMessageSources('Done.\n\nSources: Project Skill')
  assert.equal(english.body, 'Done.')
  assert.deepEqual(english.sources, ['Project Skill'])
  assert.equal(localizeAgentSourceLabel('互联网', 'en'), 'Internet')
  assert.equal(localizeAgentSourceLabel('网页', 'en'), 'Web')
  assert.equal(localizeAgentSourceLabel('项目本体', 'en'), 'Project ontology')
  assert.equal(localizeAgentSourceLabel('画布', 'en'), 'Canvas')
  assert.equal(localizeAgentSourceLabel('互联网', 'zh-CN'), '互联网')
})
test('agent markdown does not treat html as executable markup', () => {
  const [block] = parseAgentMarkdown('<script>alert(1)</script>\n\n下一段')
  assert.equal(block?.kind, 'paragraph')
  assert.equal(block?.text, '<script>alert(1)</script>')
})

test('agent markdown 把管道表格收成安全表格块，不把竖线原文摊在段落里', () => {
  const blocks = parseAgentMarkdown([
    '### 批量设置',
    '',
    '| 字段 | 推荐值 | 说明 |',
    '|---|---|---|',
    '| 变体数量 | 4 个 | 每档肤色生成 1 张 |',
    '| 肤色档位 | 浅 / 中 / 深 / 极深 | 四档递进 |',
    '',
    '确认前不会生成。',
  ].join('\n'))
  const table = blocks.find((block) => block.kind === 'table')
  assert.deepEqual(table, {
    kind: 'table',
    headers: ['字段', '推荐值', '说明'],
    rows: [
      ['变体数量', '4 个', '每档肤色生成 1 张'],
      ['肤色档位', '浅 / 中 / 深 / 极深', '四档递进'],
    ],
  })
  assert.equal(blocks.some((block) => block.kind === 'paragraph' && block.text.includes('|---|')), false)
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

test('agent markdown parses GFM tables once a separator row is present', () => {
  const blocks = parseAgentMarkdown([
    '请确认两个字段：',
    '',
    '| 字段 | 选项 | 说明 |',
    '|---|---|---|',
    '| 变体数量 | ① 4个 (推荐) | 每个变体都会产生一次生成成本 |',
    '| 肤色范围 | ① 浅 / 中 / 深 / 极深四档 (推荐) | 推荐方案可在同一场景下呈现最大对比度 |',
  ].join('\n'))

  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: '请确认两个字段：' },
    {
      kind: 'table',
      headers: ['字段', '选项', '说明'],
      rows: [
        ['变体数量', '① 4个 (推荐)', '每个变体都会产生一次生成成本'],
        ['肤色范围', '① 浅 / 中 / 深 / 极深四档 (推荐)', '推荐方案可在同一场景下呈现最大对比度'],
      ],
    },
  ])
})

test('agent markdown keeps incomplete tables as paragraphs until a separator appears', () => {
  const blocks = parseAgentMarkdown('| 字段 | 选项 | 说明 |\n| 变体数量 | 4个 | 成本 |')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'paragraph')
  assert.match(blocks[0]?.text ?? '', /\| 字段 \|/)
})

test('agent markdown keeps html inside table cells as text', () => {
  const [block] = parseAgentMarkdown('| 名称 | 值 |\n|---|---|\n| 注入 | <script>alert(1)</script> |')
  assert.equal(block?.kind, 'table')
  if (block?.kind !== 'table') return
  assert.equal(block.rows[0]?.[1], '<script>alert(1)</script>')
})

test('agent prompt sections read fenced prompt code and leave surrounding copy outside', () => {
  const sections = parseAgentPromptSections([
    '已按你的要求收紧光线描述。',
    '',
    '```prompt',
    'cinematic 16:9 photograph, moonlit forest clearing, soft mist.',
    '```',
    '',
    '说明：可直接复制后生成。',
  ].join('\n'))

  assert.deepEqual(sections, {
    before: '已按你的要求收紧光线描述。',
    prompt: 'cinematic 16:9 photograph, moonlit forest clearing, soft mist.',
    promptLabel: 'Prompt',
    after: '说明：可直接复制后生成。',
  })
})

test('json code fences are not treated as a copyable prompt card', () => {
  assert.equal(parseAgentPromptSections('结果如下：\n\n```json\n{"ok":true}\n```'), null)
})

test('Prompt heading before a prompt fence is not kept as surrounding copy', () => {
  const sections = parseAgentPromptSections([
    'Prompt:',
    '',
    '```prompt',
    'soft window light, 3:4, photorealistic',
    '```',
  ].join('\n'))
  assert.deepEqual(sections, {
    before: '',
    prompt: 'soft window light, 3:4, photorealistic',
    promptLabel: 'Prompt',
    after: '',
  })
})

test('stored prompt becomes a copyable card even without a Prompt heading', () => {
  const prompt = 'a woman standing by a window, soft daylight, 3:4, photorealistic'
  assert.deepEqual(resolveAgentPromptSections(prompt, prompt), {
    before: '',
    prompt,
    promptLabel: 'Prompt',
    after: '',
  })
})

test('stored prompt does not duplicate surrounding explanation as the prompt body', () => {
  const prompt = 'a woman standing by a window, soft daylight'
  const content = `先看这版描述。\n\n${prompt}`
  assert.deepEqual(resolveAgentPromptSections(content, prompt), {
    before: '先看这版描述。',
    prompt,
    promptLabel: 'Prompt',
    after: '',
  })
})

test('说明文回答不会变成可执行提示词，显式 Prompt 区块才会', () => {
  const essay = [
    '结论：多肤色批量计划已就绪，只差两个字段确认即可出待确认计划。',
    '',
    '依据：我查了当前项目，没有已启用的批量变量 Skill。',
    '',
    '| 字段 | 推荐值 |',
    '|---|---|',
    '| 变体数量 | 4 个 |',
  ].join('\n')
  assert.equal(resolveAgentChatPrompt(essay), '')

  assert.equal(
    resolveAgentChatPrompt('已按你的要求收紧光线。\n\n```prompt\n模特站在海边，黄昏柔光，3:4。\n```'),
    '模特站在海边，黄昏柔光，3:4。',
  )
  // 整段就是一句画面描述时仍可直接使用，不因为缺少标题就丢掉。
  assert.equal(
    resolveAgentChatPrompt('保持人物和服装，替换为柔和夕阳海边场景。'),
    '保持人物和服装，替换为柔和夕阳海边场景。',
  )
  assert.equal(resolveAgentChatPrompt('## 三个方案\n\n- 海边\n- 森林'), '')
})

test('规划旁白即使被整段存成 prompt 也不进可复制卡片，留给表格渲染', () => {
  const content = [
    '结论：多肤色批量计划已就绪，只差两个字段确认即可出待确认计划。',
    '',
    '| 字段 | 推荐值 | 说明 |',
    '|---|---|---|',
    '| 变体数量 | 4 个 | 每档肤色生成 1 张 |',
    '',
    '确认前不会执行任何生成。',
  ].join('\n')
  assert.equal(resolveAgentPromptSections(content, content), null)
  assert.equal(parseAgentMarkdown(content).some((block) => block.kind === 'table'), true)
})
