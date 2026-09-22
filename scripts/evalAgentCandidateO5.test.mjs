import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidateScenarios, candidateLabels, candidateOptions } from './fixtures/agentCandidateO5.mjs'
import { candidateRequest, candidateResponse, prepareCandidates, rankCandidates, measureCandidates } from './evalAgentCandidateO5.mjs'

test('候选实验复用三个现有读取路径，按场景隔离，传输白名单不含 gold 或私有字段', async () => {
  assert.equal(candidateScenarios.length, 30)
  assert.equal(new Set(candidateScenarios.map((s) => s.family)).size, 30)
  const prepared = await prepareCandidates()
  const dev = new Set(prepared.filter((s) => s.split === 'dev').map((s) => s.family))
  assert.equal(dev.size, 12)
  assert.ok(prepared.filter((s) => s.split === 'holdout').every((s) => !dev.has(s.family)))
  for (const source of ['canvas', 'artifacts', 'rules']) assert.equal(prepared.filter((s) => s.source === source).length, 10)
  for (const s of prepared) {
    assert.equal(s.candidates.length, 3)
    assert.deepEqual(new Set(s.candidates.map((c) => c.id)), new Set(s.poolGold.map((c) => c.id)))
    for (const c of s.candidates) {
      assert.ok(candidateLabels.includes(c.gold))
      const body = candidateRequest(s, c)
      assert.deepEqual(body, candidateRequest({ ...s, gold: 'poison', query: 'poison', privateUrl: 'poison', split: 'poison' },
        { ...c, id: 'poison', gold: 'poison', rationale: 'poison', privateUrl: 'poison', apiKey: 'poison' }))
      assert.ok(!JSON.stringify(body).includes('poison'))
      assert.deepEqual(body.response_format.json_schema.schema.properties.intent.enum, candidateOptions)
    }
  }
})

test('排序与拒答分开计分，不改变候选集合，未召回与未完成不能伪造成功', () => {
  const candidates = [{ id: 'a', gold: 'mismatch' }, { id: 'b', gold: 'match' }, { id: 'c', gold: 'insufficient' }]
  const scenario = { id: 'q', candidates, poolGold: [...candidates, { id: 'outside', gold: 'match' }], baselineMs: 2 }
  const rows = candidates.map((c) => ({ queryId: 'q', id: c.id, prediction: c.gold, score: 0.8, ms: 10,
    probabilities: Object.fromEntries(candidateLabels.map((l) => [l, l === c.gold ? 0.8 : 0.1])) }))
  assert.deepEqual(rankCandidates(scenario, rows), { complete: true, order: ['b', 'a', 'c'], suggestedId: 'b' })
  const metrics = measureCandidates([scenario], rows)
  assert.equal(metrics.baselineAll.recallAt3, 0.5)
  assert.equal(metrics.rankingPaired.baselineHitAt1, 0)
  assert.equal(metrics.rankingPaired.rerankedHitAt1, 1)
  assert.equal(metrics.rankingPaired.baselineMrr, 0.5)
  assert.equal(metrics.rankingPaired.rerankedMrr, 1)
  assert.equal(metrics.rankingPaired.harmfulCandidatePromotions, 0)
  assert.ok(Math.abs(metrics.classification.multiclassBrier - 0.06) < 1e-9)
  const incomplete = measureCandidates([scenario], rows.slice(1))
  assert.equal(incomplete.completedQueries, 0)
  assert.equal(incomplete.rankingPaired.rerankedHitAt1, null)
  assert.deepEqual(incomplete.queryResults[0].order, ['a', 'b', 'c'])
  const negative = { ...scenario, candidates: candidates.map((c) => ({ ...c, gold: 'insufficient' })) }
  negative.poolGold = negative.candidates
  assert.equal(measureCandidates([negative], rows).suggestions.noMatchFalseAccepts, 1)
  const abstain = rows.map((r) => ({ ...r, prediction: 'insufficient', probabilities: { match: 0.1, mismatch: 0.1, insufficient: 0.8 } }))
  const fallback = measureCandidates([negative], abstain)
  assert.deepEqual(fallback.queryResults[0].order, ['a', 'b', 'c'])
  assert.equal(fallback.suggestions.offered, 0)
  assert.equal(fallback.suggestions.precision, null)
  assert.equal(fallback.suggestions.noMatchFalseAccepts, 0)
})

