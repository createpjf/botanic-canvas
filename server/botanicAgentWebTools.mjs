import { AgentToolRuntimeError } from './agentToolRuntime.mjs'
import { clampWebSearchQuery } from './agentWebResearch.mjs'
import { createTavilyWebResearch } from './webSearchProvider.mjs'

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  return value
}

function requiredText(value, name, maximumLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength) {
    throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', `${name}参数无效。`)
  }
  return value.trim()
}

async function consumeWebResearchQuota(webResearch) {
  if (typeof webResearch?.consumeQuota !== 'function') return
  const result = await webResearch.consumeQuota()
  if (result?.allowed === false) {
    throw new AgentToolRuntimeError('WEB_QUOTA_EXCEEDED', '联网检索次数过多，请稍后重试。', 429)
  }
}

export function createBotanicAgentWebResearchTools(webResearch) {
  if (!webResearch || typeof webResearch !== 'object') return []
  const client = createTavilyWebResearch(webResearch)
  const tools = []
  if (client.enabled) {
    tools.push({
      name: 'web_search',
      label: '网页搜索',
      description: '在公开互联网检索品牌、产品和参考资料。只返回标题、链接和摘要，不下载图片。没有关键词搜索需求时不要调用。',
      risk: 'external',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string', maxLength: 200 } },
        required: ['query'],
      },
      validate: (raw) => {
        const query = clampWebSearchQuery(object(raw, '网页搜索').query)
        if (!query) throw new AgentToolRuntimeError('INVALID_TOOL_ARGUMENTS', '搜索词无效。')
        return { query }
      },
      execute: async ({ query }) => {
        await consumeWebResearchQuota(webResearch)
        return client.search(query)
      },
    })
  }
  tools.push({
    name: 'web_fetch',
    label: '网页获取',
    description: '读取用户或搜索结果给出的公开 HTTPS 页面正文。不要抓取内网、登录页或媒体文件。',
    risk: 'external',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { url: { type: 'string', maxLength: 2048 } },
      required: ['url'],
    },
    validate: (raw) => ({ url: requiredText(object(raw, '网页获取').url, '网页地址', 2048) }),
    execute: async ({ url }) => {
      await consumeWebResearchQuota(webResearch)
      return client.extract(url)
    },
  })
  return tools
}

export function botanicAgentWebResearchSourceLabels(toolCalls) {
  const labels = new Map([
    ['web_search', '互联网'],
    ['web_fetch', '网页'],
  ])
  return [...new Set((toolCalls ?? []).map((call) => labels.get(call.name)).filter(Boolean))]
}
