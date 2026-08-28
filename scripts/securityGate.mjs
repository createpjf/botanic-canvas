import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const secretPatterns = [
  { name: 'MiniMax API Key', pattern: /sk-api-[A-Za-z0-9_-]{20,}/ },
  { name: 'Tavily API Key', pattern: /tvly-[a-z]+-[A-Za-z0-9_-]{20,}/ },
  { name: 'Supabase Secret Key', pattern: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub Token', pattern: /gh[opusr]_[A-Za-z0-9]{30,}/ },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Postgres Password URL', pattern: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s\[]+@(?!localhost(?=[:/])|127\.0\.0\.1(?=[:/]))/ },
]

const allowedEnvironmentFiles = new Set(['.env.example'])
const forbiddenSourceDebugPatterns = [
  { name: 'Agent 调试注入区块', pattern: /#region agent log|X-Debug-Session-Id/ },
  { name: '本地调试回传端点', pattern: /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/ingest\// },
]

export function securityGateFindings(files, readText) {
  const findings = []
  for (const file of files) {
    const basename = file.split('/').pop() ?? file
    if ((basename === '.env' || basename.startsWith('.env.')) && !allowedEnvironmentFiles.has(basename)) {
      findings.push(`${file}: 环境密钥文件不应提交`)
      continue
    }
    if (/\.(?:pem|key|p12|pfx)$/i.test(file)) {
      findings.push(`${file}: 私钥或证书包不应提交`)
      continue
    }
    let content
    try { content = readText(file) } catch { continue }
    for (const secret of secretPatterns) {
      if (secret.pattern.test(content)) findings.push(`${file}: 发现疑似 ${secret.name}`)
    }
    if (/^(?:server|src)\//u.test(file)) {
      for (const debug of forbiddenSourceDebugPatterns) {
        if (debug.pattern.test(content)) findings.push(`${file}: 发现${debug.name}`)
      }
    }
  }
  return findings
}

export function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = securityGateFindings(trackedFiles(), (file) => readFileSync(file, 'utf8'))
  if (findings.length) {
    console.error(`安全门禁失败：\n- ${findings.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log('安全门禁通过：未提交环境密钥文件或明显凭据。')
  }
}
