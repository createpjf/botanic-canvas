import { readFile } from 'node:fs/promises'

const AGENT_GUIDE = new URL('./skills/botanic-agent/AGENT.md', import.meta.url)
const SOUL_GUIDE = new URL('./skills/botanic-agent/SOUL.md', import.meta.url)
const CREATIVE_BRIEF_GUIDE = new URL('./skills/botanic-agent/CREATIVE_BRIEF.md', import.meta.url)
const MODE_GUIDES = Object.freeze({
  conversation: new URL('./skills/botanic-agent/modes/CONVERSATION.md', import.meta.url),
  prompt: new URL('./skills/botanic-agent/modes/PROMPT.md', import.meta.url),
  research: new URL('./skills/botanic-agent/modes/RESEARCH.md', import.meta.url),
  generation: new URL('./skills/botanic-agent/modes/GENERATION.md', import.meta.url),
})
const PLANNER_SKILL = new URL('./skills/botanic-agent-planner/SKILL.md', import.meta.url)
const PROMPT_REFINER_SKILL = new URL('./skills/prompt-refiner/SKILL.md', import.meta.url)
const FASHION_SKILL = new URL('./skills/botanic-fashion-prompt/SKILL.md', import.meta.url)

export class BotanicAgentInstructionsError extends Error {
  constructor(message = 'Botanic Agent 规则尚未配置完成。') {
    super(message)
    this.name = 'BotanicAgentInstructionsError'
  }
}

export function normalizeBotanicAgentLocale(value) {
  return value === 'en' ? 'en' : 'zh-CN'
}

function localeInstructions(locale) {
  if (locale === 'en') {
    return [
      'Use concise, natural English for every new assistant response, clarification question, plan title and summary, tool-call label, and the user-visible why text. This language rule overrides any Chinese wording or examples in the loaded guides: do not answer in Chinese in English mode.',
      'User messages, project names, canvas labels, prompts, project memory, previous messages, Skill content, and provider/source text are source material. Preserve them in their original language unless the user explicitly asks for translation.',
      'Do not translate stable IDs, enum values, model names, Skill names, MCP names, or quoted source text. This language rule changes presentation only, never the meaning of stored user content.',
    ].join(' ')
  }
  return [
    '所有新生成的助手回复、追问、计划标题与摘要、工具调用标签和面向用户的 why 说明都使用简洁中文。',
    '用户消息、项目名、画布标签、Prompt、项目记忆、历史消息、Skill 内容和 Provider/来源原文都是源材料；除非用户明确要求翻译，否则保持原文。',
    '不翻译稳定 ID、枚举值、模型名、Skill 名和 MCP 名；语言规则只改变展示，不改变持久化的用户内容语义。',
  ].join(' ')
}

export async function readBotanicAgentInstructions(mode = 'conversation', localeValue = 'zh-CN') {
  const files = [AGENT_GUIDE, SOUL_GUIDE]
  if (mode === 'generation' || mode === 'prompt') files.push(CREATIVE_BRIEF_GUIDE)
  if (MODE_GUIDES[mode]) files.push(MODE_GUIDES[mode])
  if (mode === 'generation') files.push(PLANNER_SKILL)
  if (mode === 'prompt') files.push(PROMPT_REFINER_SKILL, FASHION_SKILL)
  try {
    const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    return [...contents.map((content) => content.trim()).filter(Boolean), localeInstructions(normalizeBotanicAgentLocale(localeValue))].join('\n\n')
  } catch {
    throw new BotanicAgentInstructionsError()
  }
}
