import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanvasDocument, GenerationModelOption } from '../../domain/canvas.ts'
import { runCanvasClarityBoost } from './canvasGenerationInteraction.ts'

const models: GenerationModelOption[] = [{
  id: 'gemini-3.1-pro-preview', label: 'Nano Banana', provider: 'flock', mediaKind: 'image',
  aspectRatios: ['3:4'], resolutions: ['1K', '2K', '4K'],
}]

function document(id = 'project-1'): CanvasDocument {
  return {
    id, name: 'Project', updatedAt: 1, nodes: [{
      id: 'result-1', type: 'result', position: { x: 0, y: 0 },
      data: {
        kind: 'result', image: '/image.png', generationSettings: {
          model: 'gpt-image-2', aspectRatio: '3:4', resolution: '2K',
        },
      },
    }], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, assets: [], assetGroups: [],
    templates: [], history: [], agentSessions: [], generationJobs: [],
  }
}

test('4K action creates a faithful Nano branch before submitting it', async () => {
  const current = document()
  const events: string[] = []
  const started = await runCanvasClarityBoost({
    parentResultId: 'result-1', prompt: 'Keep the subject.', models,
    readDocument: () => current,
    createBranch: (_id, draft) => {
      assert.equal(draft.settings.model, 'gemini-3.1-pro-preview')
      assert.equal(draft.settings.resolution, '4K')
      assert.equal(draft.refinementMode, 'faithful')
      events.push('created')
      return 'branch-1'
    },
    beforeRun: (id) => events.push(`prepared:${id}`),
    runGraphGeneration: async (id) => { events.push(`run:${id}`); return true },
    onStarted: () => events.push('opened'),
  })
  assert.equal(started, true)
  assert.deepEqual(events, ['created', 'prepared:branch-1', 'run:branch-1', 'opened'])
})

test('historical result without settings still receives an executable 4K recipe', async () => {
  const current = document()
  const result = current.nodes[0].data as { generationSettings?: unknown }
  delete result.generationSettings
  let model = ''
  let resolution = ''
  await runCanvasClarityBoost({
    parentResultId: 'result-1', prompt: 'Keep the subject.', models,
    readDocument: () => current,
    createBranch: (_id, draft) => {
      model = draft.settings.model
      resolution = draft.settings.resolution
      return 'branch-1'
    },
    beforeRun: () => undefined,
    runGraphGeneration: async () => true,
    onStarted: () => undefined,
  })
  assert.equal(model, 'gemini-3.1-pro-preview')
  assert.equal(resolution, '4K')
})

test('project changes while submitting do not open another project results', async () => {
  let current = document()
  let opened = false
  const started = await runCanvasClarityBoost({
    parentResultId: 'result-1', prompt: 'Keep the subject.', models,
    readDocument: () => current,
    createBranch: () => 'branch-1',
    beforeRun: () => undefined,
    runGraphGeneration: async () => { current = document('project-2'); return true },
    onStarted: () => { opened = true },
  })
  assert.equal(started, false)
  assert.equal(opened, false)
})
