# 开发手册

本地把 Botanic 跑起来、改代码、验证、发布。产品能力介绍在 [根 README](../README.md)。

**改代码前先读 [AGENTS.md](../AGENTS.md)** —— 它是所有代码改动的入口约定，本文只讲怎么操作。

| 还需要什么 | 去哪看 |
| --- | --- |
| 产品由哪些概念构成（含 Agent Ontology 语义定义） | [PRODUCT_ARCHITECTURE.md](PRODUCT_ARCHITECTURE.md) |
| 某个行为的权威实现在哪个文件 | [CODEMAP.md](CODEMAP.md) |
| 模块接口与依赖方向，哪些依赖被禁止 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 版本与 PR 流程 | [DEVELOPMENT_WORKFLOW.md](DEVELOPMENT_WORKFLOW.md) |
| 上线验收、告警阈值、备份恢复 | [SECURITY_OPERATIONS.md](SECURITY_OPERATIONS.md) |

**贯穿全局的一条原则：UI 只表达交互，任务与持久化结果才是生成状态的权威来源。** 读代码时如果发现某个状态由组件内部推断得出，那通常是缺陷而不是设计。

## 生产架构

```text
Vercel Web
   │ Supabase Auth 会话 + /api 同源转发 + WebSocket 实时通道
   ▼
Railway API ── PostgreSQL（项目、画布图谱、Yjs 日志、任务、媒体元数据）
   │
   ├── Redis / BullMQ ── Railway Worker ── OpenAI / MiniMax
   │
   └── S3 兼容对象存储（上传素材、图片与 MP4）
```

- Web 通过 [vercel.json](../vercel.json) 将 `/api/*` 转发到 Railway API。
- API 负责鉴权、项目文档、实时协作、幂等任务提交、结果查询与媒体授权。
- Worker 执行长耗时生成，统一将 Provider 输出转换为媒体对象后持久化。
- Redis 只负责调度；PostgreSQL 中的任务与输出记录负责恢复与回填。
- 正式用户鉴权使用 Supabase Auth；用户角色、状态、项目、任务与媒体数据保存在 Railway PostgreSQL / S3。

详细依赖方向见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 仓库结构

分层不是审美偏好，而是由 `npm run check:architecture` 强制执行的：`src/` 不得 import `server/`，UI 不得直接依赖数据库、队列、Worker 或 Provider。

```text
src/
  domain/     纯函数与判定规则。不碰 DOM、不发请求，因此可在 node:test 里穷举
  lib/        机制层。依赖注入形式包裹浏览器 API（FileReader、Image、剪贴板）
  store/      Zustand 状态
  features/   React 组件，按功能域分（canvas / agent）
  i18n/       全量中英双语文案
server/       裸 Node .mjs。API、Worker、Provider 适配与权威词表
scripts/      门禁脚本（架构、安全、评测）与冒烟工具
e2e/          Playwright 用例
docs/         架构、产品与运维文档
```

**为什么判定逻辑集中在 `src/domain/`：** 这个项目没有 React 测试渲染器。凡是需要断言的规则都要写成不依赖 DOM 的纯函数，机制层则薄到没有逻辑可测。跨越前后端边界的词表（如图片格式）在两侧各有一份声明，由契约测试以文本方式读取 TS 源码来保证一致——因为架构门禁禁止 `src/` 直接 import `server/`。

**同一行为只保留一个权威实现。** 曾经有六份各自独立的图片字节嗅探代码，格式支持因此长期不一致；现已收编到 `server/mediaFormats.mjs`。新增此类逻辑前先查 [CODEMAP.md](CODEMAP.md)。

## 本地开发

要求：Node.js 22、npm，以及服务端模式所需的 PostgreSQL、Redis 和 S3 兼容对象存储。

```bash
npm install
cp .env.example .env
npm run dev
```

仅预览界面、无需后端时，可显式启用本地持久化：

```bash
VITE_PERSISTENCE_MODE=local npm run dev
```

需要同时调试本地 API 与 Worker 时，分别启动：

```bash
npm run server
npm run worker
```

开发服务器默认使用 `http://localhost:4173`；`npm run preview` 未指定端口时由 Vite 选择可用端口。容器部署配置保留在 [docker-compose.yml](../docker-compose.yml)，使用前需提供生产所需的数据库、队列、鉴权与对象存储变量。

## 环境变量

以 [.env.example](../.env.example) 为准，不要提交真实密钥。

### Railway 数据、队列与媒体

