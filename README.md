# Botanic Canvas

Botanic 是面向品牌视觉生产的无限画布工作台。图片、文本和生成节点通过连线组成工作流；提示词、模型参数、候选结果、媒体历史与投放交付都保存在项目文档中。

线上体验：[botanic-canvas.vercel.app](https://botanic-canvas.vercel.app/)

开发前请从 [Agent 开发入口](AGENTS.md) 开始，并阅读 [产品架构文档](docs/PRODUCT_ARCHITECTURE.md)、[代码地图](docs/CODEMAP.md)、[模块接口与依赖方向](docs/ARCHITECTURE.md) 与 [版本及 PR 流程](docs/DEVELOPMENT_WORKFLOW.md)。其中产品架构文档第 3.2 节内置 Agent Ontology 语义定义，覆盖意图、创作维度、素材组、Memory、Skill、Plan、Run 与执行血缘。核心原则是：UI 只表达交互，任务与持久化结果才是生成状态的权威来源。

## 当前能力

- 无限画布：图片、文本、图片生成、视频生成、结果节点与自动连线。
- 图片生成：GPT Image 2、MiniMax Image 01；支持多候选独立结果节点。
- 视频生成：MiniMax H3；支持首帧、首尾帧和参考素材，时长为 5 / 10 / 15 秒。
- 提示词润色：服务端通过 Flock API 调用配置的文本模型，密钥不进入浏览器。
- 候选与历史：候选卡片就地展开，图片和视频分类查看、预览、定位、下载与入库。
- 素材库：本地批量上传、文件夹上传、合集路径、搜索筛选与批量操作。
- 工作流模板：保存可编辑节点、连线、Prompt 与当前生成设置，不保存任务和生成结果。
- 离线与同步：IndexedDB 本地草稿、远端版本冲突保护、历史任务结果回填。
- 实时协作：项目级 WebSocket 推送与 Yjs 节点/连线增量；独立图谱和更新日志可跨 API 重启恢复。
- 投放交付：图片素材更换、单张实时预览、安全区与多规格 ZIP 导出；视频暂不进入图片投放模板。
- Botanic Agent：项目级对话、画布 `@` 引用、创作记忆、Skill / MCP 确认卡、批量分支进度与失败重试、集中结果区和执行路由说明。

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

- Web 通过 [vercel.json](vercel.json) 将 `/api/*` 转发到 Railway API。
- API 负责鉴权、项目文档、实时协作、幂等任务提交、结果查询与媒体授权。
- Worker 执行长耗时生成，统一将 Provider 输出转换为媒体对象后持久化。
- Redis 只负责调度；PostgreSQL 中的任务与输出记录负责恢复与回填。
- 正式用户鉴权使用 Supabase Auth；用户角色、状态、项目、任务与媒体数据保存在 Railway PostgreSQL / S3。

详细依赖方向见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

开发服务器默认使用 `http://localhost:4173`；`npm run preview` 未指定端口时由 Vite 选择可用端口。容器部署配置保留在 [docker-compose.yml](docker-compose.yml)，使用前需提供生产所需的数据库、队列、鉴权与对象存储变量。

## 环境变量

以 [.env.example](.env.example) 为准，不要提交真实密钥。

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
FLOCK_TEXT_MODEL=deepseek-v4-pro
FLOCK_AGENT_MODELS=deepseek-v4-pro,deepseek-v4-flash,kimi-k3
AGENT_PLANNER_TIMEOUT_MS=55000
BOTANIC_MCP_TOOLS_JSON=[]
```

`BOTANIC_MCP_TOOLS_JSON` 是服务端精确白名单。每项必须包含 `server`、`tool` 与 HTTPS `url`，可选 `authToken` 和 `timeoutMs`；浏览器不会收到 MCP 地址或凭据。外部工具调用仍需用户确认。

Agent 对话支持日常问答、Prompt 生成和项目内受控检索。项目本体、画布关系、素材组、项目记忆与已启用 Skill 由服务端按当前项目权限读取；未配置 MCP 时不会声称已联网检索。

API 与 Worker 必须使用相同的图像 / 视频 Provider 配置。H3 当前目录固定为 2K，画幅支持 `16:9`、`4:3`、`1:1`、`3:4` 与 `9:16`。

### 兼容 Supabase 的部署

需要保留 Supabase 登录或 Storage 时，再配置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY` 与 `SUPABASE_STORAGE_BUCKET`。服务端 secret key 绝不能下发到浏览器。

### 安全策略

- Redis 同时承载跨 API 实例的请求限流；用户级润色、实时票据、成员变更与每日生成候选配额相互独立。
- 同一生成任务的幂等重试先读取已有任务，不重复消耗生成配额。
- 上传素材校验单文件大小、MIME 与 PNG / JPEG / WebP 文件签名；媒体 Cookie 只能读取媒体，不能执行写操作。
- Vercel 与 Nginx 配置 CSP、HSTS、禁止 iframe 嵌入、权限策略和内容嗅探防护。
- 账户安全支持 TOTP 二步验证与“退出其他设备”。Owner 完成 TOTP 设置后，再把 Railway API 的 `SECURITY_REQUIRE_OWNER_MFA` 改为 `true`，即可强制邀请成员、修改权限和删除项目使用 AAL2 会话。
- 对象级授权由统一权限矩阵决定：工作区 Owner 管理成员、共享素材和工作区审计；项目 Owner / Editor / Viewer 分别对应管理、编辑和只读权限。实时票据、画布、润色和生成入口使用同一授权入口。
- 成员、项目、共享素材与账户安全变更写入持久化审计日志；工作区完整审计仅 Owner 可通过 `GET /api/audit` 读取。
- Owner 可从账户菜单打开“安全日志”，按账户、成员、项目和生成类型查看只读记录。

具体阈值见 [.env.example](.env.example)。安全拒绝、限流与服务端异常会输出结构化事件和 `X-Request-ID`，可由 Railway 日志或后续 Sentry 接收。

上线验收、告警阈值、备份恢复和发布门禁见 [安全运营与恢复](docs/SECURITY_OPERATIONS.md)。

## 验证

```bash
npm test
npm run check:architecture
npm run check:security
npm run build
npm run test:e2e
git diff --check
```

`npm test` 覆盖生成模型目录、任务幂等与恢复、媒体持久化、历史结果回填、WebSocket 鉴权、Yjs 增量和重启恢复，以及画布、素材、模板和投放交付的纯领域规则。`check:architecture` 阻止 UI 直接依赖数据库、队列、Worker 或 Provider。`test:e2e` 使用本地持久化与伪健康接口验证项目、画布、Agent 与面板顺序，不调用真实生成 Provider。

普通 UI 变更不得调用真实生图服务；真实 Provider 冒烟测试需要单独授权并明确允许消耗额度。

## 发布流程

1. 从最新 `main` 创建 `codex/<功能>` 分支。
2. 完成本地测试、生产构建、架构检查与差异检查。
3. 推送分支并通过 PR 合并到 `main`。
4. Vercel 自动部署 Web；Railway 的 API / Worker 服务从同一 GitHub 仓库部署。
5. 发布后验证线上页面、`/api/health`、登录、项目恢复，以及图片 / 视频历史是否可重新打开。

不要把 GitHub 构建成功当作上线完成；最终以线上 HTML、健康接口与真实页面行为为准。
