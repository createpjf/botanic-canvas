import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { samples, taxonomy } from './fixtures/agentDecisionO5.mjs'
import { retrievalSamples, retrievalVariants, retrievalTaxonomy } from './fixtures/agentRetrievalO5.mjs'
import { classifyResponse, measure, calibrate, requestFor, measureRetrieval, chooseRetrievalVariant, retrievalDisposition } from './evalAgentDecisionO5.mjs'

test('O5 固定合成集按族分割，输入不包含 gold，协议仅接受受控标签和有效分布', () => {
  assert.equal(samples.length, 240)
  assert.equal(new Set(samples.map((s) => s.id)).size, 240)
  const dev = new Set(samples.filter((s) => s.split === 'dev').map((s) => s.family))
  assert.ok(samples.filter((s) => s.split === 'holdout').every((s) => !dev.has(s.family)))
  for (const label of taxonomy) assert.equal(samples.filter((s) => s.label === label).length, 40)
  assert.deepEqual(requestFor(samples[0]), requestFor({ ...samples[0], label: 'generation', category: 'changed' }))
  const response = { choices: [{ message: { content: '{"intent":"research"}' } }], this_that: {
    choice: 'research', confidence: 0.75,
    probabilities: Object.fromEntries(taxonomy.map((l) => [l, l === 'research' ? 0.75 : 0.05])),
  } }
  assert.deepEqual(classifyResponse(response), { label: 'research', score: 0.75 })
  assert.equal(classifyResponse({ choices: response.choices }).score, null)
  assert.throws(() => classifyResponse({ choices: [{ message: { content: '{"intent":"authorized"}' } }] }), /protocol/u)
  assert.throws(() => classifyResponse({ ...response, this_that: { ...response.this_that, confidence: 2 } }), /protocol/u)
})

test('O5 阈值只用开发集，弃权保留 FN，缺少分数不假装可靠', () => {
  const rows = [
    { id: 'a', split: 'dev', label: 'generation', prediction: 'generation', score: 0.95, ms: 10 },
    { id: 'b', split: 'dev', label: 'unknown', prediction: 'generation', score: 0.8, ms: 20 },
    { id: 'c', split: 'holdout', label: 'prompt', prediction: 'prompt', score: 0.4, ms: 30 },
  ]
  const threshold = calibrate(rows)
  assert.ok(threshold > 0.8 && threshold <= 0.95)
  assert.equal(calibrate([...rows, { ...rows[2], prediction: 'generation', score: 1 }]), threshold)
  const report = measure(rows, threshold)
  assert.equal(report.perClass.prompt.recall, 0)
  assert.equal(report.coverage, 1 / 3)
  assert.equal(measure([{ ...rows[0], score: null }], 0).coverage, 0)
})

test('O5 检索小题按族隔离、状态成对、仅单变量对照，gold 与授权不进入模型输入', () => {
  assert.equal(retrievalSamples.length, 48)
  assert.equal(new Set(retrievalSamples.map((s) => s.id)).size, 48)
  const dev = new Set(retrievalSamples.filter((s) => s.split === 'dev').map((s) => s.family))
  assert.ok(retrievalSamples.filter((s) => s.split === 'holdout').every((s) => !dev.has(s.family)))
  for (const pair of Object.values(Object.groupBy(retrievalSamples, (s) => s.pairId))) {
    assert.equal(pair.length, 2)
    assert.equal(pair[0].text, pair[1].text)
    assert.notDeepEqual(pair[0].state, pair[1].state)
  }
  for (const sample of retrievalSamples) {
    assert.ok(retrievalTaxonomy.includes(sample.label))
    assert.ok(sample.label === 'defer' || sample.state.availableSources.includes(sample.label) || sample.prerequisite === 'source_unavailable')
    for (const variant of retrievalVariants) {
      const body = requestFor(sample, variant)
      assert.deepEqual(body, requestFor({ ...sample, label: 'poisoned', semanticIntent: 'poisoned',
        prerequisite: 'poisoned', state: { ...sample.state, approval: 'poisoned', privateUrl: 'poisoned' } }, variant))
      assert.ok(!JSON.stringify(body).includes('poisoned'))
    }
    const full = requestFor(sample)
    const bare = requestFor(sample, 'bare-json')
    assert.deepEqual(full.messages, bare.messages)
    const prose = requestFor(sample, 'described-prose')
    const absent = requestFor(sample, 'no-state-json')
    for (const body of [prose, absent]) {
      assert.deepEqual(full.response_format, body.response_format)
      assert.deepEqual(full.messages[1], body.messages[1])
    }
    assert.deepEqual(JSON.parse(absent.messages[0].content), { request: sample.text })
    const options = full.response_format.json_schema.schema.properties.intent.enum
    const response = { choices: [{ message: { content: JSON.stringify({ intent: options[0] }) } }] }
    assert.deepEqual(classifyResponse(response, options), { label: options[0], score: null })
    assert.throws(() => classifyResponse({ choices: [{ message: { content: '{"intent":"authorized"}' } }] }, options), /protocol/u)
  }
  const edits = retrievalSamples.filter((s) => s.family === 'edit-not-lookup')
  assert.ok(edits.every((s) => s.semanticIntent === 'generation' && s.label === 'defer'))
  assert.equal(new Set(edits.map((s) => s.prerequisite)).size, 2)
})