```dotenv
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
BOTANIC_AUTH_PROVIDER=supabase
BOTANIC_STORAGE_PROVIDER=s3
REALTIME_TICKET_SECRET=...
REALTIME_PUBLIC_URL=https://<railway-api-domain>
S3_ENDPOINT=...
S3_BUCKET=botanic-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Vercel 需配置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_PUBLISHABLE_KEY`；Railway API 需配置对应的 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY` 与仅服务端可见的 `SUPABASE_SECRET_KEY`。`REALTIME_TICKET_SECRET` 以及数据库、S3 凭据不能使用 `VITE_*` 前缀。`REALTIME_PUBLIC_URL` 指向公开的 Railway API 域名，浏览器会自动转换为 `wss://`。访问码鉴权仅作本地应急调试，不用于正式用户。

认证无停机迁移时，Railway 可暂设 `BOTANIC_AUTH_PROVIDER=hybrid`，同时接受旧访问令牌与 Supabase JWT；前端切换并验收后再改为 `supabase`。Supabase 身份通过独立映射绑定既有 Railway 用户，不改写历史项目、任务与媒体归属。

邀请成员时，Supabase Dashboard 的 **Authentication → URL Configuration → Redirect URLs** 需要加入生产首页和 `/auth/callback`（例如 `https://botanic-canvas.vercel.app/`、`https://botanic-canvas.vercel.app/auth/callback`）。Railway 建议设置 `BOTANIC_WEB_URL` 为生产 Web 地址，并将 `SUPABASE_INVITE_REDIRECT_TO` 设为该地址的 `/auth/callback`；未配置时服务端会回退到 Botanic 生产首页，避免把邀请链接发到 localhost。用户打开邀请链接后会进入“设置登录密码”，保存后才用邮箱 + 新密码登录。

### 生成与润色

```dotenv
OPENAI_API_KEY=...
OPENAI_IMAGE_MODELS=gpt-image-2

MINIMAX_API_KEY=...
MINIMAX_IMAGE_MODELS=image-01
MINIMAX_VIDEO_MODELS=MiniMax-H3
VIDEO_GENERATION_TIMEOUT_MS=1200000

FLOCK_API_BASE_URL=https://api.flock.io/v1
FLOCK_API_KEY=...
FLOCK_TEXT_MODEL=deepseek-v4-flash-vision-exp
FLOCK_AGENT_MODELS=deepseek-v4-flash-vision-exp,kimi-k3,gemini-3.7-flash,glm-5
FLOCK_IMAGE_MODELS=gemini-3.1-pro-preview
AGENT_VISION_MODEL=gemini-3.7-flash
AGENT_PLANNER_TIMEOUT_MS=55000
AGENT_RUNTIME_V2=true
AGENT_QUALITY_V2=true
AGENT_MEMORY_V2=true
AGENT_SKILL_GOVERNANCE_V2=true
AGENT_FORK_COMPARE_V2=true
AGENT_CONTEXT_COMPACTION_V2_ENABLED=true
AGENT_CONTEXT_COMPACTION_V2=false
AGENT_CONTEXT_COMPACTION_V2_SHADOW=false
AGENT_TELEMETRY_ENABLED=false
AGENT_GENAI_TELEMETRY_ENABLED=false
OTEL_SERVICE_NAME=botanic-agent
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=
OTEL_TRACES_SAMPLER_ARG=0.1
BOTANIC_MCP_TOOLS_JSON=[]
BOTANIC_WEB_SEARCH_API_KEY=
BOTANIC_WEB_SEARCH_URL=https://api.tavily.com/search
```

`BOTANIC_MCP_TOOLS_JSON` 是服务端版本化能力白名单。每项必须包含 `server`、`tool` 与 HTTPS `url`；建议显式提供
`version`、`inputSchema`、`outputSchema`，另可提供 `authToken`、`timeoutMs` 和 `maxResponseBytes`。省略 Schema
只为存量开放对象配置兼容，新配置应使用 `additionalProperties: false`。运行时从公开身份和 Schema 计算
`capabilityHash`，确认提案固定 `version + capabilityHash`；配置变化后旧提案会在出网前拒绝，必须重新确认。
浏览器目录不包含 URL、token 或传输参数。外部调用统一按 `never` replay，只有请求发出前的校验失败能判定为
已知失败；一旦开始派发，取消、超时、远端 error、协议错误或输出 Schema 错误都进入待人工核对的未知结果。