test('响应必须提供三类完整合法概率，缺失或矛盾分布不拿来排序', () => {
  const data = { choices: [{ message: { content: '{"intent":"匹配"}' } }],
    this_that: { choice: '匹配', confidence: 0.8, probabilities: { 匹配: 0.8, 不匹配: 0.15, 信息不足: 0.05 } } }
  assert.deepEqual(candidateResponse(data), { prediction: 'match', score: 0.8, probabilities: { match: 0.8, mismatch: 0.15, insufficient: 0.05 } })
  assert.throws(() => candidateResponse({ choices: data.choices }), /missing_probability_distribution/u)
  assert.throws(() => candidateResponse({ ...data, this_that: { ...data.this_that, confidence: 0.9 } }), /protocol/u)
  assert.throws(() => candidateResponse({ ...data, this_that: { ...data.this_that, probabilities: { 匹配: 0.8, 不匹配: 0.2 } } }), /protocol/u)
})

test('CLI 默认不出网，真实调用需新结果文件；模拟 90 次与故障不重试，不覆盖旧证据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'botanic-o5-candidate-test-'))
  const runner = new URL('./evalAgentCandidateO5.mjs', import.meta.url).pathname
  const fixtureUrl = new URL('./fixtures/agentCandidateO5.mjs', import.meta.url).href
  const run = (preload, args = []) => spawnSync(process.execPath,
    ['--import', 'data:text/javascript,' + encodeURIComponent(preload), runner, ...args],
    { env: { ...process.env, FLOCK_O5_API_KEY: 'synthetic-test-secret' }, encoding: 'utf8', timeout: 15000 })
  const noNetwork = "globalThis.fetch = () => { throw new Error('unexpected_network') }"
  try {
    const offline = run(noNetwork)
    assert.equal(offline.status, 0, offline.stderr)
    const prepared = JSON.parse(offline.stdout)
    assert.equal(prepared.status, 'prepared_not_evaluated')
    assert.equal(prepared.candidateRows.length, 0)
    assert.equal(prepared.metrics.holdout.classification.accuracy, null)
    const ordered = ['dev', 'holdout'].flatMap((split) => prepared.syntheticQueries.filter((s) => s.split === split)
      .flatMap((s) => s.candidates.map((c) => ({ body: candidateRequest(s, c), gold: c.gold }))))
    const preload = `
      import assert from 'node:assert/strict';
      import {candidateLabels,candidateOptions} from '${fixtureUrl}';
      const ordered = ${JSON.stringify(ordered)};
      let calls=0;
      globalThis.fetch = async (url, init) => {
        assert.equal(init.redirect,'error');
        if(url==='https://api.flock.io/model/info') return {ok:true,json:async()=>({data:[{model_name:'this-that-model-1.0',model_info:{input_cost_per_token:0,output_cost_per_token:0}}]})};
        assert.equal(url,'https://api.flock.io/v1/chat/completions');
        assert.ok(calls<90);
        assert.deepEqual(JSON.parse(init.body),ordered[calls].body);
        const label=candidateOptions[candidateLabels.indexOf(ordered[calls++].gold)];
        return {ok:true,headers:{get:()=>null},json:async()=>({model:'synthetic-test-model',
          choices:[{message:{content:JSON.stringify({intent:label})}}],
          this_that:{choice:label,confidence:0.98,probabilities:Object.fromEntries(candidateOptions.map(l=>[l,l===label?0.98:0.01]))}})};
      };
    `
    const output = join(directory, 'success.json')
    const remote = run(preload, ['--remote', '--output', output])
    assert.equal(remote.status, 0, remote.stderr)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    assert.equal(report.candidateRows.length, 90)
    assert.equal(report.metrics.holdout.completedPairs, 54)
    assert.equal(report.metrics.holdout.classification.accuracy, 1)
    assert.equal(report.metrics.holdout.rankingPaired.rerankedHitAt1, 1)
    assert.equal(report.metrics.holdout.suggestions.noMatchFalseAccepts, 0)
    assert.equal(report.productionAdmission, false)
    assert.equal(report.requestSha256, prepared.requestSha256)
    assert.ok(!JSON.stringify(report).includes('synthetic-test-secret'))
    const duplicate = run(noNetwork, ['--remote', '--output', output])
    assert.equal(duplicate.status, 2)
    assert.match(duplicate.stderr, /output_exists_no_requests_sent/u)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report)
    const failedOutput = join(directory, 'failed.json')
    const failure = run(preload + `
      const original=globalThis.fetch;let attempts=0;
      globalThis.fetch=(url,init)=>url.endsWith('/model/info')?original(url,init):
        (++attempts===1?{ok:false,status:503,headers:{get:()=>null}}:assert.fail('retry forbidden'));
    `, ['--remote', '--output', failedOutput])
    assert.equal(failure.status, 1, failure.stderr)
    const failed = JSON.parse(readFileSync(failedOutput, 'utf8'))
    assert.equal(failed.attemptedRequests, 1)
    assert.equal(failed.status, 'incomplete')
    assert.equal(failed.stopped.reason, 'http_503')
    assert.equal(failed.metrics.holdout.classification.accuracy, null)
  } finally {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name))
    rmdirSync(directory)
  }
})