test('O5 检索选择不读取 holdout，缺分数和不可用来源回退，弃权不能隐藏错题', () => {
  const rows = retrievalVariants.flatMap((variant) => retrievalSamples.map((s) => ({ ...s, variant, prediction: s.label, score: 0.9, ms: 1 })))
  const choice = chooseRetrievalVariant(rows)
  assert.equal(choice.variant, 'described-json')
  assert.equal(choice.threshold, 0)
  assert.ok(choice.macroF1 > 0 && choice.macroF1 < 1) // Correct but unavailable sources still reduce coverage/F1.
  assert.deepEqual(chooseRetrievalVariant(rows.map((r) => r.split === 'holdout' ? { ...r, prediction: 'wrong', score: 0 } : r)), choice)
  assert.equal(chooseRetrievalVariant(rows.filter((r) => r.id !== retrievalSamples[0].id)), null)
  const row = { ...retrievalSamples[0], prediction: 'canvas', score: 0.8 }
  assert.equal(retrievalDisposition({ ...row, score: null }, 0).reason, 'missing_score')
  assert.equal(retrievalDisposition(row, 0.9).reason, 'low_confidence')
  assert.equal(retrievalDisposition({ ...row, prediction: 'authorized' }, 0).reason, 'invalid_label')
  assert.equal(retrievalDisposition({ ...row, state: { availableSources: ['rules'] } }, 0).reason, 'unavailable_source')
  const metrics = measureRetrieval([row, { ...row, label: 'defer', prediction: 'defer' }], 0.9)
  assert.equal(metrics.coverage, 0)
  assert.equal(metrics.selectiveAccuracy, null)
  assert.equal(metrics.accuracy, 0.5)
  assert.equal(metrics.perClass.canvas.f1, 0)
  assert.equal(metrics.fallbackReasons.model_defer, 1)
  assert.equal(metrics.fallbackReasons.low_confidence, 1)
  assert.equal(measureRetrieval([]).accuracy, null)
})

test('O5 检索 CLI 默认不出网；模拟远端只在开发集选版本，留出集仅调用一次', () => {
  // Isolated fake fetch: no credentials, network, files or actual model quality claims.
  const runner = new URL('./evalAgentDecisionO5.mjs', import.meta.url).pathname
  const preload = `
    import assert from 'node:assert/strict';
    import { retrievalSamples, retrievalVariants, retrievalTaxonomy, retrievalInput } from '${new URL('./fixtures/agentRetrievalO5.mjs', import.meta.url).href}';
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/model/info')) return { ok: true, json: async () => ({ data: [{model_name:'this-that-model-1.0', model_info:{input_cost_per_token:0,output_cost_per_token:0}}] }) };
      assert.ok(calls < 120);
      const variant = calls < 96 ? retrievalVariants[Math.floor(calls / 24)] : 'described-json';
      const split = calls < 96 ? 'dev' : 'holdout';
      const sample = retrievalSamples.filter(s => s.split === split)[calls % 24];
      const body = JSON.parse(init.body);
      const expected = retrievalInput(sample, variant);
      assert.equal(body.messages[0].content, expected.state);
      assert.equal(body.messages[1].content, expected.question);
      calls++;
      const options = body.response_format.json_schema.schema.properties.intent.enum;
      assert.deepEqual(options, expected.options);
      const label = options[retrievalTaxonomy.indexOf(sample.label)];
      return {ok:true, headers:{get:()=>null}, json:async()=>({model:body.model,
        choices:[{message:{content:JSON.stringify({intent:label})}}],
        this_that:{choice:label, confidence:0.97, probabilities:Object.fromEntries(options.map(o=>[o,o===label?0.97:0.01]))}})};
    };
  `
  const child = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), runner, '--retrieval', '--remote'],
    { env: { ...process.env, FLOCK_O5_API_KEY: 'synthetic-test-only' }, encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status, 0, child.stderr)
  const report = JSON.parse(child.stdout)
  assert.equal(report.candidateRows.length, 120)
  assert.equal(report.holdout.raw.n, 24)
  assert.equal(report.dev['no-state-json'].raw.n, 24)
  assert.equal(report.selection.variant, 'described-json')
  assert.equal(report.productionAdmission, false)
  const offline = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(
    "globalThis.fetch = () => { throw new Error('unexpected_network') }"), runner, '--retrieval'], { encoding: 'utf8', timeout: 15000 })
  assert.equal(offline.status, 0, offline.stderr)
  const prepared = JSON.parse(offline.stdout)
  assert.equal(prepared.status, 'prepared_not_evaluated')
  assert.equal(prepared.selection, null)
  assert.equal(prepared.candidateRows.length, 0)
})
