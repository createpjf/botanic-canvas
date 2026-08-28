// @ts-check

/** 用户消息没有正文时，为挂载 Skill / 引用素材生成低权限模型指令。 */
export function agentMentionOnlyInstruction(mentions, locale = 'zh-CN') {
  if (!Array.isArray(mentions) || !mentions.length) return ''
  const hasSkill = mentions.some((mention) => mention?.kind === 'skill')
  const hasReference = mentions.some((mention) => mention?.kind === 'reference')
  if (locale === 'en') {
    if (hasSkill && hasReference) return 'Follow the mounted Skills and referenced assets.'
    if (hasSkill) return 'Follow the mounted Skills.'
    return 'Use the referenced assets.'
  }
  if (hasSkill && hasReference) return '按已挂载 Skill 与已引用素材处理。'
  if (hasSkill) return '按已挂载 Skill 执行。'
  return '按已引用素材处理。'
}

/** 有正文时追加可读引用标签；标签仍属于用户上下文，不提升为系统事实。 */
export function agentMentionReferenceLine(mentions, locale = 'zh-CN') {
  const labels = [...new Set((Array.isArray(mentions) ? mentions : [])
    .filter((mention) => mention?.kind === 'reference' && typeof mention.label === 'string' && mention.label.trim())
    .map((mention) => mention.label.trim()))]
  if (!labels.length) return ''
  return locale === 'en' ? `Referenced: ${labels.join(', ')}.` : `已引用：${labels.join('、')}。`
}
