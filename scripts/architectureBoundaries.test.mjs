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

test('动态导入和服务端反向依赖不能绕过架构检查', () => {
  const rootDir = fixture({
    'src/components/AsyncCard.tsx': "const load = () => import('../lib/db')\n",
    'server/router.mjs': "import { readCanvasProject } from '../src/lib/db.ts'\n",
  })

  try {
    const violations = checkArchitectureBoundaries({ rootDir })
    assert.deepEqual(violations.map((item) => item.rule), [
      'server-cannot-import-frontend',
      'ui-cannot-import-infrastructure',
    ])
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('运行时模块循环会被架构检查拒绝', () => {
  const rootDir = fixture({
    'server/a.mjs': "import { b } from './b.mjs'\nexport const a = b\n",
    'server/b.mjs': "import { a } from './a.mjs'\nexport const b = a\n",
  })

  try {
    const violations = checkArchitectureBoundaries({ rootDir })
    assert.deepEqual(violations.map((item) => item.rule), ['dependency-cycle'])
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('核心编排不能重新拥有 Turn 执行与恢复，也不能突破复杂度预算', () => {
  const rootDir = fixture({
    'server/agentRoutes.mjs': 'agentTurnRuntime.execute(command)\n',
    'src/features/agent/AgentWorkspace.tsx': 'retryBotanicAgentTurnRecovery(command)\n',
  })

  try {
    const violations = checkArchitectureBoundaries({ rootDir })
    assert.deepEqual(violations.map((item) => item.rule), [
      'agent-routes-cannot-execute-turn-runtime',
      'agent-workspace-cannot-own-turn-recovery',
    ])
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('Botanic 当前源码遵守模块依赖方向', () => {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  assert.deepEqual(checkArchitectureBoundaries({ rootDir }), [])
})
