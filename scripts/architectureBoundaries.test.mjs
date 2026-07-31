import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkArchitectureBoundaries } from './architectureBoundaries.mjs'

function fixture(files) {
  const rootDir = mkdtempSync(join(tmpdir(), 'botanic-architecture-'))
  for (const [path, source] of Object.entries(files)) {
    const target = join(rootDir, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, source)
  }
  return rootDir
}

test('阻止 UI 和领域模块越过已确认的依赖方向', () => {
  const rootDir = fixture({
    'src/components/Card.tsx': "import { submitGenerationJob } from '../lib/generationApi'\n",
    'src/domain/canvas.ts': "import { writeCanvasDocument } from '../lib/db'\n",
  })

  try {
    const violations = checkArchitectureBoundaries({ rootDir })
    assert.deepEqual(violations.map((item) => item.rule), [
      'ui-cannot-import-infrastructure',
      'domain-cannot-import-application-or-infrastructure',
    ])
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('Botanic 当前源码遵守模块依赖方向', () => {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  assert.deepEqual(checkArchitectureBoundaries({ rootDir }), [])
})
