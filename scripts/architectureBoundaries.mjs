import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx'])
const staticImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g

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

  if (source.startsWith('src/') && (target === 'server' || target.startsWith('server/'))) {
    return 'frontend-cannot-import-server'
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

export function checkArchitectureBoundaries({ rootDir }) {
  const violations = []
  for (const file of sourceFiles(resolve(rootDir, 'src'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(staticImportPattern)) {
      const importPath = match[1]
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
  }
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