```json
[{"server":"asset_ops","tool":"publish","version":"1","url":"https://mcp.example.com/rpc","inputSchema":{"type":"object","additionalProperties":false,"properties":{"assetId":{"type":"string"}},"required":["assetId"]},"outputSchema":{"type":"object","additionalProperties":false,"properties":{"publicationId":{"type":"string"}},"required":["publicationId"]},"timeoutMs":12000,"maxResponseBytes":262144}]
```

`BOTANIC_WEB_SEARCH_API_KEY` 是默认联网搜索（Tavily Search API）。只保存在 API 进程；浏览器不出网。不要把 `https://mcp.tavily.com/mcp/?tavilyApiKey=...` 配进 MCP 或 `BOTANIC_WEB_SEARCH_URL`，服务端会忽略这类地址并回退到 `https://api.tavily.com/search`。未配置密钥时没有 `web_search`，但仍可 `web_fetch` 用户给出的公开 HTTPS 页。`web_search` / `web_fetch` 共用每用户每分钟配额（`SECURITY_WEB_RESEARCH_PER_MINUTE`，默认 20），失败也计次。

Agent 对话支持日常问答、Prompt 生成和项目内受控检索。项目本体、画布关系、素材组、项目记忆与已启用 Skill 由服务端按当前项目权限读取；配置了 Tavily 后才允许关键词联网检索。
Agent V2 旗标默认开启，用于统一记录部署与灰度状态；生产切换前应先完成迁移与健康检查。
Context V2 先开 `SHADOW` 对比计数与预算，再按项目开启 active；事故回滚使用
`AGENT_CONTEXT_COMPACTION_V2_ENABLED=false`，配置变更需重启。OTel 只发送 traces；首版不传播 baggage，
也不采集 Prompt、消息、工具参数/结果、Provider body、媒体地址或原始推理。OTLP 建议先发 Collector，
不要把 exporter header 放进 `VITE_*`。GenAI semantic conventions 仍是 development，因此独立默认关闭。
API 与 Worker 必须使用相同的图像 / 视频 Provider 配置。H3 当前目录固定为 2K，画幅支持 `16:9`、`4:3`、`1:1`、`3:4` 与 `9:16`。

### 兼容 Supabase 的部署

