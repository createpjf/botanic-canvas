# Botanic Agent 线上故障修复 Handoff（2026-08-31）

> 交接对象：Implementation Agent  
> 任务性质：已完成线上取证，按证据实施最小根因修复  
> 生产站点：[https://botanic-canvas.vercel.app/](https://botanic-canvas.vercel.app/)  
> 证据快照：2026-08-31 10:38（Asia/Shanghai）  
> 当前工作分支：`codex/fix-devin-reconnect-followups-20260830`  
> 当前 HEAD：`ec38ca5`，相对 `origin/main@ee4e06c` 领先 2 个提交  
> 调查状态：只读取证完成，本文创建前未实施本轮修复

## 0. 接手后先做

1. 运行 `git status --short --branch`、`git diff --stat`、`git rev-parse --short HEAD`，以接手时状态为准；现有修改均视为用户或前序 Agent 的工作。
2. 按仓库入口阅读：
   - `AGENTS.md`
   - `docs/PRODUCT_ARCHITECTURE.md`
   - `docs/CODEMAP.md`
   - `docs/ARCHITECTURE.md`
3. 先用现有测试或最小故障注入把问题跑红，再修改拥有该行为的模块。
4. 保持幂等键、项目版本冲突、任务恢复、媒体授权和 Artifact 历史语义不变。
5. 普通开发测试不调用真实生成 Provider。真实 Nano Banana smoke、生产环境变量修改、部署和 Sentry 规则修改都需要维护者明确授权。
6. 未经维护者要求，不创建 Pull Request；若要求提交 Git，使用中文提交日志。

## 1. 用户报告

用户在生产 Agent + Canvas 流程中报告：

1. 生成新图后，原图与新图之间没有可见连线。
2. Agent 面板持续报错：`Run 响应中断，正在用同一提交身份恢复…`。
3. Nano Banana 2 生图仍失败。

截图中还能观察到：

- 画布已有一张成功的“生成候选 1”，但没有从原始 `Mia 氛围肖像` 出发的参考血缘线。
- 当前计划选择 `Nano Banana 2 / 16:9 / 1K / 1 张`。
- Agent Composer 持续显示自动恢复提示，用户无法判断任务究竟在执行、失败还是重复提交。

## 2. 本次目标

- 终止 `/api/agent-runs` 的无限 500 重试风暴。
- 保证同一 Message + Plan 的自动重试使用完全相同的 Run 请求身份。
- 保证失败任务换模型/调参数时继承原计划的图片引用，并形成可见画布血缘。
- 修复 PostgreSQL 分支重试的时间字段类型错误。
- 在 Nano Banana 实际不可调用时停止把它呈现为可执行模型；Provider 恢复后再受控开放。
- 让 Provider 模型不可用、幂等冲突和分支重试失败可以被明确诊断和监控。

## 3. 非目标

- 不重做 Agent 面板或 React Flow 画布视觉。
- 不增加第二套 Run、Job、重试、画布写回或 Provider 调用路径。
- 不用强制覆盖解决 `409/412` 冲突。
- 不静默把 Nano Banana 切换成 GPT Image 2；模型切换必须由用户确认。
- 不修改无关 Adapter、数据库字段类型或历史数据。
- 不删除当前失败 Run、消息、Artifact、画布节点或生产项目。

## 4. 完成定义

实现完成需同时满足：

- 同一 Message + Plan 连续提交两次时，请求体中的分支身份一致；服务端首次创建，后续幂等复用同一个 Run。
- `AGENT_RUN_IDEMPOTENCY_CONFLICT` 返回 409，不再被包装为 500，也不会进入自动重试循环。
- 已经卡住的旧提交进入明确失败态，用户可通过显式“重新提交”获得新的提交身份。
- PostgreSQL `claimAgentBranchRetry` 能完成一次 claim 和一次同身份 replay，不再出现 `bigint` / `timestamptz` 错误。
- 失败 Run 换模型或调参数后，新的 Plan、Run、GenerationRecipe 仍保留原图片引用；画布存在参考图到 Generate 节点的 `reference` 连线。
- 纯文字首次生成仍允许零图片引用；图片编辑、换背景、换人物等依赖基准图的意图不得以零引用执行。
- Nano Banana 要么在目录中明确不可用/隐藏，要么通过一次经授权的真实生产 smoke；不可继续“目录可选、实际必失败”。
- 聚焦测试和仓库最小验证全部通过；生产发布后 Sentry 相关 Issue 在观察窗口内无新增事件。

## 5. 已确认的线上证据

### 5.1 Sentry 告警

[生产未解决 Issue 列表](https://sixau.sentry.io/issues/?project=botanic-canvas&query=environment%3Aproduction+is%3Aunresolved)在取证时共有 6 项。

| Issue | 快照 | 结论 |
| --- | --- | --- |
| [BOTANIC-CANVAS-8](https://sixau.sentry.io/issues/BOTANIC-CANVAS-8) | 125 次，Last seen 为当前 | 同一提交标识绑定到另一份 Agent Run 请求；当前事故主错误 |
| [BOTANIC-CANVAS-7](https://sixau.sentry.io/issues/BOTANIC-CANVAS-7) | 8 次 | PostgreSQL `updated_at` 类型不匹配；失败分支重试不可用 |

Sentry 中存在一条启用的 Issue Alert：

- 名称：`Send a notification for high priority issues`
- 最后触发：2026-08-31 09:42:54（Asia/Shanghai）
- 动作：邮件通知 Issue Owner
- 边界：Sentry 能确认规则触发，不能证明邮件已送达
- 当前没有 Metric Alert

Nano Banana 的 Provider 失败没有形成对应 Sentry Issue；目前只能在 Railway Worker 日志看到，是明确的监控缺口。

### 5.2 Railway API

截至 2026-08-31 10:38（Asia/Shanghai），最近 15 分钟：

```text
POST /api/agent-runs
500: 112 次
```

失败频率与前端最多 5 秒一次的自动退避一致。API 健康检查和其他读取接口仍可返回 200，因此这不是 API 整体掉线。

### 5.3 生产画布与任务记录

只读核查项目：`project-1787908517068`。

- Canvas Graph revision：702
- 节点数：9
- 连线数：7
- 成功的 GPT Image 2 Job：Prompt、Generate、Result 三个节点均存在；`prompt → generate`、`generate → result` 两条内部边均存在
- 该 GPT Job 的 `contextSnapshot` 和 GenerationRecipe `references` 都是 0，因此不存在原图到 Generate 的参考边
- 第一次 Nano Banana Job 有 1 个图片引用；后续 Nano 重试和 GPT 换模型任务变成 0 个引用

结论：成功图的内部工作流边没有丢失；**原图引用在新任务创建前已经丢失，所以服务端从未创建参考边**。

### 5.4 Nano Banana Provider

生产 Flock `/v1/models` 目录确实返回：

```text
gemini-3.1-flash-image-preview
```

但 2026-08-31 09:38 和 09:39 两次真实 Worker 请求均被上游拒绝。上游语义为：Flock 背后的 Vertex 项目找不到该 Publisher Model，或该项目没有模型访问权限。

因此：

- 不是本仓库模型别名拼写错误；
- 不是 Prompt、比例、清晰度或输出解析问题；
- 是“Flock 模型目录宣称可用，但实际 Vertex 路由/授权不可用”的 Provider 能力不一致。

截图中画布上成功的候选来自后续 `gpt-image-2` Job，不是 Nano Banana 成功结果。

### 5.5 Git / 部署边界

- 当前功能分支是 `origin/main` 加 2 个提交，不是落后于 main 的旧代码回滚。
- 本轮相关的随机 Branch ID、HTTP 错误映射和 PostgreSQL SQL 同样存在于 main 基线。
- 取证时生产 API/前端使用 `ec38ca5`，Worker 仍为 `ee4e06c`；当前差异不触及 Flock Worker Provider，因此不是这次 Nano 失败的直接原因。

接手 Agent 仍需重新检查实时 HEAD、Railway/Vercel revision 和 Sentry Last seen，不能把本快照当成永久现状。

## 6. 根因链

### 6.1 Run 自动恢复变成无限错误风暴

```text
同一 Message + Plan
  → submissionKey 稳定
  → 每次 confirmPlan 重新 randomUUID() 生成 branchId
  → 服务端发现“同 key、不同请求绑定”
  → 原始错误带 409 AGENT_RUN_IDEMPOTENCY_CONFLICT
  → HTTP 总入口未识别该错误，包装成 500 INTERNAL_ERROR
  → 客户端对 >=500 自动重试
  → 新一轮又生成新的 branchId
  → 无限循环
```

代码证据：

- `src/features/canvas/useCanvasAgentExecutionBridge.ts:524-542`：每次调用创建随机 `branchId`
- `server/agentRoutes.mjs:1902-1916`：同一 Run ID 检查完整请求绑定
- `server/httpServer.mjs:234-242,541-564`：错误白名单未包含 `AGENT_RUN_IDEMPOTENCY_CONFLICT`
- `src/domain/agent.ts:1589-1605`：所有 `status >= 500` 都可自动重试
- `src/features/agent/AgentWorkspace.tsx:1775-1806`：指数退避最多 5 秒并展示“响应中断”

### 6.2 参考血缘在换模型前丢失

`AgentWorkspace` 在 `submission.started` 后立即清空 Session Composer 上下文：

- `src/features/agent/AgentWorkspace.tsx:1747-1756`

失败 Run 的模型/参数恢复路径会尝试把旧 `contextSnapshot` 转回 Composer context：

- `src/features/agent/AgentWorkspace.tsx:1836-1865`

但生产记录证明恢复后的后续任务没有稳定携带该快照。根因边界是：**重试语义依赖可变 UI 状态，而不是直接继承失败 Run 的权威 Plan 快照。**

画布服务端已有正确参考边创建逻辑：

- `server/botanicAgentExecution.mjs:156-177`
- `server/botanicAgentExecution.mjs:300-305`

不要在 React Flow 展示层补假连线；先让 GenerationRecipe 恢复正确引用。

### 6.3 PostgreSQL 分支重试写错字段类型

`agent_runs.updated_at` 的数据库类型是 `bigint` epoch-ms：

- `server/postgresProductStore.mjs:294-300`

但 `claimAgentBranchRetry` 写入：

```sql
updated_at = to_timestamp(${decision.run.updatedAt} / 1000.0)
```

位置：`server/postgresProductStore.mjs:2737-2744`。

这会把 `timestamptz` 写入 `bigint`，使失败分支重试继续 500。

### 6.4 Nano Banana 是 Provider 权限/路由问题

仓库通过 `FLOCK_IMAGE_MODELS` 把固定别名加入可执行目录：

- `.env.example:57-67`
- `server/generationModels.mjs:90-103`

当前目录判断只证明 Key 和别名已配置，不证明模型实际可生成。Flock 返回的 404 被统一归为笼统 `PROVIDER_REJECTED`：

- `server/flockGenerationProvider.mjs:36-51`

这既误导用户“检查提示词”，也没有让模型目录及时降级。

## 7. 实施任务

### P0-A：稳定 Run 分支身份并终止自动重试风暴

目标：相同提交键必须产生字节级等价的 Run 创建请求。

实施要求：

1. `submissionKey` 存在时，Branch ID 从 `submissionKey + branch index` 稳定派生；无提交键的旧/本地路径才保留随机 ID。
2. 不改变 `botanicAgentSubmissionKey` 的现有字段、Hash 和复用语义。
3. 在 HTTP 信任边界显式把 `AGENT_RUN_IDEMPOTENCY_CONFLICT` 映射为 409；不要笼统信任任意对象携带的 `statusCode`。
4. 客户端收到 409 后进入失败态并停止计时器。复用现有失败重试入口创建新的 Message/提交身份；不得自动改 key 绕过冲突。
5. 对已卡住的旧提交接受一次可解释的终态失败。旧请求第一次使用的是随机 Branch ID，新版本无法安全猜回该值。

优先文件：

- `src/features/canvas/useCanvasAgentExecutionBridge.ts`
- `src/domain/agent.ts`
- `server/agentRoutes.mjs`
- `server/httpServer.mjs`
- `server/agentRoutes.test.mjs`
- `server/httpServer.test.mjs`

最小回归：

- 同一 Message + Plan 连续构造两次 Branch 输入，ID 完全相同。
- 同一提交请求首轮创建、第二轮复用；篡改 Branch 或 Plan 时返回真实 409。
- 409 不满足 `shouldRetryBotanicAgentAutoSubmission`。

### P0-B：修复 PostgreSQL Branch Retry

目标：保持 `updated_at` 统一为 epoch-ms bigint。

实施要求：

1. 把 `claimAgentBranchRetry` 中的 `to_timestamp(...)` 改为直接写入 `decision.run.updatedAt`。
2. 不修改数据库字段类型，不新增兼容列。
3. 核对 Local、PostgreSQL、Supabase 三个 Adapter 的 claim/replay/conflict 语义仍一致；只修改实际错误的 Adapter。
4. 在现有 `server/agentBranchRetryClaimAdapterContract.test.mjs` 中收紧 PostgreSQL 方法片段断言，使该错误未来能跑红；不要新建测试框架。

最小回归：

- 首次 claim 成功。
- 同 Job identity replay 不重复移动 Run。
- PostgreSQL 方法片段不包含 `to_timestamp(`。

### P1-C：失败 Run 换模型时继承权威引用

目标：换模型或调参数只改变用户选择的设置，不丢失输入素材及血缘。

实施要求：

1. 将失败 Run 的 `plan.contextSnapshot` 作为结构化恢复输入传到下一次 `runInstruction/preparePlan`；不要只先写 Composer state、再从异步 UI state 读取。
2. 保留引用身份、顺序、角色、`nodeId` 和 `assetId`，继续让服务端现有 resolver 重新读取权威媒体。
3. 对依赖基准图的编辑意图增加服务端校验：零图片引用时返回可操作的 4xx，不创建纯文字 Job。
4. 保留纯文字 `initial_generation` 的合法零引用路径。
5. 不在前端手工创建 lineage edge；正确 Recipe 落地后复用 `botanicAgentExecution.mjs` 的现有边生成逻辑。

优先文件：

- `src/features/agent/AgentWorkspace.tsx`
- `src/domain/agent.ts`
- `server/botanicAgentPlanner.mjs`
- `server/botanicAgentRun.mjs`
- `server/botanicAgentExecution.mjs`
- `src/domain/agent.test.ts`
- `server/botanicAgentExecution.test.mjs`

最小回归：

- 带 1 个引用的失败 Run 选择 GPT Image 2 重试后，新 Plan/Run/Recipe 仍有同一引用。
- 工作流生成参考图到 Generate 的 `data.role = reference` 边。
- 无图纯文字首次生成仍通过。

### P1-D：收口 Nano Banana 可用性与错误语义

目标：UI 模型目录与 Provider 的真实可执行能力一致。

实施要求：

1. Provider 权限未修复前，生产环境从 `FLOCK_IMAGE_MODELS` 移除该模型，或把它标记为明确不可用；应用生产环境变量前需维护者授权。
2. Flock 404/模型访问拒绝映射为明确错误，例如 `PROVIDER_MODEL_UNAVAILABLE`，不要继续提示用户检查 Prompt。
3. 不做静默 Provider fallback，不自动产生额外费用。
4. 联系 Flock 修复 Vertex 项目权限/路由，或取得实际可调用的模型别名。
5. `/v1/models` 只能作为目录检查，不能作为恢复证明；重新开放前必须有一次经授权的真实小样本生成成功。

优先文件：

- `server/flockGenerationProvider.mjs`
- `server/generationModels.mjs`
- `server/generationVocabulary.mjs`
- `server/flockGenerationProvider.test.mjs`
- `server/generationModels.test.mjs`

### P1-E：补齐 Worker Provider 监控

目标：以后不依赖人工翻 Railway 日志才知道某模型已不可用。

实施要求：

1. 在 Generation Job 终态失败处记录可聚合的 Sentry 事件或指标：`component=worker`、`error_code`、`provider`、`model`。
2. 不上传 Prompt、媒体 URL、图片内容、API Key、用户身份或原始 Provider 响应全文。
3. 使用稳定 fingerprint，避免每个 Job 形成独立 Issue。
4. Sentry 告警规则属于外部状态；只在维护者授权后创建或修改。

## 8. 推荐实施顺序与提交边界

建议按以下顺序独立验证：

1. P0-A + P0-B：先停止线上重试风暴并修通失败分支重试。
2. P1-C：恢复图片引用和画布血缘。
3. P1-D：下架/恢复 Nano Banana 与明确错误语义。
4. P1-E：补齐 Provider 监控。

建议中文提交日志：

```text
修复：稳定 Agent Run 重试身份并恢复分支重试
修复：保留生成重试引用与画布血缘
修复：收口 Nano Banana 可用性与失败监控
```

若某一批次需要明显扩大文件范围，先停下重新核对行为归属；不要为了“一次修完”把四项塞进 AgentWorkspace 或新建第二套恢复器。

## 9. 验证要求

### 9.1 聚焦测试

优先运行与修改对应的现有测试：

```bash
node --test server/agentRoutes.test.mjs server/httpServer.test.mjs
node --test server/agentBranchRetryClaimAdapterContract.test.mjs
node --test server/botanicAgentExecution.test.mjs server/flockGenerationProvider.test.mjs server/generationModels.test.mjs
```

前端领域测试按实际修改补充，例如：

```bash
npx tsx --test src/domain/agent.test.ts
```

只在现有测试无法覆盖本次行为时增加最小回归：一条主路径 + 一条关键失败路径。

### 9.2 仓库门禁

```bash
npm test
npm run check:architecture
npm run build
git diff --check
```

### 9.3 生产验收（需发布授权）

发布后按顺序执行：

1. 确认 Vercel、Railway API、Railway Worker 的 release revision。
2. 打开一个有图片素材的新测试项目，执行“换背景并保留人物”的 Agent 计划。
3. 在首个请求响应未知的故障注入下重放同一提交，确认只产生一个 Run/Job。
4. 确认原图、Prompt、Generate、Result 均存在，且参考边和输出边可见。
5. 让一个任务进入失败态，再从失败卡片切换模型；确认新 Run 继承原引用。
6. Nano Banana 未恢复时必须不可选；恢复后只执行 1 个最小真实任务并记录 Job 身份和成本。
7. 观察至少 15 分钟：
   - `/api/agent-runs` 不再持续 500；
   - Sentry BOTANIC-CANVAS-8 无新增；
   - Sentry BOTANIC-CANVAS-7 无新增；
   - Worker 中无新的同类 Nano `PROVIDER_MODEL_UNAVAILABLE`，或该模型仍保持下架。

## 10. 证据边界与禁止误判

- Sentry Issue 计数会继续变化；本文数字只代表快照时间。
- “Sentry 没有 Nano Issue”不等于 Nano 正常，Worker Railway 日志已有明确失败证据。
- `/v1/models` 中出现模型不等于实际 Vertex 项目有调用权限。
- 画布存在 Result 节点不等于引用血缘完整；需同时检查 Run Plan、GenerationRecipe 和 Graph edge。
- HTTP 200/健康检查不等于 Agent 生成闭环可用。
- 本地测试通过不等于生产 Provider、数据库迁移、部署 revision 或用户 UAT 已通过。
- 不输出原始堆栈、Prompt、媒体 URL、数据库凭据或用户信息到 Issue、提交信息和交接报告。

## 11. 交付报告格式

实施 Agent 最终应分别报告：

1. **代码**：修改文件、根因修复点、提交 SHA。
2. **测试**：聚焦测试、全量门禁结果。
3. **Git**：分支、是否推送、工作区是否干净。
4. **部署**：Vercel、Railway API、Worker 各自 revision；未部署则明确写未部署。
5. **Provider**：Nano 是否隐藏、Provider 权限是否修复、是否执行真实 smoke；未授权则明确写未验证。
6. **Sentry**：Issue 7/8 的发布后新增事件和观察窗口；不要仅写“没有报错”。
7. **剩余风险**：旧卡住提交的人工恢复、外部 Provider 权限、尚未完成的 UAT。
