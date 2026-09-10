import { readFile } from 'node:fs/promises'

// 宿主没有文件阅读工具，直接挂载 Skill 必读规则；案例与验收资料保留在原包内。
const files = ['SKILL.md', 'references/prompting-guide.md', 'references/output-and-parameters.md']

export async function readPromptRefinementInstructions() {
  const contents = await Promise.all(files.map(async (file) => {
    const content = await readFile(new URL(`../skills/gpt-image-prompt-refiner/${file}`, import.meta.url), 'utf8')
    return `## gpt-image-prompt-refiner/${file}\n\n${content.trim()}`
  }))
  return contents.join('\n\n')
}
