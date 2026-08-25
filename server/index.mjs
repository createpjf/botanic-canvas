import { createGenerationQueue } from './generationQueue.mjs'
import { createConfiguredMcpTools } from './mcpClient.mjs'
import { createAgentRunEventPublisher } from './agentRunEventBus.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { createSecurityControls } from './securityControls.mjs'
import { createBotanicHttpServer } from './httpServer.mjs'

loadLocalEnv()
const config = runtimeConfig()
// 灰度选择器写错会静默变成「该项目没开」，排查起来很费时；启动时一次性报出来。
for (const { name, entry } of config.rolloutFlags?.invalidSelectors() ?? []) {
  console.warn(`[rollout] ${name} 的选择器「${entry}」无法识别，已忽略；格式应为 project:<id> 或 user:<id>。`)
}
const runtime = await createProductRuntime(config)
const redisQueue = createGenerationQueue(config.redisUrl)
const agentRunEvents = createAgentRunEventPublisher(config.redisUrl)
const securityControls = createSecurityControls({
  redisUrl: config.redisUrl,
  onFallback: (caught) => console.error(`[security] Redis limiter fallback: ${caught instanceof Error ? caught.message : String(caught)}`),
})

const application = createBotanicHttpServer({
  config,
  runtime,
  redisQueue,
  agentRunEvents,
  securityControls,
  configuredMcpTools: createConfiguredMcpTools(config.agentMcpTools ?? []),
})

await application.start()

let shutdownPromise
function shutdown() {
  shutdownPromise ??= application.close().catch((caught) => {
    console.error(`[shutdown] ${caught instanceof Error ? caught.message : String(caught)}`)
    process.exitCode = 1
  })
  return shutdownPromise
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
