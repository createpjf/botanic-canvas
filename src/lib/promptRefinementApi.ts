import { productRequest } from './productSession'

export type PromptRefinementReference = {
  name: string
  role: string
  primary: boolean
}

export type RefinePromptInput = {
  projectId: string
  mode: 'generation' | 'refinement'
  prompt: string
  aspectRatio: string
  references: PromptRefinementReference[]
}

export type RefinePromptResponse = {
  status: 'refined' | 'unchanged'
  prompt: string
}

export function refinePrompt(input: RefinePromptInput, signal?: AbortSignal) {
  return productRequest<RefinePromptResponse>('/api/prompt-refinements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
}
