import { readFile } from 'node:fs/promises'

const AGENT_GUIDE = new URL('./skills/botanic-agent/AGENT.md', import.meta.url)
const SOUL_GUIDE = new URL('./skills/botanic-agent/SOUL.md', import.meta.url)
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
  if (mode === 'generation') files.push(PLANNER_SKILL)
  if (mode === 'prompt') files.push(PROMPT_REFINER_SKILL, FASHION_SKILL)
  try {
    const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    return contents.map((content) => content.trim()).filter(Boolean).join('\n\n')
  } catch {
    throw new BotanicAgentInstructionsError()
  }
}
