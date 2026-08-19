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

export async function readBotanicAgentInstructions(mode = 'conversation') {
  const files = [AGENT_GUIDE, SOUL_GUIDE]
  if (mode === 'generation' || mode === 'prompt') files.push(CREATIVE_BRIEF_GUIDE)
  if (MODE_GUIDES[mode]) files.push(MODE_GUIDES[mode])
  if (mode === 'generation') files.push(PLANNER_SKILL)
  if (mode === 'prompt') files.push(PROMPT_REFINER_SKILL, FASHION_SKILL)
  try {
    const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    return contents.map((content) => content.trim()).filter(Boolean).join('\n\n')
  } catch {
    throw new BotanicAgentInstructionsError()
  }
}
