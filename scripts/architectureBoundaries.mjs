import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx'])
const staticImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const commonJsRequirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
// Agent 模型传输细节只属于 botanicAgentModelProvider.mjs(计划 1B):这些 owner
// 不得再出现 endpoint/鉴权头/SSE reader,防止第二份 transport 静默长回来。
const agentSamplingTransportForbidden = Object.freeze([
  ['/chat/completions', 'agent-caller-cannot-own-model-transport'],
  ["Authorization: `Bearer", 'agent-caller-cannot-own-model-auth'],
  ['readStreamedChatCompletion', 'agent-caller-cannot-own-stream-reader'],
])

// —— 模块大小 gate（学 Codex 500/800 规则的 JS 等价物）——
// 新文件(非测试)硬上限 800 行;存量超限文件按当前行数冻结为各自上限,只准降不准升。
// 从此列表移除文件是唯一"毕业"方式;新增条目需要维护者明确批准。
export const MODULE_SIZE_CEILING = 800
export const legacyOversizeBudgets = Object.freeze({
  'server/store/postgresProductStore.mjs': 3779,
  'src/features/agent/AgentWorkspace.tsx': 3920,
  'src/features/canvas/CanvasWorkspace.tsx': 2930,
  'src/domain/agent.ts': 2870,
  'server/store/supabaseProductStore.mjs': 2495,
  'server/store/productStore.mjs': 2465,
  'server/http/agentRoutes.mjs': 1849,
  'src/features/canvas/CanvasWorkspacePanels.tsx': 1921,
  'src/features/canvas/CanvasEditorViews.tsx': 1744,
  'server/agent/tools/agentToolRuntime.mjs': 1524,
  'src/features/agent/AgentConversationMessage.tsx': 1487,
  'server/agent/tools/botanicAgentTools.mjs': 1020,
  'src/lib/agentApi.ts': 1388,
  'src/components/bob/bobImpressions.ts': 1341,
  'server/agent/turn/botanicAgentTurn.mjs': 1273,
  'src/domain/agentTimeline.ts': 1257,
  'src/lib/db.ts': 1102,
  'server/store/productStoreContract.mjs': 1185,
  'server/generation/generationProcessor.mjs': 1041,
  'server/agent/subagent/agentSubagentPersistence.mjs': 1001,
  'src/features/agent/AgentUtilityPanels.tsx': 955,
  'src/store/canvasAssetGraphActions.ts': 901,
  'src/domain/agentVariations.ts': 898,
  'server/agent/turn/botanicAgentTurnRuntime.mjs': 890,
  'server/agent/semantic/botanicAgentPersistence.mjs': 889,
  'server/agent/semantic/botanicAgentPlanner.mjs': 883,
  'src/features/canvas/useCanvasAgentExecutionBridge.ts': 862,
  'server/agent/action/botanicAgentSkill.mjs': 821,
  // 生成的 Bob 角色动画资产(坐标表+渲染循环),按资产豁免而非业务模块。
  'src/components/bob/character-runtime.js': 3865,
})

