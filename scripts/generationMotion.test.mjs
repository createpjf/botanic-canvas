import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('生成中结果节点与任务卡提供真实动效并尊重减少动效设置', () => {
  assert.match(styles, /\.result-node__task-state--generating::before\s*{[^}]*animation:\s*result-task-sheen/s)
  assert.match(styles, /\.result-node__task-pulse\s*{[^}]*animation:\s*result-task-pulse/s)
  assert.match(styles, /@keyframes\s+result-task-sheen/)
  assert.match(styles, /@keyframes\s+result-task-pulse/)
  assert.match(styles, /\.agent-run-card__track::after\s*{[^}]*animation:\s*agent-run-track-flow/s)
  assert.match(styles, /@keyframes\s+agent-run-track-flow/)
  assert.match(
    styles,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.result-node__task-state--generating::before,[^}]*\.result-node__task-pulse,[^}]*animation:\s*none/s,
  )
  assert.match(
    styles,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.agent-run-card__track::after[^}]*animation:\s*none/s,
  )
})
