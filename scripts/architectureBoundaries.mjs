import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx'])
const staticImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const commonJsRequirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const ownershipPolicies = Object.freeze({
  'server/agentRoutes.mjs': {
    maxLines: 2263,
    forbidden: [
      ['agentTurnRuntime.execute', 'agent-routes-cannot-execute-turn-runtime'],
      ['createAgentTurnRecord', 'agent-routes-cannot-create-turn-record'],
    ],
  },
  'src/features/agent/AgentWorkspace.tsx': {
    maxLines: 3853,
    forbidden: [
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
    if (ownership) {
      const lineCount = source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
      if (lineCount > ownership.maxLines) violations.push({
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
