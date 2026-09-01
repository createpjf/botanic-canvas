import { createGenerationQueue } from './generationQueue.mjs'
import { createAgentSubagentQueue } from './agentSubagentQueue.mjs'
import { createConfiguredMcpRuntime } from './mcpClient.mjs'
import { createAgentRunEventPublisher } from './agentRunEventBus.mjs'
import { createProductRuntime, loadLocalEnv, runtimeConfig } from './runtime.mjs'
import { installDatabaseResilience } from './databaseResilience.mjs'
import { createSecurityControls } from './securityControls.mjs'
import { createBotanicHttpServer } from './httpServer.mjs'
import { initializeBotanicTelemetry } from './botanicTelemetry.mjs'
import { captureException, flushSentry } from './sentry.mjs'

loadLocalEnv()
// 数据库连接层的抖动不属于任何一次请求，因此没有 5xx 可返回，只会变成未捕获异常并
// 终止整个进程。这里容忍瞬时故障（连接池下一次查询即可自愈），但连续故障仍然退出 ——
// 「活着但每个请求都 500」比直接重启更难被发现，因为健康检查会一直显示正常。
installDatabaseResilience()
const config = runtimeConfig()
const telemetry = initializeBotanicTelemetry(config.telemetry, { logger: console })
// 灰度选择器写错会静默变成「该项目没开」，排查起来很费时；启动时一次性报出来。
for (const { name, entry } of config.rolloutFlags?.invalidSelectors() ?? []) {
  console.warn(`[rollout] ${name} 的选择器「${entry}」无法识别，已忽略；格式应为 project:<id> 或 user:<id>。`)
}
const runtime = await createProductRuntime(config)
const redisQueue = createGenerationQueue(config.redisUrl)
const agentSubagentQueue = createAgentSubagentQueue(config.redisUrl)
const agentRunEvents = createAgentRunEventPublisher(config.redisUrl)
const securityControls = createSecurityControls({
  redisUrl: config.redisUrl,
  onFallback: (caught) => {
    captureException(caught, { level: 'warning', tags: { component: 'security', operation: 'redis_fallback' } })
    console.error(`[security] Redis limiter fallback: ${caught instanceof Error ? caught.message : String(caught)}`)
  },
})

const application = createBotanicHttpServer({
  config,
  runtime,
  redisQueue,
  agentSubagentQueue,
  agentRunEvents,
  securityControls,
  configuredMcpTools: createConfiguredMcpRuntime(config.agentMcpTools ?? []),
})

await application.start()

let shutdownPromise
function shutdown() {
  shutdownPromise ??= (async () => {
    try {
      await application.close()
    } catch (caught) {
      console.error(`[shutdown] ${caught instanceof Error ? caught.message : String(caught)}`)
      process.exitCode = 1
    } finally {
      await telemetry.shutdown().catch(() => undefined)
      await flushSentry(2_000).catch(() => undefined)
    }
  })()
  return shutdownPromise
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
