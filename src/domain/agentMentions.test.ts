import assert from 'node:assert/strict'
import test from 'node:test'
import {
  botanicAgentMentionOnlyInstruction,
  botanicAgentMessageRichView,
  parseBotanicAgentRichText,
  prepareBotanicAgentComposerSubmission,
  snapshotBotanicAgentComposerMentions,
  stripBotanicAgentResolvedMentions,
} from './agentMentions.ts'

const catalogs = {
  skills: [{ id: 'ecommerce_listing', name: '电商套图' }],
  references: [{ id: 'node-mia', label: 'Mia 肖像', image: 'https://assets.example.com/mia.webp' }],
}

test('解析 @Skill 与 @素材，并按最长名称匹配带空格的标签', () => {
  assert.deepEqual(parseBotanicAgentRichText('按 @电商套图 出主图，参考 @Mia 肖像。', catalogs), [
    { kind: 'text', text: '按 ' },
    { kind: 'skill', id: 'ecommerce_listing', name: '电商套图' },
    { kind: 'text', text: ' 出主图，参考 ' },
    { kind: 'reference', id: 'node-mia', label: 'Mia 肖像', image: 'https://assets.example.com/mia.webp' },
    { kind: 'text', text: '。' },
  ])
})

test('未登记的 @token 标成 mention，不冒充 Skill 或素材', () => {
  assert.deepEqual(parseBotanicAgentRichText('试试 @未知技能', catalogs), [
    { kind: 'text', text: '试试 ' },
    { kind: 'mention', label: '未知技能' },
  ])
})

test('可执行 Prompt 只去掉已登记引用，留下自然语言', () => {
  assert.equal(
    stripBotanicAgentResolvedMentions('帮我出套图 @电商套图 参考 @Mia 肖像 阳光感', catalogs),
    '帮我出套图 参考 阳光感',
  )
  assert.equal(stripBotanicAgentResolvedMentions('试试 @未知技能', catalogs), '试试 @未知技能')
})

test('Composer 提交把芯片快照成 mentions，不把 @名称写进正文', () => {
  const prepared = prepareBotanicAgentComposerSubmission({
    instruction: '帮我出套图 @电商套图',
    mountedSkills: catalogs.skills,
    contextItems: catalogs.references,
  })
  assert.deepEqual(prepared, {
    content: '帮我出套图',
    instruction: '帮我出套图',
    mentions: [
      { kind: 'skill', id: 'ecommerce_listing', name: '电商套图' },
      { kind: 'reference', id: 'node-mia', label: 'Mia 肖像' },
    ],
  })
})

test('只有芯片没有正文时，指令用引用字段兜底，气泡正文可空', () => {
  const prepared = prepareBotanicAgentComposerSubmission({
    instruction: '   ',
    mountedSkills: catalogs.skills,
    locale: 'zh-CN',
  })
  assert.deepEqual(prepared, {
    content: '',
    instruction: '按已挂载 Skill 执行。',
    mentions: [{ kind: 'skill', id: 'ecommerce_listing', name: '电商套图' }],
  })
  assert.equal(
    botanicAgentMentionOnlyInstruction([{ kind: 'reference', id: 'n', label: 'Mia' }], 'en'),
    'Use the referenced assets.',
  )
})

test('没有正文也没有芯片时不能提交', () => {
  assert.equal(prepareBotanicAgentComposerSubmission({ instruction: '   ' }), undefined)
})

test('快照去重且不写入图片地址', () => {
  assert.deepEqual(snapshotBotanicAgentComposerMentions({
    skills: [catalogs.skills[0], catalogs.skills[0]],
    references: catalogs.references,
  }), [
    { kind: 'skill', id: 'ecommerce_listing', name: '电商套图' },
    { kind: 'reference', id: 'node-mia', label: 'Mia 肖像' },
  ])
})

test('有持久化 mentions 时正文当普通 Prompt；旧消息才从 @ 解析', () => {
  assert.deepEqual(botanicAgentMessageRichView({
    content: '帮我出套图',
    mentions: [{ kind: 'skill', id: 'ecommerce_listing', name: '电商套图' }],
    catalogs,
  }), {
    mentions: [{ kind: 'skill', id: 'ecommerce_listing', name: '电商套图' }],
    spans: [{ kind: 'text', text: '帮我出套图' }],
  })
  assert.deepEqual(botanicAgentMessageRichView({
    content: '按 @电商套图 出主图',
    catalogs,
  }), {
    mentions: [],
    spans: [
      { kind: 'text', text: '按 ' },
      { kind: 'skill', id: 'ecommerce_listing', name: '电商套图' },
      { kind: 'text', text: ' 出主图' },
    ],
  })
})