const ownershipPolicies = Object.freeze({
  'server/http/agentRoutes.mjs': {
    maxLines: 1849,
    forbidden: [
      ['agentTurnRuntime.execute', 'agent-routes-cannot-execute-turn-runtime'],
      ['createAgentTurnRecord', 'agent-routes-cannot-create-turn-record'],
    ],
  },
  'server/http/agentActionRoutes.mjs': {
    forbidden: [
      ['agentTurnRuntime.execute', 'agent-routes-cannot-execute-turn-runtime'],
      ['createAgentTurnRecord', 'agent-routes-cannot-create-turn-record'],
    ],
  },
  'server/agent/turn/botanicAgentTurn.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/semantic/botanicAgentChat.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/semantic/botanicAgentPlanner.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/subagent/agentSubagentRunner.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/semantic/botanicAgentVision.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/review/agentReviewVision.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/review/agentReviewSkillEvaluator.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/context/agentContextSummarizer.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/providers/promptRefinementProvider.mjs': { forbidden: agentSamplingTransportForbidden },
  'server/agent/review/botanicAgentReview.mjs': { forbidden: agentSamplingTransportForbidden },
  'src/features/agent/AgentWorkspace.tsx': {
    // Queue-after-turn 增加快照组装/adapters接口;状态机已归 useAgentInstructionQueue,
    // 因此只给编排接口增加67行预算,并用 forbidden 防实现回流。
    maxLines: 3920,
    forbidden: [
      ['enqueueAgentInstruction', 'agent-workspace-cannot-own-input-queue'],
      ['shiftAgentQueuedInstruction', 'agent-workspace-cannot-own-input-queue'],
      ['retryBotanicAgentTurnRecovery', 'agent-workspace-cannot-own-turn-recovery'],
      ['revalidateMissingBotanicAgentTurn', 'agent-workspace-cannot-own-turn-revalidation'],
      ['readProjectAgentActionStatus', 'agent-workspace-cannot-own-action-reconciliation'],
      ['resolveProjectAgentAction', 'agent-workspace-cannot-own-action-reconciliation'],
    ],
  },
})

function extension(path) {
  const match = path.match(/\.[^.]+$/)
  return match?.[0] ?? ''
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return sourceExtensions.has(extension(path)) && !path.endsWith('.test.ts') && !path.endsWith('.test.mjs') ? [path] : []
  })
}

function normalizedRelative(rootDir, path) {
  return relative(rootDir, path).split(sep).join('/')
}

function resolvedProjectImport(file, importPath) {
  if (!importPath.startsWith('.')) return undefined
  return resolve(dirname(file), importPath)
}

function dependencyRule(file, dependency, rootDir) {
  const source = normalizedRelative(rootDir, file)
  const target = normalizedRelative(rootDir, dependency)

  if (source.startsWith('server/') && target.startsWith('src/')) {
    return 'server-cannot-import-frontend'
  }
  if (source.startsWith('src/') && (target === 'server' || target.startsWith('server/'))) {
    return 'frontend-cannot-import-server'
  }
  if (source.startsWith('src/') && target.startsWith('api/')) {
    return 'frontend-cannot-import-status-functions'
  }
  if (source.startsWith('api/') && target.startsWith('server/')) {
    return 'status-functions-cannot-import-railway'
  }
  if (source.startsWith('src/components/')
    && (target.startsWith('src/lib/') || target.startsWith('src/store/'))) {
    return 'ui-cannot-import-infrastructure'
  }
  if (source.startsWith('src/domain/')
    && (target.startsWith('src/lib/')
      || target.startsWith('src/store/')
      || target.startsWith('src/components/')
      || target.startsWith('src/data/')
      || target.startsWith('api/')
      || target === 'src/App'
      || target.startsWith('src/App.'))) {
    return 'domain-cannot-import-application-or-infrastructure'
  }
  if (source.startsWith('src/lib/')
    && (target.startsWith('src/store/')
      || target.startsWith('src/components/')
      || target === 'src/App'
      || target.startsWith('src/App.'))) {
    return 'infrastructure-cannot-import-ui-or-store'
  }
  if (source.startsWith('src/store/')
    && (target.startsWith('src/components/') || target === 'src/App' || target.startsWith('src/App.'))) {
    return 'store-cannot-import-ui'
  }
  return undefined
}

function projectImports(source) {
  return [staticImportPattern, dynamicImportPattern, commonJsRequirePattern]
    .flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]))
}

function runtimeProjectImports(source) {
  const staticImports = [...source.matchAll(staticImportPattern)]
    .filter((match) => !/\b(?:import|export)\s+type\b/.test(match[0]))
    .map((match) => match[1])
  return [
    ...staticImports,
    ...[...source.matchAll(dynamicImportPattern)].map((match) => match[1]),
    ...[...source.matchAll(commonJsRequirePattern)].map((match) => match[1]),
  ]
}