需要保留 Supabase 登录或 Storage 时，再配置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY` 与 `SUPABASE_STORAGE_BUCKET`。服务端 secret key 绝不能下发到浏览器。

### 安全策略

- Redis 同时承载跨 API 实例的请求限流；用户级润色、实时票据、成员变更、联网检索与每日生成候选配额相互独立。
- 同一生成任务的幂等重试先读取已有任务，不重复消耗生成配额。
- 上传素材校验单文件大小（8 MB）、MIME 与 PNG / JPEG / WebP 文件签名；媒体 Cookie 只能读取媒体，不能执行写操作。格式白名单与字节嗅探由 `server/mediaFormats.mjs` 单一来源提供。
- 参考图有像素上限 16.78 MP（`MEDIA_LIMITS.maxCanonicalPixels`，4096×4096）。这条上限是接收预算：凡是本产品自己能生成的图（含 Nano Banana 4K 方图），就必须能被重新摄入。它不再绑死 GPT Image 2 的自定义像素窗（仍是 8.29 MP）。准入只按像素数判定，不要再加长边条件。
- 解码有独立上限 80 MP（`maxDecodePixels`），防解压炸弹：生产存储里存在 96 MP JPEG，解成 RGBA 约 384 MB。
- Vercel 与 Nginx 配置 CSP、HSTS、禁止 iframe 嵌入、权限策略和内容嗅探防护。
- 账户安全支持 TOTP 二步验证与“退出其他设备”。Owner 完成 TOTP 设置后，再把 Railway API 的 `SECURITY_REQUIRE_OWNER_MFA` 改为 `true`，即可强制邀请成员、修改权限和删除项目使用 AAL2 会话。
- 对象级授权由统一权限矩阵决定：工作区 Owner 管理成员、共享素材和工作区审计；项目 Owner / Editor / Viewer 分别对应管理、编辑和只读权限。实时票据、画布、润色和生成入口使用同一授权入口。
- 成员、项目、共享素材与账户安全变更写入持久化审计日志；工作区完整审计仅 Owner 可通过 `GET /api/audit` 读取。
- Owner 可从账户菜单打开“安全日志”，按账户、成员、项目和生成类型查看只读记录。

具体阈值见 [.env.example](../.env.example)。安全拒绝、限流与服务端异常会输出结构化事件和 `X-Request-ID`，可由 Railway 日志或后续 Sentry 接收。

上线验收、告警阈值、备份恢复和发布门禁见 [安全运营与恢复](SECURITY_OPERATIONS.md)。

## 验证

合并前必须全绿：

```bash
npm test                      # 199 个测试文件，node:test
npm run check:architecture    # 分层边界
npm run check:security        # 凭据与密钥文件
npm run check:evals           # Agent 回归集
npm run build                 # tsc -b && vite build
npm run test:e2e              # Playwright，16 个用例
git diff --check              # 行尾空白
```

`npm test` 覆盖生成模型目录、任务幂等与恢复、媒体持久化、历史结果回填、WebSocket 鉴权、Yjs 增量和重启恢复，以及画布、素材、模板和投放交付的纯领域规则。`.ts` 测试通过 `--experimental-strip-types` 直接运行，无需构建步骤。

`check:architecture` 阻止 UI 直接依赖数据库、队列、Worker 或 Provider。`check:evals` 的确定性层里有一批**本来就该失败**的样本，输出「失败 N 条」属正常；未跑视觉层的判据记为「无法验证」而不是「通过」。

`test:e2e` 使用本地持久化（`VITE_PERSISTENCE_MODE=local`）与伪健康接口，不调用真实生成 Provider。

`npm run smoke:e2e` 会打真实 Provider，需要单独授权并明确允许消耗额度。普通 UI 变更不得调用真实生图服务。

### 断言要能失败

计数为零、状态未变这类断言，在「功能坏掉」和「什么都没发生」两种情况下都会绿。新增测试后请逐条破坏被测规则，确认**只有对应那条**变红。

这不是形式主义。粘贴功能的 e2e 曾经六条全绿，而破坏 `insideTextEntry` 守卫后仍然全绿——因为往输入框里粘的是纯文字，在更早的一条规则就返回了，根本走不到被测分支。真正的用例（焦点在输入框时粘**图片**）当时并不存在。

同一套测试还暴露过另一种假象：手写的 PNG base64 头部合法但浏览器解不开，读尺寸失败后整条链路静默返回，测试以「什么都没发生」的形式失败，看起来像功能坏了。图片夹具请用 `encodeRgbaPng` 生成真实字节。

## 文档截图

根 README 的产品截图由脚本生成，不要手工替换：

```bash
node scripts/captureDocShots.mjs
```

它自己拉起本地持久化模式的 dev server、用 `src/assets/figma/` 里的示例素材填充画布、截完自己关掉，不打生成 Provider。UI 改动后重跑一次即可，产出覆盖 `docs/images/`。

两个已知限制：画布上呈现的是**导入的素材**而非模型输出（真实生成要花额度，不该由文档脚本触发）；项目列表不截图，因为项目卡封面来自生成结果，脚本跑出来永远是「尚未生成封面」的空块。

## 持续集成

`.github/workflows/quality-and-security.yml` 在 PR 上跑 `verify` 与 `ui-e2e` 两个任务。

**它不是可选的。** 2026-08-26 曾有一个 TypeScript 编译不过的 PR 被合进 `main`，导致 Vercel 与 Railway 都无法构建——当时 CI 因 GitHub 账单问题未启动，两个任务都在 2 秒内失败，看起来像是「红了但无关」。CI 显示失败时请先分辨是代码问题还是任务根本没跑起来，后者要去 Settings → Billing & plans 处理。

## 发布流程

1. 从最新 `main` 创建工作分支，前缀表明变更性质：`feat/`、`fix/`、`docs/`、`refactor/`。
2. 跑完上一节的全部门禁。
3. 推送分支并通过 PR 合并到 `main`。仓库使用 **squash merge**。
4. Vercel 自动部署 Web；Railway 的 API / Worker 服务从同一 GitHub 仓库部署。只有 `main` 会触发生产部署，功能分支不会。
5. 发布后验证线上页面、`/api/health`、登录、项目恢复，以及图片 / 视频历史是否可重新打开。

不要把 GitHub 构建成功当作上线完成；最终以线上 HTML、健康接口与真实页面行为为准。

### 分支清理

PR 合并后请删除源分支。由于用的是 squash merge，被合并的分支相对 `main` 仍会显示「领先若干提交」——**`git branch --merged` 和 `git branch -r --contains` 在这里都会给出错误答案**，判断是否可删除请以 PR 的合并状态为准：

```bash
gh pr list --state all --limit 300 --json number,headRefName,state,mergedAt
```

要确认某个提交的内容是否已进入 `main`，用 patch-id 而非提交哈希比对（squash 后哈希必然不同）。
