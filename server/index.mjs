import { createGenerationQueue } from './generationQueue.mjs'
import { createConfiguredMcpTools } from './mcpClient.mjs'
import { createAgentRunEventPublisher } from './agentRunEventBus.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { createSecurityControls } from './securityControls.mjs'
import { createBotanicHttpServer } from './httpServer.mjs'

loadLocalEnv()
const config = runtimeConfig()
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
