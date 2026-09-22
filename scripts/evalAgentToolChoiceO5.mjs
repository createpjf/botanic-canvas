// Paired synthetic experiment. No execution, project data, production wiring, or credential persistence.
import { createHash } from 'node:crypto'
import { openSync, writeFileSync, closeSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { classifyResponse } from './evalAgentDecisionO5.mjs'
import { toolRequest, toolResponse, measureToolSearch } from './evalAgentToolSearchO5.mjs'
import { syntheticTools } from './fixtures/agentToolSearchO5.mjs'
import { binaryOptions, capabilities, choiceScenarios, choiceVersion } from './fixtures/agentToolChoiceO5.mjs'

const model = 'this-that-model-1.0'
const variants = ['v1', 'v2']
const names = syntheticTools.map((t) => t.name)
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function choiceRequest(s, tool, variant) {
  if (variant === 'v1') return toolRequest(s, tool)
  if (variant !== 'v2' || !capabilities[tool.name]) throw new Error('invalid_variant_or_tool')
  const body = toolRequest(s, tool)
  body.messages = [{ role: 'user', content: JSON.stringify({ 用户请求: s.request, 已知事实: s.context }) },
    { role: 'user', content: `用户本次是否需要「${capabilities[tool.name]}」？多步骤中的一步也算需要；仅讨论、明确禁止、引用文字中的动作不算需要。只判断用途，不判断执行授权。` }]
  body.response_format.json_schema.schema.properties.intent.enum = binaryOptions
  if (Buffer.byteLength(body.messages.map((m) => m.content).join('\n')) > 1800) throw new Error('invalid_synthetic_input')
  return body
}

export function choiceResponse(data, variant) {
  if (variant === 'v1') return toolResponse(data)
  if (variant !== 'v2') throw new Error('invalid_variant_or_tool')
  const { label, score } = classifyResponse(data, binaryOptions)
  if (score === null) throw new Error('missing_probability_distribution')
  return { prediction: label === binaryOptions[0] ? 'needed' : 'not_needed', score,
    probabilities: { needed: data.this_that.probabilities[binaryOptions[0]],
      not_needed: data.this_that.probabilities[binaryOptions[1]], insufficient: 0 } }
}

export function chooseTools(rows, { availableTools = names, unresolvedInputs = [] } = {}) {
  if (!Array.isArray(availableTools) || new Set(availableTools).size !== availableTools.length
    || availableTools.some((name) => !names.includes(name)) || !Array.isArray(unresolvedInputs)
    || unresolvedInputs.some((item) => typeof item !== 'string' || !item)) throw new Error('invalid_selection_state')
  const found = availableTools.map((name) => rows.filter((r) => r.tool === name))
  if (found.some((items) => items.length !== 1 || !['needed', 'not_needed', 'insufficient'].includes(items[0].prediction))) {
    return { complete: false, recommended: [], orderedCatalog: availableTools, clarification: false, reason: 'incomplete' }
  }
  // ponytail: authoritative unresolved slots cover one blocked request; per-step plans needed for partial execution.
  // These synthetic slots are supplied independently of classifier output, not inferred from its confidence.
  const clarification = unresolvedInputs.length > 0
  const recommended = clarification ? availableTools.filter((name) => name === 'ask_user')
    : found.map(([r]) => r).filter((r) => r.prediction === 'needed').map((r) => r.tool)
  return { complete: true, recommended, clarification,
    reason: clarification ? recommended.length ? 'missing_user_input' : 'clarification_unavailable' : 'model_advice',
    // Advisory ordering only. Never silently delete a capability or authorize an action.
    orderedCatalog: [...recommended, ...availableTools.filter((name) => !recommended.includes(name))] }
}

export function prepareChoiceRequests() {
  return choiceScenarios.flatMap((s) => [...syntheticTools].sort((a, b) => hash(s.id + a.name).localeCompare(hash(s.id + b.name)))
    .flatMap((t) => [...variants].sort((a, b) => hash(s.id + t.name + a).localeCompare(hash(s.id + t.name + b)))
      .map((variant) => ({ queryId: s.id, tool: t.name, split: s.split, variant, body: choiceRequest(s, t, variant) }))))
}

export function measureChoice(scenarios, allRows, variant) {
  const rows = allRows.filter((r) => r.variant === variant && scenarios.some((s) => s.id === r.queryId))
  const measured = measureToolSearch(scenarios, rows)
  const recommendations = scenarios.map((s) => ({ queryId: s.id,
    ...chooseTools(rows.filter((r) => r.queryId === s.id), { unresolvedInputs: s.unresolvedInputs }) }))
  const guardedRows = rows.map((r) => {
    const decision = recommendations.find((q) => q.queryId === r.queryId)
    return { ...r, prediction: decision.recommended.includes(r.tool) ? 'needed' : 'not_needed' }
  })
  const guarded = measureToolSearch(scenarios, guardedRows)
  // Do not compare v1's three-class accuracy against v2's binary accuracy as an improvement metric.
  return { modelOnly: measured.classifierOnly, withSameStateGuard: guarded.classifierOnly,
    determinedOnly: measureToolSearch(scenarios.filter((s) => !s.unresolvedInputs.length), rows).classifierOnly,
    completedPairs: measured.completedPairs, completedQueries: measured.completedQueries,
    callLatency: measured.callLatency, serialQueryLatency: measured.serialQueryLatency,
    reportedPromptTokens: rows.every((r) => Number.isSafeInteger(r.promptTokens)) ? rows.reduce((n, r) => n + r.promptTokens, 0) : null,
    authorityFactsAssumedQueries: scenarios.filter((s) => s.unresolvedInputs.length).length,
    actualCatalogReduction: 0, endToEndLatency: null, argumentValidity: null, executionSuccess: null,
    gate: guarded.gate && measured.classifierOnly.readOnlyRiskyQueries === 0,
    recommendations }
}

async function main() {
  const { values } = parseArgs({ options: { remote: { type: 'boolean', default: false },
    'key-stdin': { type: 'boolean', default: false }, output: { type: 'string' } } })
  if (values.remote && !values.output) throw new Error('remote_requires_new_output')
  const requests = prepareChoiceRequests()
  if (requests.length !== 384) throw new Error('unexpected_request_count')
  const sourceFiles = ['./evalAgentToolChoiceO5.mjs', './fixtures/agentToolChoiceO5.mjs', './evalAgentToolSearchO5.mjs',
    './fixtures/agentToolSearchO5.mjs', './evalAgentDecisionO5.mjs', '../server/agent/context/agentContextBudget.mjs']
  const report = { version: choiceVersion, startedAt: new Date().toISOString(), model, modelRevision: null,
    scope: 'synthetic-paired-tool-advice-only', productionAdmission: false,
    protocol: { requests: 384, devQueries: 8, holdoutQueries: 16, tools: 8, variants, noRetry: true,
      thresholdTuning: false, pairedOrder: 'hash-interleaved per query/tool, independent of gold',
      stateGuard: 'same guard applied to both variants; synthetic unresolved slots are supplied, extraction untested',
      decision: 'required recall=1, zero read-only risky advice, zero no-tool false accepts; never automatic production admission',
      selection: 'model argmax needed; preserve all authorized capabilities in advisory ordering',
      goldSource: 'agent-authored, frozen before calls, no independent human adjudication' },
    datasetSha256: hash({ syntheticTools, choiceScenarios }), requestSha256: hash(requests),
    implementationSha256: Object.fromEntries(sourceFiles.map((file) => [file,
      createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    syntheticQueries: choiceScenarios, rows: [], attemptedRequests: 0, stopped: null,
    responseModels: [], pricing: null, costHeaders: { count: 0, total: 0 },
    usage: { reportedCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
  const fd = values.output ? openSync(values.output, 'wx', 0o600) : null
  try {
    if (values.remote) {
      let key = process.env.FLOCK_O5_API_KEY
      if (values['key-stdin']) {
        const rl = createInterface({ input: process.stdin })
        console.error('O5 paired choice credential input ready (terminal echo must be disabled).')
        key = await rl.question(''); rl.close()
      }
      if (!key?.trim()) throw new Error('missing_key')
      const headers = { 'Content-Type': 'application/json', 'x-litellm-api-key': key.trim() }
      const pricing = await fetch('https://api.flock.io/model/info', { headers, redirect: 'error', signal: AbortSignal.timeout(25000) })
      if (!pricing.ok) throw new Error('pricing_unverified')
      const info = (await pricing.json()).data?.find((m) => m.model_name === model)?.model_info
      if (!info) throw new Error('pricing_unverified')
      const cost = (v) => Number.isFinite(v) && v >= 0 ? v : null
      report.pricing = { checkedAt: new Date().toISOString(), source: 'https://api.flock.io/model/info',
        inputCostPerToken: cost(info.input_cost_per_token), outputCostPerToken: cost(info.output_cost_per_token),
        costPerRequest: cost(info.input_cost_per_request), actualBill: null }
      for (const item of requests) {
        const start = performance.now()
        report.attemptedRequests++
        try {
          const response = await fetch('https://api.flock.io/v1/chat/completions', { method: 'POST', headers,
            body: JSON.stringify(item.body), redirect: 'error', signal: AbortSignal.timeout(25000) })
          const value = response.headers.get('x-litellm-response-cost')
          const cost = value?.trim() ? Number(value) : NaN
          if (Number.isFinite(cost) && cost >= 0) { report.costHeaders.count++; report.costHeaders.total += cost }
          if (!response.ok) { report.stopped = { queryId: item.queryId, variant: item.variant, tool: item.tool, reason: `http_${response.status}` }; break }
          const data = await response.json()
          const parsed = choiceResponse(data, item.variant)
          if (typeof data.model === 'string' && !report.responseModels.includes(data.model)) report.responseModels.push(data.model)
          const usage = data.usage
          const validUsage = ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0)
          if (validUsage) {
            report.usage.reportedCalls++; report.usage.promptTokens += usage.prompt_tokens
            report.usage.completionTokens += usage.completion_tokens; report.usage.totalTokens += usage.total_tokens
          }
          report.rows.push({ queryId: item.queryId, tool: item.tool, variant: item.variant, split: item.split, ...parsed,
            ms: performance.now() - start, promptTokens: validUsage ? usage.prompt_tokens : null })
          if (report.rows.length % 32 === 0) console.error(`O5 paired choice ${report.rows.length}/384 complete`)
        } catch {
          report.stopped = { queryId: item.queryId, tool: item.tool, variant: item.variant, reason: 'network_or_protocol_error' }
          break
        }
      }
    }
  } catch (error) {
    report.stopped = { reason: ['missing_key', 'pricing_unverified'].includes(error?.message) ? error.message : 'remote_preflight_error' }
  } finally {
    report.finishedAt = new Date().toISOString()
    report.status = report.stopped ? 'incomplete' : values.remote ? 'synthetic_evaluated_not_production_ready' : 'prepared_not_evaluated'
    // For incomplete runs only compare query/tool pairs completed by BOTH arms.
    const pairedRows = report.rows.filter((r) => variants.every((v) => report.rows.some((x) => x.variant === v && x.queryId === r.queryId && x.tool === r.tool)))
    report.metrics = Object.fromEntries(['dev', 'holdout'].map((split) => [split,
      Object.fromEntries(variants.map((v) => [v, measureChoice(choiceScenarios.filter((s) => s.split === split), pairedRows, v)]))]))
    const serialized = JSON.stringify(report, null, 2) + '\n'
    if (fd === null) console.log(serialized)
    else { try { writeFileSync(fd, serialized) } finally { closeSync(fd) } }
  }
  if (report.stopped) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(`O5_TOOL_CHOICE_UNVERIFIED: ${error?.code === 'EEXIST' ? 'output_exists_no_requests_sent'
    : ['remote_requires_new_output', 'unexpected_request_count', 'invalid_synthetic_input'].includes(error?.message) ? error.message : 'preflight_or_report_error'}`)
  process.exitCode = 2
})