function sourceDependency(file, importPath, files) {
  const unresolved = resolvedProjectImport(file, importPath)
  if (!unresolved) return undefined
  const candidates = [
    unresolved,
    ...sourceExtensions.values().map((suffix) => `${unresolved}${suffix}`),
    ...sourceExtensions.values().map((suffix) => resolve(unresolved, `index${suffix}`)),
  ]
  return candidates.find((candidate) => files.has(candidate))
}

function dependencyCycleViolations(graph, rootDir) {
  const state = new Map()
  const stack = []
  const reported = new Set()
  const violations = []

  function visit(file) {
    state.set(file, 'visiting')
    stack.push(file)
    for (const edge of graph.get(file) ?? []) {
      if (state.get(edge.dependency) === 'visiting') {
        const cycleStart = stack.indexOf(edge.dependency)
        const cycle = [...stack.slice(cycleStart), edge.dependency]
          .map((item) => normalizedRelative(rootDir, item))
        const key = [...new Set(cycle)].sort().join('|')
        if (!reported.has(key)) {
          reported.add(key)
          violations.push({
            file: normalizedRelative(rootDir, file),
            importPath: cycle.join(' -> '),
            rule: 'dependency-cycle',
          })
        }
        continue
      }
      if (!state.has(edge.dependency)) visit(edge.dependency)
    }
    stack.pop()
    state.set(file, 'visited')
  }

  for (const file of graph.keys()) {
    if (!state.has(file)) visit(file)
  }
  return violations
}

export function checkArchitectureBoundaries({ rootDir }) {
  const violations = []
  const files = [
    ...sourceFiles(resolve(rootDir, 'src')),
    ...sourceFiles(resolve(rootDir, 'server')),
    ...sourceFiles(resolve(rootDir, 'api')),
  ]
  const fileSet = new Set(files)
  const graph = new Map(files.map((file) => [file, []]))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const relativeFile = normalizedRelative(rootDir, file)
    const ownership = ownershipPolicies[relativeFile]
    const lineCount = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
    const sizeBudget = legacyOversizeBudgets[relativeFile] ?? MODULE_SIZE_CEILING
    if (lineCount > sizeBudget) {
      violations.push({
        file: relativeFile,
        importPath: `${lineCount} > ${sizeBudget}`,
        rule: legacyOversizeBudgets[relativeFile] ? 'legacy-module-shrink-only' : 'module-size-ceiling',
      })
    }
    if (ownership) {
      if (ownership.maxLines !== undefined && lineCount > ownership.maxLines) violations.push({
        file: relativeFile,
        importPath: `${lineCount} > ${ownership.maxLines}`,
        rule: 'core-orchestration-complexity-budget',
      })
      for (const [pattern, rule] of ownership.forbidden) {
        if (source.includes(pattern)) violations.push({ file: relativeFile, importPath: pattern, rule })
      }
    }
    for (const importPath of projectImports(source)) {
      const dependency = resolvedProjectImport(file, importPath)
      if (!dependency) continue
      const rule = dependencyRule(file, dependency, rootDir)
      if (rule) {
        violations.push({
          file: normalizedRelative(rootDir, file),
          importPath,
          rule,
        })
      }
    }
    for (const importPath of runtimeProjectImports(source)) {
      const dependency = sourceDependency(file, importPath, fileSet)
      if (dependency) graph.get(file).push({ dependency, importPath })
    }
  }
  violations.push(...dependencyCycleViolations(graph, rootDir))
  return violations.sort((left, right) => left.file.localeCompare(right.file) || left.importPath.localeCompare(right.importPath))
}

function run() {
  const rootDir = resolve(process.cwd())
  const violations = checkArchitectureBoundaries({ rootDir })
  if (!violations.length) {
    console.info('Architecture boundaries: OK')
    return
  }
  for (const violation of violations) {
    console.error(`${violation.file}: ${violation.rule} (${violation.importPath})`)
  }
  process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) run()
