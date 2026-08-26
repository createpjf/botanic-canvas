import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const resultNode = readFileSync(new URL('../src/features/canvas/CanvasEditorViews.tsx', import.meta.url), 'utf8')
const dotsRuntime = readFileSync(new URL('../src/components/generationDotsFieldRuntime.ts', import.meta.url), 'utf8')
const dotsField = readFileSync(new URL('../src/components/generationDotsField.ts', import.meta.url), 'utf8')

test('生成中结果节点铺满 flow 点阵并尊重减少动效设置', () => {
  assert.match(styles, /\.generation-dots-fill\s*{[^}]*position:\s*absolute/s)
  assert.match(styles, /\.generation-dots-fill\s*{[^}]*inset:\s*0/s)
  assert.doesNotMatch(styles, /\.liquid-progress/)
  assert.doesNotMatch(resultNode, /LiquidProgressBar/)
  assert.doesNotMatch(resultNode, /liquid-progress/)
  assert.match(resultNode, /<GenerationDotsField\b/)
  assert.match(resultNode, /result-node__task-copy/)
  assert.doesNotMatch(resultNode, /generationProgress/)
  assert.doesNotMatch(resultNode, /taskStatus=\{result.taskStatus\}/)
  assert.doesNotMatch(resultNode, /submittedAt=\{result.submittedAt\}/)
  assert.match(dotsRuntime, /fillGenerationDotsPixels/)
  assert.match(dotsRuntime, /reducedMotion/)
  assert.doesNotMatch(dotsRuntime, /generationLiquidTravel/)
  assert.doesNotMatch(dotsRuntime, /generationProgress/)
  assert.doesNotMatch(dotsField, /generationProgress/)
  assert.doesNotMatch(dotsField, /taskStatus/)
  assert.match(dotsField, /speed:\s*0\.36/)
  assert.match(dotsField, /dotSize:\s*2/)
  assert.match(dotsField, /gridDensity:\s*1\.5/)
  assert.match(dotsField, /patternScale:\s*0\.7/)
  assert.match(dotsField, /vignette:\s*1\.45/)
  assert.match(dotsField, /0\.02 \//)
  assert.match(styles, /\.result-node__task-state--generating \.result-node__task-copy\s*{[^}]*background:/s)
  assert.match(styles, /\.result-node__task-state--generating strong,\s*\.result-node__task-state--generating small\s*{[^}]*white-space:\s*nowrap/s)
  assert.match(styles, /\.agent-run-card__track::after\s*{[^}]*animation:\s*agent-run-track-flow/s)
  assert.match(styles, /@keyframes\s+agent-run-track-flow/)
  assert.match(
    styles,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.agent-run-card__track::after[^}]*animation:\s*none/s,
  )
})
