import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syntheticTools, toolScenarios, toolOptions, toolLabels } from './fixtures/agentToolSearchO5.mjs'
import { toolRequest, toolResponse, keywordShortlist, measureToolSearch } from './evalAgentToolSearchO5.mjs'

const labelFor = (s, name) => s.required.includes(name) ? 'needed' : s.uncertain.includes(name) ? 'insufficient' : 'not_needed'
const perfectRows = toolScenarios.flatMap((s) => syntheticTools.map((t) => ({ queryId: s.id, tool: t.name,
  prediction: labelFor(s, t.name), ms: 10 })))

test('合成目录和标签隔离，按请求列白名单；必要工具集合、多步召回和回退分别计分', () => {
  assert.equal(toolScenarios.length, 24)
  assert.equal(new Set(toolScenarios.map((s) => s.family)).size, 24)
  assert.equal(toolScenarios.filter((s) => s.split === 'holdout').length, 16)
  for (const s of toolScenarios) {
    assert.equal(new Set([...s.required, ...s.uncertain]).size, s.required.length + s.uncertain.length)
    assert.ok([...s.required, ...s.uncertain].every((id) => syntheticTools.some((t) => t.name === id)))
    assert.equal(keywordShortlist(s).length, 3)
    for (const t of syntheticTools) {
      assert.deepEqual(toolRequest(s, t), toolRequest({ ...s, required: ['poison'], rationale: 'poison', split: 'poison', secret: 'poison' },
        { ...t, apiKey: 'poison', privateUrl: 'poison', gold: 'poison' }))
      assert.deepEqual(toolRequest(s, t).response_format.json_schema.schema.properties.intent.enum, toolOptions)
    }
  }
  const perfect = measureToolSearch(toolScenarios, perfectRows)
  assert.equal(perfect.completedPairs, 192)
  assert.equal(perfect.classification.accuracy, 1)
  assert.equal(perfect.classifierOnly.recall, 1)
  assert.equal(perfect.classifierOnly.precision, 1)
  assert.equal(perfect.classifierOnly.exactSets, 24)
  assert.equal(perfect.classifierOnly.readOnlyRiskyQueries, 0)
  assert.equal(perfect.gate, true)
  assert.ok(perfect.keywordAll.recall < 1) // The four-tool case cannot fit top3.
  assert.ok(perfect.catalogAfterFallback.schemaReductionEstimate < perfect.classifierOnly.schemaReductionEstimate)
  assert.equal(perfect.serialQueryLatency.p50Ms, 80)
  const missing = measureToolSearch([toolScenarios[0]], perfectRows.filter((r) => r.tool !== 'canvas_find'))
  assert.equal(missing.completedQueries, 0)
  assert.equal(missing.classifierOnly.recall, null)
  assert.equal(missing.gate, false)
  assert.equal(missing.queryResults[0].effective.length, 8)
  const wrong = perfectRows.map((r) => r.queryId === 'h4' && r.tool === 'image_render' ? { ...r, prediction: 'needed' } : r)
  const faulty = measureToolSearch(toolScenarios, wrong)
  assert.equal(faulty.classifierOnly.readOnlyRiskyQueries, 1)
  assert.equal(faulty.gate, false)
})

test('复用严格概率协议，CLI 无默认出网，预留新文件，失败不重试，模拟192次不泄漏凭据', () => {
  const response = { choices: [{ message: { content: '{"intent":"需要"}' } }],
    this_that: { choice: '需要', confidence: 0.98, probabilities: { 需要: 0.98, 不需要: 0.01, 信息不足: 0.01 } } }
  assert.equal(toolResponse(response).prediction, 'needed')
  assert.throws(() => toolResponse({ choices: response.choices }), /missing_probability/u)
  assert.throws(() => toolResponse({ ...response, this_that: { ...response.this_that, confidence: 0.5 } }), /protocol/u)
  const directory = mkdtempSync(join(tmpdir(), 'botanic-o5-tool-test-'))
  const runner = new URL('./evalAgentToolSearchO5.mjs', import.meta.url).pathname
  const expected = toolScenarios.flatMap((s) => syntheticTools.map((t) => ({ body: toolRequest(s, t), label: toolOptions[toolLabels.indexOf(labelFor(s, t.name))] })))
  const run = (preload, args = []) => spawnSync(process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(preload), runner, ...args],
    { env: { ...process.env, FLOCK_O5_API_KEY: 'synthetic-test-secret' }, encoding: 'utf8', timeout: 15000 })
  const noNetwork = "globalThis.fetch=()=>{throw new Error('unexpected_network')}"
  const preload = `
    import assert from 'node:assert/strict';
    const expected=${JSON.stringify(expected)}, options=${JSON.stringify(toolOptions)};let calls=0;
    globalThis.fetch=async(url,init)=>{
      assert.equal(init.redirect,'error');
      if(url==='https://api.flock.io/model/info') return {ok:true,json:async()=>({data:[{model_name:'this-that-model-1.0',model_info:{input_cost_per_token:0}}]})};
      assert.equal(url,'https://api.flock.io/v1/chat/completions'); assert.ok(++calls<=192);
      const index=expected.findIndex(x=>JSON.stringify(x.body)===init.body); assert.ok(index>=0);
      const [{label}]=expected.splice(index,1);
      return {ok:true,headers:{get:()=>null},json:async()=>({model:'synthetic-test-model',choices:[{message:{content:JSON.stringify({intent:label})}}],
        this_that:{choice:label,confidence:0.98,probabilities:Object.fromEntries(options.map(l=>[l,l===label?0.98:0.01]))}})};
    };
  `
  try {
    const offline = run(noNetwork)
    assert.equal(offline.status, 0, offline.stderr)
    const preflight = JSON.parse(offline.stdout)
    assert.equal(preflight.rows.length, 0)
    assert.equal(preflight.metrics.holdout.classifierOnly.recall, null)
    const output = join(directory, 'success.json')
    const remote = run(preload, ['--remote', '--output', output])
    assert.equal(remote.status, 0, remote.stderr)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(report.rows.length, 192)
    assert.equal(report.metrics.holdout.classification.accuracy, 1)
    assert.equal(report.metrics.holdout.gate, true)
    assert.equal(report.requestSha256, preflight.requestSha256)
    assert.equal(report.productionAdmission, false)
    assert.ok(!JSON.stringify(report).includes('synthetic-test-secret'))
    const duplicate = run(noNetwork, ['--remote', '--output', output])
    assert.equal(duplicate.status, 2)
    assert.match(duplicate.stderr, /output_exists_no_requests_sent/u)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report)
    const failedOutput = join(directory, 'failed.json')
    const failed = run(preload + `const original=fetch;let n=0;globalThis.fetch=(url,init)=>url.endsWith('/model/info')?original(url,init):
      (++n===1?{ok:false,status:503,headers:{get:()=>null}}:assert.fail('retry forbidden'));`, ['--remote', '--output', failedOutput])
    assert.equal(failed.status, 1, failed.stderr)
    const failure = JSON.parse(readFileSync(failedOutput, 'utf8'))
    assert.equal(failure.attemptedRequests, 1)
    assert.equal(failure.stopped.reason, 'http_503')
    assert.equal(failure.metrics.holdout.gate, false)
  } finally {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name))
    rmdirSync(directory)
  }
})
