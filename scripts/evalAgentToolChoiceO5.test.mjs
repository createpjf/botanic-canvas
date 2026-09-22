import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syntheticTools, toolScenarios, toolOptions } from './fixtures/agentToolSearchO5.mjs'
import { choiceScenarios, binaryOptions } from './fixtures/agentToolChoiceO5.mjs'
import { choiceRequest, choiceResponse, chooseTools, prepareChoiceRequests, measureChoice } from './evalAgentToolChoiceO5.mjs'

test('成对新题不泄漏答案；建议保留所有授权能力，缺参规则与模型效果分别计分', () => {
  assert.equal(choiceScenarios.length, 24)
  assert.equal(new Set(choiceScenarios.map((s) => s.family)).size, 24)
  assert.ok(choiceScenarios.every((s) => !toolScenarios.some((old) => old.request === s.request || old.family === s.family)))
  const requests = prepareChoiceRequests()
  assert.equal(requests.length, 384)
  for (const s of choiceScenarios) for (const t of syntheticTools) for (const v of ['v1', 'v2']) {
    assert.deepEqual(choiceRequest(s, t, v), choiceRequest({ ...s, required: ['poison'], uncertain: ['poison'],
      split: 'poison', readOnly: 'poison', unresolvedInputs: ['poison'], privateText: 'poison' }, t, v))
  }
  const rows = syntheticTools.map((t) => ({ tool: t.name, prediction: ['canvas_find', 'image_render'].includes(t.name) ? 'needed' : 'not_needed' }))
  const choice = chooseTools(rows)
  assert.deepEqual(choice.recommended, ['canvas_find', 'image_render'])
  assert.deepEqual(new Set(choice.orderedCatalog), new Set(syntheticTools.map((t) => t.name)))
  assert.deepEqual(chooseTools(rows, { unresolvedInputs: ['prompt'] }).recommended, ['ask_user'])
  const restricted = chooseTools(rows, { availableTools: ['canvas_find'] })
  assert.deepEqual(restricted.orderedCatalog, ['canvas_find'])
  assert.equal(chooseTools(rows, { availableTools: ['image_render'], unresolvedInputs: ['prompt'] }).reason, 'clarification_unavailable')
  assert.equal(chooseTools(rows.slice(1)).complete, false)
  assert.equal(chooseTools([...rows, rows[0]]).complete, false)
  assert.throws(() => chooseTools(rows, { availableTools: ['nonexistent'] }), /invalid_selection_state/u)
  const empty = requests.map((r) => ({ ...r, prediction: 'not_needed', ms: 10, promptTokens: 7 }))
  const measured = measureChoice(choiceScenarios.filter((s) => s.split === 'holdout'), empty, 'v2')
  assert.equal(measured.modelOnly.recall, 0)
  assert.equal(measured.withSameStateGuard.truePositives, 2)
  assert.equal(measured.reportedPromptTokens, 128 * 7)
  assert.equal(measured.actualCatalogReduction, 0)
  assert.equal(measured.gate, false)
  const result = { choices: [{ message: { content: JSON.stringify({ intent: binaryOptions[0] }) } }],
    this_that: { choice: binaryOptions[0], confidence: 0.9, probabilities: { [binaryOptions[0]]: 0.9, [binaryOptions[1]]: 0.1 } } }
  assert.equal(choiceResponse(result, 'v2').prediction, 'needed')
  assert.throws(() => choiceResponse({ choices: result.choices }, 'v2'), /missing_probability/u)
  assert.throws(() => choiceResponse({ ...result, this_that: { ...result.this_that, confidence: 0.1 } }, 'v2'), /protocol/u)
})

test('CLI 默认离线；384次配对模拟、跨臂中断、拒绝覆盖、无自动重试', () => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-o5-choice-test-'))
  const runner = new URL('./evalAgentToolChoiceO5.mjs', import.meta.url).pathname
  const expected = prepareChoiceRequests().map((r) => {
    const s = choiceScenarios.find((s) => s.id === r.queryId)
    const index = s.required.includes(r.tool) ? 0 : r.variant === 'v1' && s.uncertain.includes(r.tool) ? 2 : 1
    return { body: r.body, label: (r.variant === 'v1' ? toolOptions : binaryOptions)[index] }
  })
  const run = (preload, args = []) => spawnSync(process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(preload), runner, ...args],
    { env: { ...process.env, FLOCK_O5_API_KEY: 'synthetic-secret' }, input: JSON.stringify(expected), encoding: 'utf8', timeout: 15000 })
  const noNetwork = "globalThis.fetch=()=>{throw new Error('unexpected_network')}"
  const preload = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';const expected=JSON.parse(readFileSync(0,'utf8'));let i=0;
    globalThis.fetch=async(url,init)=>{
      assert.equal(init.redirect,'error');
      if(url==='https://api.flock.io/model/info')return {ok:true,json:async()=>({data:[{model_name:'this-that-model-1.0',model_info:{}}]})};
      assert.equal(url,'https://api.flock.io/v1/chat/completions'); assert.ok(i<384);
      const item=expected[i++]; assert.deepEqual(JSON.parse(init.body),item.body);
      const options=item.body.response_format.json_schema.schema.properties.intent.enum;
      return {ok:true,headers:{get:()=>null},json:async()=>({choices:[{message:{content:JSON.stringify({intent:item.label})}}],
        this_that:{choice:item.label,confidence:0.98,probabilities:Object.fromEntries(options.map(l=>[l,l===item.label?0.98:0.02/(options.length-1)]))}})};
    };`
  try {
    const offline = run(noNetwork)
    assert.equal(offline.status, 0, offline.stderr)
    const preflight = JSON.parse(offline.stdout)
    assert.equal(preflight.rows.length, 0)
    assert.equal(preflight.metrics.holdout.v2.modelOnly.recall, null)
    const output = join(directory, 'success.json')
    const remote = run(preload, ['--remote', '--output', output])
    assert.equal(remote.status, 0, remote.stderr)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(report.rows.length, 384)
    assert.equal(report.metrics.holdout.v2.withSameStateGuard.recall, 1)
    assert.equal(report.requestSha256, preflight.requestSha256)
    assert.equal(report.productionAdmission, false)
    assert.ok(!JSON.stringify(report).includes('synthetic-secret'))
    const duplicate = run(noNetwork, ['--remote', '--output', output])
    assert.equal(duplicate.status, 2)
    assert.match(duplicate.stderr, /output_exists_no_requests_sent/u)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report)
    const failedOutput = join(directory, 'failed.json')
    const fail = run(preload + `const real=fetch;let n=0;globalThis.fetch=(url,init)=>url.endsWith('/model/info')?real(url,init):
      (++n===1?real(url,init):n===2?{ok:false,status:503,headers:{get:()=>null}}:assert.fail('retry forbidden'));`, ['--remote', '--output', failedOutput])
    assert.equal(fail.status, 1, fail.stderr)
    const partial = JSON.parse(readFileSync(failedOutput, 'utf8'))
    assert.equal(partial.rows.length, 1)
    assert.equal(partial.attemptedRequests, 2)
    assert.equal(partial.metrics.dev.v1.completedPairs, 0)
    assert.equal(partial.metrics.dev.v2.completedPairs, 0)
  } finally {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name))
    rmdirSync(directory)
  }
})
