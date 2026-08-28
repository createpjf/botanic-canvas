import type { CanvasDocument, GenerationModelOption, GenerationSettings, ResultNodeData } from '../../domain/canvas.ts'
import {
  applyClarityBoost,
  defaultImageGenerationModel,
  defaultSettingsForModel,
} from '../../domain/generationRecipe.ts'

type RunClarityBoostInput = {
  parentResultId: string
  prompt: string
  models: readonly GenerationModelOption[]
  readDocument: () => CanvasDocument
  createBranch: (resultNodeId: string, draft: {
    prompt: string
    settings: GenerationSettings
    refinementMode: 'faithful'
    batchCount: 1
  }) => string | null
  beforeRun: (branchId: string) => void
  runGraphGeneration: (branchId: string) => Promise<boolean>
  onStarted: () => void
}

/** Owns the 4K branch recipe, project-race guard and result navigation. */
export async function runCanvasClarityBoost({
  parentResultId,
  prompt,
  models,
  readDocument,
  createBranch,
  beforeRun,
  runGraphGeneration,
  onStarted,
}: RunClarityBoostInput) {
  const document = readDocument()
  const parentNode = document.nodes.find((node) => node.id === parentResultId && node.type === 'result')
  if (!parentNode || parentNode.type !== 'result') return false
  const parent = parentNode.data as ResultNodeData
  const currentSettings = parent.generationSettings
    ?? parent.generationRecipe?.settings
    ?? defaultSettingsForModel(defaultImageGenerationModel(models, 'image'))
  const branchId = createBranch(parentResultId, {
    prompt,
    settings: applyClarityBoost(currentSettings, models),
    refinementMode: 'faithful',
    batchCount: 1,
  })
  if (!branchId) return false
  beforeRun(branchId)
  const started = await runGraphGeneration(branchId)
  if (readDocument().id !== document.id) return false
  if (started) onStarted()
  return started
}
