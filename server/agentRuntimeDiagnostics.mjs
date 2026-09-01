// @ts-check
/**
 * Agent Runtime Diagnostics(升级计划 CS3):content-free 运行时快照。
 *
 * 只暴露计数与字节数——active turns、活动工具调用、待确认取消 ack、进程内存。
 * 不含任何 Prompt、URL、用户文本、项目/用户/Turn 标识。参考 codex diagnostics 的
 * content-free snapshot 边界,不复制其 Sentry 上报。
 *
 * counters 由拥有事实的模块注册回调(observable 模式),诊断层自己不持有业务状态。
 */

/** @type {Map<string, () => number>} */
const gaugeSources = new Map()

/** 注册一个观测源;重复注册同名源以最后一次为准(实例内组合根只装配一次)。 */
export function registerAgentDiagnosticGauge(name, read) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_.]{2,63}$/.test(name) || typeof read !== 'function') return false
  gaugeSources.set(name, read)
  return true
}

export function unregisterAgentDiagnosticGauge(name) {
  return gaugeSources.delete(name)
}

/** content-free 快照:任何 source 抛错都记为 null,不让诊断影响业务。 */
export function agentRuntimeDiagnosticsSnapshot({ now = Date.now } = {}) {
  const gauges = {}
  for (const [name, read] of gaugeSources) {
    try {
      const value = Number(read())
      gauges[name] = Number.isFinite(value) ? value : null
    } catch {
      gauges[name] = null
    }
  }
  const memory = process.memoryUsage()
  return Object.freeze({
    generatedAt: now(),
    process: Object.freeze({
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      uptimeSeconds: Math.round(process.uptime()),
    }),
    gauges: Object.freeze(gauges),
  })
}

/** 把 snapshot gauges 挂到 OTel observable(可选;meterProvider 未启用时 no-op)。 */
export function bindAgentDiagnosticsToMeter(meterProvider) {
  if (!meterProvider) return false
  try {
    const meter = meterProvider.getMeter('botanic-agent-diagnostics')
    const observable = meter.createObservableGauge('botanic.agent.runtime.gauge', {
      description: 'content-free Agent 运行时观测值(active turns/tool calls/pending cancel acks/内存)。',
    })
    observable.addCallback((result) => {
      const snapshot = agentRuntimeDiagnosticsSnapshot()
      for (const [name, value] of Object.entries(snapshot.gauges)) {
        if (value !== null) result.observe(value, { gauge: name })
      }
      result.observe(snapshot.process.rssBytes, { gauge: 'process.rss_bytes' })
      result.observe(snapshot.process.heapUsedBytes, { gauge: 'process.heap_used_bytes' })
    })
    return true
  } catch {
    return false
  }
}
