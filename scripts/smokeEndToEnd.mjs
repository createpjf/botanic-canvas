#!/usr/bin/env node
/**
 * 端到端冒烟（真实 Provider）。
 *
 * 单元测试 1300+ 条全绿，但它们**一个进程都不启动**。这条链路上真正会坏的地方，
 * 单元测试按定义看不见：模块漏导入、路由没注册、依赖没注入、Worker 与 API 的配置
 * 不一致。上一轮 `httpServer.mjs` 漏导入 `productStoreSupports` 就是这么漏过去的 ——
 * 启用 MFA 的部署每次敏感请求 500，而所有单元测试都是绿的。
 *
 * 因此这里**启动真实的 API 与 Worker 进程**，然后只走 HTTP 驱动，不 import 任何
 * 业务模块。绕过进程去直接调函数，就又变成了一个更慢的单元测试。
 *
 * 它会产生**真实的生成费用**（默认 4 张图左右）。跑之前会把计划打印出来。
 *
 * 用法：
 *   1. 在 .env 里填 OPENAI_API_KEY（推荐，支持蒙版）或 MINIMAX_API_KEY
 *   2. 起一个本地 Redis：redis-server --port 6399 --daemonize yes
 *   3. npm run smoke:e2e
 *
 * 只想看要花多少钱、不真的跑：npm run smoke:e2e -- --dry-run
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { loadLocalEnv } from '../server/runtime.mjs'

loadLocalEnv()

const dryRun = process.argv.includes('--dry-run')
const keepProject = process.argv.includes('--keep')
/**
 * `--local-store` 已废弃：它**不可能**支撑这条冒烟。
 *
 * 本地文件 Adapter 在启动时把状态载入内存一次、之后永不重读（productStore.mjs:100）。
 * 而这条冒烟跑的是 API 与 Worker **两个进程**：API 创建的项目与任务只存在于它自己的
 * 内存快照里，Worker 从 Redis 拿到任务 id 后在自己的快照里根本查不到 —— 表现是任务
 * 一直排队，直到 API 侧的读时扫描在超时后把它判失败，而 Worker 从未开始处理。
 *
 * 实测就是这样：variants 为空、outputs 为 0、300 秒后被标记 failed。
 * 这个 Adapter 在 .env.example 里写明「仅本地原型使用」，跨进程共享不在它的能力范围内。
 */
