// 一次迁移一个 server/ 簇：git mv 到子目录并改写全仓相对 import。
// 用法: node scripts/moveServerCluster.mjs <subdir> <fileBase...>
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const [subdir, ...bases] = process.argv.slice(2)
if (!subdir || !bases.length) { console.error('usage: moveServerCluster.mjs <subdir> <base...>'); process.exit(1) }
const moved = new Set(bases)
mkdirSync(`server/${subdir}`, { recursive: true })
for (const base of bases) {
  for (const suffix of ['.mjs', '.test.mjs']) {
    const from = `server/${base}${suffix}`
    if (existsSync(from)) execSync(`git mv ${from} server/${subdir}/${base}${suffix}`)
  }
}
const files = execSync("git ls-files '*.mjs' '*.ts' '*.tsx'", { encoding: 'utf8' }).trim().split('\n')
let rewritten = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  let next = source
  if (file.startsWith(`server/${subdir}/`)) {
    // 簇内文件引用簇外 server 模块: './x.mjs' -> '../x.mjs'（仅当 x 未被移动）
    next = next.replace(/(['"])\.\/([A-Za-z0-9_-]+)\.mjs\1/g, (m, q, ref) => moved.has(ref) ? m : `${q}../${ref}.mjs${q}`)
  } else {
    for (const base of bases) {
      // 簇外引用被移动模块: './base.mjs' -> './<subdir>/base.mjs'; '../server/base.mjs' 等按目录深度
      next = next.replaceAll(`'./${base}.mjs'`, `'./${subdir}/${base}.mjs'`)
      next = next.replaceAll(`"./${base}.mjs"`, `"./${subdir}/${base}.mjs"`)
      next = next.replaceAll(`'../server/${base}.mjs'`, `'../server/${subdir}/${base}.mjs'`)
      next = next.replaceAll(`'../../server/${base}.mjs'`, `'../../server/${subdir}/${base}.mjs'`)
    }
  }
  if (next !== source) { writeFileSync(file, next); rewritten += 1 }
}
console.log(`moved ${bases.length} bases to server/${subdir}, rewrote ${rewritten} files`)
