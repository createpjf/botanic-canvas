import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function localMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+\.md)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
}

test('Agent 从仓库入口可以找到有效的产品架构与代码地图', () => {
  const requiredEntryPoints = [
    'AGENTS.md',
    'docs/CODEMAP.md',
    'docs/PRODUCT_ARCHITECTURE.md',
  ]

  for (const path of requiredEntryPoints) {
    assert.equal(existsSync(resolve(rootDir, path)), true, `缺少 Agent 入口：${path}`)
  }

  const readmePath = resolve(rootDir, 'README.md')
  const readme = readFileSync(readmePath, 'utf8')
  for (const link of localMarkdownLinks(readme)) {
    assert.equal(existsSync(resolve(dirname(readmePath), link)), true, `README 链接失效：${link}`)
  }
})
