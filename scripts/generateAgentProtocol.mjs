#!/usr/bin/env node
// Agent Protocol v1 生成器(CS2)。从 server/agentProtocol.mjs 的 catalog 生成:
//   src/domain/agentProtocol.generated.ts   前端类型与 guard(架构上 src 不 import server,
//                                            由生成物携带同一事实)
//   docs/reference/agent-protocol-v1.schema.json   机器可读枚举目录
// 用法:
//   node scripts/generateAgentProtocol.mjs           重新生成
//   node scripts/generateAgentProtocol.mjs --check   验证生成物无漂移(build 前置)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { agentProtocolCatalog } from '../server/agentProtocol.mjs'

const rootDir = resolve(import.meta.dirname, '..')
const catalog = agentProtocolCatalog()

function tsUnion(values) {
  return values.map((value) => `'${value}'`).join(' | ')
}

function tsSource() {
  const lines = [
    '// 本文件由 scripts/generateAgentProtocol.mjs 生成,不要手改。',
    '// source of truth: server/agentProtocol.mjs;npm run build 前会做 --check。',
    '',
    `export const AGENT_PROTOCOL_VERSION = ${catalog.protocolVersion}`,
    '',
  ]
  for (const [name, values] of Object.entries(catalog.enums)) {
    const constName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() + '_VALUES'
    lines.push(`export type ${name} = ${tsUnion(values)}`)
    lines.push(`export const ${constName} = Object.freeze([${values.map((value) => `'${value}'`).join(', ')}]) as readonly ${name}[]`)
    lines.push(`const ${name}Set: ReadonlySet<string> = new Set(${constName})`)
    lines.push(`export function is${name}(value: unknown): value is ${name} {`)
    lines.push(`  return typeof value === 'string' && ${name}Set.has(value)`)
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n')
}

function schemaSource() {
  return JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://botanic.internal/agent-protocol-v1.schema.json',
    title: 'Botanic Agent Protocol v1',
    description: '公共 Turn/Event/Error 枚举目录。source of truth: server/agentProtocol.mjs。',
    protocolVersion: catalog.protocolVersion,
    $defs: Object.fromEntries(Object.entries(catalog.enums).map(([name, values]) => [
      name,
      { type: 'string', enum: [...values] },
    ])),
  }, null, 2) + '\n'
}

const artifacts = [
  [resolve(rootDir, 'src/domain/agentProtocol.generated.ts'), tsSource()],
  [resolve(rootDir, 'docs/reference/agent-protocol-v1.schema.json'), schemaSource()],
]

const checking = process.argv.includes('--check')
let drifted = false
for (const [path, content] of artifacts) {
  if (checking) {
    let current = ''
    try { current = readFileSync(path, 'utf8') } catch { /* 缺文件也算漂移 */ }
    if (current !== content) {
      console.error(`protocol drift: ${path} 与 catalog 不一致,请运行 node scripts/generateAgentProtocol.mjs`)
      drifted = true
    }
    continue
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  console.log(`generated ${path}`)
}
if (checking && drifted) process.exit(1)
if (checking) console.log('agent protocol artifacts: OK')
