import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const resultNode = readFileSync(new URL('../src/features/canvas/CanvasEditorViews.tsx', import.meta.url), 'utf8')
const liquidRuntime = readFileSync(new URL('../src/components/liquidProgressBarRuntime.ts', import.meta.url), 'utf8')

test('生成中结果节点与任务卡提供真实动效并尊重减少动效设置', () => {
  assert.match(styles, /\.liquid-progress-fill\s*{[^}]*position:\s*absolute/s)
  assert.match(styles, /\.liquid-progress-fill\s*{[^}]*inset:\s*0/s)
  assert.doesNotMatch(styles, /\.liquid-progress-card\b/)
  assert.doesNotMatch(resultNode, /liquid-progress-card/)
  assert.match(resultNode, /<LiquidProgressBar\b/)
  assert.match(liquidRuntime, /liquidIndeterminateTravel/)
  assert.match(liquidRuntime, /fillLiquidProgressPixels/)
  assert.match(liquidRuntime, /reducedMotion/)
  assert.match(liquidRuntime, /alive/)
  assert.match(styles, /\.agent-run-card__track::after\s*{[^}]*animation:\s*agent-run-track-flow/s)
  assert.match(styles, /@keyframes\s+agent-run-track-flow/)
  assert.match(
    styles,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.agent-run-card__track::after[^}]*animation:\s*none/s,
  )
})