const localStore = process.argv.includes('--local-store')
const startedAt = Date.now()
/** 相对秒数。没有它就无法回答「Provider 调用到底花了多久」——上一轮正是卡在这个问题上。 */
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`
const PORT = Number(process.env.SMOKE_PORT ?? 4788)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = process.env.BOTANIC_BOOTSTRAP_ACCESS_TOKEN

/** 步骤结果。**失败不中断**：一次跑完能看到所有断点，比修一个跑一次快得多。 */
const steps = []
let currentStep = ''

function step(name) {
  currentStep = name
  process.stdout.write(`\n▶ ${name}\n`)
}

function pass(detail) {
  steps.push({ name: currentStep, ok: true, detail })
  process.stdout.write(`${elapsed().padStart(8)}   ✔ ${detail}\n`)
}

function fail(detail) {
  steps.push({ name: currentStep, ok: false, detail })
  process.stdout.write(`${elapsed().padStart(8)}   ✖ ${detail}\n`)
}

function skip(detail) {
  steps.push({ name: currentStep, skipped: true, detail })
  process.stdout.write(`  ○ 跳过：${detail}\n`)
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : undefined } catch { body = text }
  return { status: response.status, body, headers: response.headers }
}

/** 轮询到终态。超时**照实报出等到的最后状态**，不写成「失败」——两者要分得开。 */
async function pollUntil(describe, read, done, { timeoutMs = 180_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await read()
    } catch (caught) {
      // 「API 进程死了」与「任务还没跑完」是两种完全不同的问题，不能都表现成「超时」。
      // 一次读取失败可能是瞬时的，因此再确认一次健康检查才下结论。
      const alive = await fetch(`${BASE}/api/health`).then((response) => response.ok).catch(() => false)
      if (!alive) return { ok: false, value: last, processDied: true, describe }
      void caught
    }
    if (done(last)) return { ok: true, value: last }
    await delay(intervalMs)
  }
  return { ok: false, value: last, timedOut: true, describe }
}

// ---------------------------------------------------------------- 前置检查

function preflight() {
  const problems = []
  if (!TOKEN) problems.push('BOTANIC_BOOTSTRAP_ACCESS_TOKEN 未设置（本地鉴权用）。')
  if (localStore) {
    problems.push(
      '--local-store 不可用：本地文件 Adapter 启动时载入内存一次且永不重读，'
      + 'API 与 Worker 是两个进程、各持一份快照，Worker 查不到 API 刚创建的任务。'
      + '这条冒烟需要一个真正跨进程共享的存储，请配置 DATABASE_URL。',
    )
  }
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL 未设置。')
  // 没有对象存储时，生成的图会以 data: URL **整个塞进数据库的任务负载**
  // （1.7MB 图 → base64 约 2.25MB → 写 jsonb）。本地原型跑几十 KB 的假图没问题，
  // 真实生成一定会把这条写入撑爆或拖死 —— 而表现是「任务停在 running」，
  // 看不出跟存储有关。这是这条冒烟绕了很久才定位到的根因，因此列为硬性前置。
  const hasS3 = process.env.BOTANIC_STORAGE_PROVIDER === 's3' && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID
  const hasSupabaseStorage = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY)
  if (!hasS3 && !hasSupabaseStorage) {
    problems.push(
      '没有配置对象存储：生成的图会以 data: URL 整个写进数据库任务负载，真实尺寸的图会把写入拖死，'
      + '表现是任务停在 running。跑 ./scripts/smokeLocalStack.sh up 起一个本地 MinIO，或配置 S3_* / SUPABASE_*。',
    )
  }
  if (!process.env.REDIS_URL) problems.push('REDIS_URL 未设置。本地可跑：redis-server --port 6399 --daemonize yes，然后 REDIS_URL=redis://127.0.0.1:6399')
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY)
  const hasMiniMax = Boolean(process.env.MINIMAX_API_KEY)
  if (!hasOpenAI && !hasMiniMax) {
    problems.push('OPENAI_API_KEY 与 MINIMAX_API_KEY 都没配 —— 没有图片 Provider，整条链路无从验证。')
  }
  return {
    problems,
    // gpt-image-2 走 images/edits，支持蒙版；MiniMax 不支持，因此局部重绘那一步会跳过。
    model: hasOpenAI ? (process.env.OPENAI_IMAGE_MODELS ?? 'gpt-image-2').split(',')[0].trim() : 'image-01',
    supportsMask: hasOpenAI,
  }
}

// ---------------------------------------------------------------- 进程

const children = []

function launch(name, entry) {
  const child = spawn(process.execPath, [entry], {
    // 显式空串 = 「这次不要连 Postgres」。runtime 的 loadLocalEnv 尊重显式设置，
    // 因此不会再从 .env 把它补回来。
    env: { ...process.env, PORT: String(PORT), ...(localStore ? { DATABASE_URL: '' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `  [${name}] `
  const relay = (stream, isError) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        // Worker 的进度日志（「references ready」这类）是判断卡在哪一步的唯一线索，
        // 默认过滤掉等于把线索藏起来 —— 上一轮就是因此看不出 Worker 究竟有没有开始处理。
        // 只滤掉明确无关的启动噪音。
        const noise = /ExperimentalWarning|trace-warnings/.test(line)
        if (!noise) {
          process.stdout.write(`${elapsed().padStart(8)} ${prefix}${line}\n`)
        }
      }
    })
  }
  relay(child.stdout, false)
  relay(child.stderr, true)
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.stdout.write(`${prefix}进程退出，code=${code}\n`)
  })
  children.push(child)
  return child
}

function shutdown() {
  // Worker 被杀时，正在跑的任务会**永远停在 running** —— 没有人再去收口它。
  // 这不是脚本能避免的（等在途任务跑完可能要很久），但必须说出来，
  // 否则事后看到一个 running 的任务会以为是产品 bug。
  if (steps.some((entry) => entry.ok === false)) {
    process.stdout.write('\n注意：Worker 即将被关闭。若此刻仍有任务在途，它会留在 running 状态且不会自行收口。\n')
  }
  for (const child of children) {
    try { child.kill('SIGTERM') } catch { /* 已经退了 */ }
  }
}

async function waitForApi() {
  // 60 秒而不是 20 秒：连 Neon 建表（含 advisory lock）本身要十几秒，
  // 经代理还会更慢。等太短会把「启动慢」误报成「启动失败」。
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`)
      if (response.ok || response.status === 404 || response.status === 401) return true
    } catch { /* 还没起来 */ }
    await delay(500)
  }
  return false
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const { problems, model, supportsMask } = preflight()

  process.stdout.write('Botanic 端到端冒烟\n')
  process.stdout.write('==================\n')
  process.stdout.write(`模型：${model}${supportsMask ? '（gpt-image-2，支持蒙版）' : '（MiniMax，不支持蒙版）'}\n`)
  process.stdout.write('预计真实生成：3 张图（1 张单图 + 2 项批量）。\n')
  process.stdout.write(`存储：PostgreSQL（DATABASE_URL）+ ${
    process.env.BOTANIC_STORAGE_PROVIDER === 's3' ? `S3（${process.env.S3_ENDPOINT ?? '默认端点'}）` : 'Supabase Storage'
  }\n`)
  process.stdout.write('\n覆盖：提交 → 队列 → Provider → 画布回写 → 实测规格 →\n')
  process.stdout.write('      工作流发布（来源校验）→ 批量业务标识 → Worker 侧推进 → 交付清单 → 打包接口。\n')
  // 覆盖范围要说全，包括**没覆盖**的部分。只列做到了什么，读的人会以为剩下的也验过了。
  process.stdout.write('不覆盖：Agent 规划/确认链路、评审的视觉判定、局部重绘蒙版。\n')
  process.stdout.write('        这些要么需要额外配置，要么需要人工决定，不适合放进一条无人值守脚本。\n')

  if (problems.length) {
    process.stdout.write('\n缺少前置配置：\n')
    for (const problem of problems) process.stdout.write(`  ✖ ${problem}\n`)
    process.exitCode = 1
    return
  }
  if (dryRun) {
    process.stdout.write('\n--dry-run：前置检查通过，未发起任何真实调用。\n')
    return
  }

  step('启动 API 与 Worker（真实进程）')
  launch('api', 'server/index.mjs')
  launch('worker', 'server/worker.mjs')
  if (!await waitForApi()) {
    fail('API 未能在 60 秒内响应。用 --verbose 看 [api] 日志；数据库连不上会在启动探针处给出主机名与原因。')
    return
  }
  pass(`API 已监听 ${BASE}`)

  step('创建冒烟项目')
  const projectId = `smoke-${Date.now()}`
  // 画布节点必须**先建好**再提交生成。服务端只为 Agent Run 的任务凭空造节点
  // （ensureAgentGenerationPlaceholder 第一行就是 `if (!job?.agentRun) return false`）；
  // 普通画布生成走的是「客户端先建 generate + result 占位，服务端把图填进占位」。
  // 往空文档直接提交，服务端不造节点是**正确行为**，此前脚本把它误判成了回写断链。
  const generateNodeId = 'generate-smoke'
  const resultNodeId = 'result-smoke'
  // 请求体只认 { document }，且 document 必须自带 id 与 name（projectRoutes.mjs:44）。
  const created = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      document: emptyDocument(projectId, {
        generateNodeId, resultNodeId,
        prompt: '一只陶瓷小猫摆件放在浅灰色背景上，柔和自然光，正面视角，产品摄影。',
      }),
    }),
  })
  if (created.status >= 300) {
    fail(`创建项目失败：${created.status} ${JSON.stringify(created.body).slice(0, 300)}`)
    return
  }
  pass(`项目 ${projectId}`)

  step('提交单张生成 → 队列 → Provider → 回写')
  const submitted = await api('/api/generation-jobs', {
    method: 'POST',
    headers: { 'Idempotency-Key': `smoke-single-${projectId}` },
    body: JSON.stringify({
      projectId,
      kind: 'generation',
      prompt: '一只陶瓷小猫摆件放在浅灰色背景上，柔和自然光，正面视角，产品摄影。',
      batchCount: 1,
      settings: { model, aspectRatio: '1:1', resolution: '1K' },
      // 纯文字生图（PR #60）：references 允许为空数组，但 recipe 本身必须存在 ——
      // 校验只看形状（generationProvider.mjs:165），不给 recipe 会被当成「缺参考图」。
      recipe: { references: [] },
      // 把任务绑到画布节点上：服务端按 jobId / outputOf 找到占位再填图。
      generateNodeId,
      promptNodeId: generateNodeId,
    }),
  })
  if (submitted.status !== 202) {
    fail(`提交失败：${submitted.status} ${JSON.stringify(submitted.body).slice(0, 400)}`)
  } else {
    const jobId = submitted.body?.id
    pass(`已入队 job=${jobId}`)

    // 轮询上限必须**长于服务端的 Provider 超时**（generationTimeoutMs 默认 5 分钟）。
    // 短于它的话，「模型慢」和「卡死了」在输出里长得一模一样 —— 而上一次就是这么
    // 误判的：3 分钟等不到就说「Worker 可能没消费队列」，其实 Worker 早就在跑了。
    const settled = await pollUntil(
      '生成任务到终态',
      async () => (await api(`/api/generation-jobs/${encodeURIComponent(jobId)}`)).body,
      (job) => ['succeeded', 'failed', 'cancelled'].includes(job?.status),
      { timeoutMs: 390_000, intervalMs: 5_000 },
    )
    if (settled.processDied) {
      fail('API 进程在等待期间停止响应。数据库连接抖动会抛未捕获异常直接终止进程；'
        + '用 --verbose 看 [api] 的最后几行，或改用 --local-store 排除数据库这个变量。')
    } else if (!settled.ok) {
      const last = settled.value ?? {}
      // 状态没到终态时，把已经攒下的诊断信息一并报出来：errorCode 与部分输出能区分
      // 「一个候选都没出来」和「出了一半卡住」。
      const diagnosis = [
        `最后状态 ${last.status ?? '未知'}`,
        last.errorCode ? `errorCode=${last.errorCode}` : '',
        last.failureStage ? `阶段=${last.failureStage}` : '',
        `已产出 ${(last.outputs ?? []).length}/${last.batchCount ?? '?'} 个输出`,
      ].filter(Boolean).join('，')
      fail(`任务 6.5 分钟内未到终态：${diagnosis}。已超过服务端 Provider 超时（5 分钟），说明卡在收口而不是模型慢。`)
    } else if (settled.value.status !== 'succeeded') {
      fail(`任务终态是 ${settled.value.status}：${settled.value.error ?? ''}`)
    } else {
      const outputs = settled.value.outputs ?? []
      pass(`生成成功，${outputs.length} 个输出`)
      // 实测规格是评审第 1 层的输入。没有它，硬规格判据会全部记「无法验证」。
      const spec = outputs[0]?.spec
      if (spec?.width && spec?.byteSize) pass(`实测规格 ${spec.width}×${spec.height}，${spec.byteSize} 字节，${spec.mimeType}`)
      else fail('输出没有实测规格 —— 评审确定性层将无从检查（见 agentReviewDeterministic）。')

      step('画布回写')
      // 文档在 /document 子路由，响应就是 project 本身（含 .document）。
      const project = await api(`/api/projects/${encodeURIComponent(projectId)}/document`)
      const nodes = project.body?.document?.nodes ?? []
      const filled = nodes.filter((node) => node?.type === 'result' && node?.data?.image)
      if (filled.length) {
        pass(`结果已填进画布占位：${filled.length} 个结果节点带图`)
        if (filled[0].data.jobId) pass(`结果节点回指任务 ${String(filled[0].data.jobId).slice(0, 24)}…`)
        else fail('结果节点没有 jobId —— 之后无法从画布反查这张图是哪次生成的。')
      } else {
        fail(`生成成功但占位没有被填图（画布上 ${nodes.length} 个节点）—— 回写链路断了。`)
      }
    }
  }

  // ---- 工作流：发布 → 批量运行 → Worker 侧推进 → 交付清单 → 打包 ----
  // 这一段是本轮改动最多的地方（批量输入、按渠道过滤品牌规则、清单、zip），
  // 而且全都只在模块层面验过。
  step('发布生产工作流（显式来源校验）')
  const document = (await api(`/api/projects/${encodeURIComponent(projectId)}/document`)).body?.document
  const generateNode = (document?.nodes ?? []).find((node) => node?.type === 'generate')
  const resultNodes = (document?.nodes ?? []).filter((node) => node?.type === 'result')
  let workflowId
  if (!generateNode) {
    skip('画布上没有生成节点，无法发布工作流（前一步可能已失败）')
  } else {
    const published = await api(`/api/projects/${encodeURIComponent(projectId)}/production-workflows`, {
      method: 'POST',
      body: JSON.stringify({
        id: `wf-${projectId}`,
        name: '冒烟工作流',
        definition: {
          prompt: '一只陶瓷{{sku}}摆件放在浅灰色背景上，柔和自然光，产品摄影。',
          model,
          settings: { aspectRatio: '1:1', resolution: '1K' },
          output: { aspectRatio: '1:1' },
          assetGroupIds: [],
          confirmationPolicy: 'before-submit',
        },
        // 来源必须显式指名（Epic 3B）：服务端会校验节点归属与版本未漂移。
        source: { canvasNodeId: generateNode.id, resultNodeIds: resultNodes.map((node) => node.id) },
      }),
    })
    if (published.status >= 300) {
      fail(`发布失败：${published.status} ${JSON.stringify(published.body).slice(0, 300)}`)
    } else {
      workflowId = published.body?.workflow?.id
      const version = published.body?.workflow?.versions?.at(-1)
      pass(`已发布 ${workflowId} v${published.body?.workflow?.currentVersion}，provenance=${version?.provenance}`)
      if (version?.provenance !== 'verified') fail('版本 provenance 不是 verified —— 来源校验没生效。')
    }
  }

  let runId
  if (workflowId) {
    step('批量运行 2 项（不同渠道）')
    runId = `wfrun-${projectId}`
    const started = await api(`/api/projects/${encodeURIComponent(projectId)}/production-workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        id: runId,
        workflowVersion: 1,
        // 业务身份标识（Epic 7）：位置标识在重排后会指向另一行，重试就会打错。
        items: [
          { sku: '小猫', channel: 'tmall' },
          { sku: '小狗', channel: 'jd' },
        ],
      }),
    })
    if (started.status >= 300) {
      fail(`批量启动失败：${started.status} ${JSON.stringify(started.body).slice(0, 300)}`)
      runId = undefined
    } else {
      pass(`运行 ${runId}，${started.body?.run?.items?.length ?? 0} 项`)
      const itemIds = (started.body?.run?.items ?? []).map((item) => item.id)
      // 标识应当来自 sku_channel 而不是位置。
      if (itemIds.some((id) => /小猫|tmall/.test(String(id)))) pass(`项标识取自业务身份：${itemIds.join(', ')}`)
      else fail(`项标识看起来仍是位置：${itemIds.join(', ')}`)
    }
  }

  if (runId) {
    step('Worker 侧推进到终态（页面无人打开也应收口）')
    // workflow.advance 是 45 秒周期的派生任务，因此这里给足时间。
    const advanced = await pollUntil(
      '工作流运行收口',
      async () => (await api(`/api/projects/${encodeURIComponent(projectId)}/production-workflow-runs/${encodeURIComponent(runId)}`)).body?.run,
      // `awaiting_review` 是**质量门开启时的正确终点**：所有项都跑完了，等人工评审。
      // 把它排除在外会让一次完全正常的运行被报成「未收口」——上一轮就是这么误判的，
      // 而紧接着的交付清单步骤明明正确地报出了「0 个文件、2 个被排除（未批准）」。
      (run) => ['succeeded', 'partially_failed', 'failed', 'cancelled', 'awaiting_review'].includes(run?.status),
      { timeoutMs: 300_000, intervalMs: 5_000 },
    )
    if (!advanced.ok) {
      fail(`5 分钟内未收口，最后状态 ${advanced.value?.status ?? '未知'} —— workflow.advance 派生任务可能没在跑。`)
    } else {
      pass(`运行收口为 ${advanced.value.status}${advanced.value.status === 'awaiting_review' ? '（质量门开启，等待人工评审）' : ''}`)
      const failedItems = (advanced.value.items ?? []).filter((item) => item.status === 'failed')
      if (failedItems.length) fail(`${failedItems.length} 项失败：${failedItems.map((item) => item.error?.code).join(', ')}`)
    }

    step('交付清单与打包')
    const manifest = await api(`/api/projects/${encodeURIComponent(projectId)}/production-workflow-runs/${encodeURIComponent(runId)}/manifest`)
    if (manifest.status >= 300) {
      fail(`清单接口 ${manifest.status}：${JSON.stringify(manifest.body).slice(0, 300)}`)
    } else {
      const body = manifest.body?.manifest
      pass(`清单可生成：${body?.fileCount ?? 0} 个文件，${body?.excluded?.length ?? 0} 个被排除`)
      // 跨输出一致性 Gate（Epic 9.3）应当出现在清单里。
      if (body?.consistency) pass(`一致性结论：${body.consistency.verdict}`)
      else fail('清单里没有一致性结论 —— checkCampaignConsistency 没接上。')
      // 没有人工批准时**必须**是空清单：自动评审通过不算批准（ADR 0006）。
      if ((body?.fileCount ?? 0) === 0 && (body?.excluded?.length ?? 0) > 0) {
        pass('未批准的候选被排除且列出了原因，未静默进包')
      }
    }

    const pack = await api(`/api/projects/${encodeURIComponent(projectId)}/production-workflow-runs/${encodeURIComponent(runId)}/package`)
    if (pack.status === 409 && pack.body?.error?.code === 'DELIVERY_PACKAGE_EMPTY') {
      // 这是**正确**结果：没有人工批准的候选就不该出包。zip 写入器本身由
      // zipArchive.test.mjs（含 Python zipfile 与 unzip 交叉验证）覆盖。
      pass('无已批准候选时拒绝出包，并说明原因（符合预期）')
    } else if (pack.status === 200) {
      pass(`交付包已生成，Content-Type=${pack.headers.get('content-type')}`)
    } else {
      fail(`打包接口返回 ${pack.status}：${JSON.stringify(pack.body).slice(0, 300)}`)
    }
  }

  step('清理')
  const hadFailure = steps.some((entry) => entry.ok === false)
  if (keepProject || hadFailure) {
    // 失败时**不删项目**。上一次就是这么把证据弄没的：任务卡在 running，清理把项目
    // 连同任务记录一起删了，之后再也查不到它究竟停在哪一步。
    skip(hadFailure && !keepProject
      ? `有步骤失败，保留项目 ${projectId} 以便追查（任务记录随项目一起保留）`
      : `--keep：保留项目 ${projectId} 供你手工检查`)
  } else {
    const deleted = await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
    if (deleted.status < 300) pass('冒烟项目已删除')
    else skip(`删除返回 ${deleted.status}，项目 ${projectId} 需要手工清理`)
  }
}

function emptyDocument(id, { generateNodeId, resultNodeId, prompt } = {}) {
  // 与界面提交前建立的结构一致：generate 节点 + 一个尚无图片的 result 占位，
  // 占位靠 `data.outputOf` 指回 generate 节点，服务端据此把结果填进来
  // （generationResultReconciliation.mjs:350 的识别条件）。
  const nodes = generateNodeId ? [
    {
      id: generateNodeId, type: 'generate', position: { x: 0, y: 0 },
      data: { label: '冒烟生成', prompt, generationKind: 'generation' },
    },
    {
      id: resultNodeId, type: 'result', position: { x: 320, y: 0 },
      data: {
        label: '冒烟结果', outputOf: generateNodeId, generationKind: 'generation',
        taskStatus: 'queued', submittedAt: Date.now(),
      },
    },
  ] : []
  return {
    schemaVersion: 25,
    id,
    name: '端到端冒烟',
    nodes,
    edges: generateNodeId ? [{ id: `edge-${generateNodeId}`, source: generateNodeId, target: resultNodeId }] : [],
    viewport: { x: 0, y: 0, zoom: 1 },
    assets: [],
    assetGroups: [],
    templates: [],
    history: [],
    deliveries: [],
    generationJobs: [],
    batchVariationRuns: [],
    agentRuns: [],
    agentSessions: [],
    agentMemory: [],
    updatedAt: Date.now(),
  }
}

try {
  await main()
} catch (caught) {
  // 计入 steps，否则汇总会同时输出「脚本自身出错」和「失败 0」——自相矛盾，
  // 读的人不知道该信哪个。
  const message = caught instanceof Error ? caught.message : String(caught)
  steps.push({
    name: currentStep || '冒烟脚本',
    ok: false,
    detail: message === 'fetch failed'
      // fetch failed 只说明连不上，说不出为什么。这里把最可能的原因直接写出来：
      // Postgres 连接超时会抛未捕获异常直接杀掉 API 进程（见第一次跑的日志）。
      ? 'API 进程在中途停止响应（fetch failed）。最常见原因是数据库连接抖动——'
        + 'Postgres 超时会抛未捕获异常直接终止进程。用 --verbose 看 [api] 的最后几行，'
        + '或改用 --local-store 把数据库从变量里去掉。'
      : `脚本自身出错：${message}`,
  })
  process.stdout.write(`\n✖ ${steps.at(-1).detail}\n`)
  if (caught instanceof Error && caught.stack && message !== 'fetch failed') {
    process.stdout.write(caught.stack + '\n')
  }
  process.exitCode = 1
} finally {
  shutdown()
}

// ---------------------------------------------------------------- 汇总

const failed = steps.filter((entry) => entry.ok === false)
const skipped = steps.filter((entry) => entry.skipped)
process.stdout.write('\n==================\n')
process.stdout.write(`通过 ${steps.filter((entry) => entry.ok).length} · 失败 ${failed.length} · 跳过 ${skipped.length}\n`)
if (failed.length) {
  process.stdout.write('\n失败的步骤：\n')
  for (const entry of failed) process.stdout.write(`  ✖ ${entry.name}：${entry.detail}\n`)
  process.exitCode = 1
}
// 进程可能还有未 unref 的句柄；显式退出，避免脚本挂住终端。
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
