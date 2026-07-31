# Botanic Canvas

Botanic 是面向品牌视觉生产的无限画布工作台。图片、文本和生成节点通过连线组成工作流；提示词、模型参数、候选结果、媒体历史与投放交付都保存在项目文档中。

线上体验：[botanic-canvas.vercel.app](https://botanic-canvas.vercel.app/)

开发前请阅读 [模块接口与依赖方向](docs/ARCHITECTURE.md) 与 [版本及 PR 流程](docs/DEVELOPMENT_WORKFLOW.md)。核心原则是：UI 只表达交互，任务与持久化结果才是生成状态的权威来源。

## 当前能力

- 无限画布：图片、文本、图片生成、视频生成、结果节点与自动连线。
- 图片生成：GPT Image 2、MiniMax Image 01；支持多候选独立结果节点。
- 视频生成：MiniMax H3；支持首帧、首尾帧和参考素材，时长为 5 / 10 / 15 秒。
- 提示词润色：服务端通过 Flock API 调用配置的文本模型，密钥不进入浏览器。
- 候选与历史：候选卡片就地展开，图片和视频分类查看、预览、定位、下载与入库。
- 素材库：本地批量上传、文件夹上传、合集路径、搜索筛选与批量操作。
- 工作流模板：保存可编辑节点、连线、Prompt 与当前生成设置，不保存任务和生成结果。
- 离线与同步：IndexedDB 本地草稿、远端版本冲突保护、历史任务结果回填。
- 投放交付：图片素材更换、单张实时预览、安全区与多规格 ZIP 导出；视频暂不进入图片投放模板。

## 生产架构

```text
Vercel Web
   │ /api 同源转发
   ▼
Railway API ── PostgreSQL（项目、版本、任务、媒体元数据）
   │
   ├── Redis / BullMQ ── Railway Worker ── OpenAI / MiniMax
   │
   └── S3 兼容对象存储（上传素材、图片与 MP4）
```

- Web 通过 [vercel.json](vercel.json) 将 `/api/*` 转发到 Railway API。
- API 负责鉴权、项目文档、幂等任务提交、结果查询与媒体授权。
- Worker 执行长耗时生成，统一将 Provider 输出转换为媒体对象后持久化。
- Redis 只负责调度；PostgreSQL 中的任务与输出记录负责恢复与回填。
- 运行时仍保留 Supabase Auth / Storage Adapter，便于兼容旧环境；当前全 Railway 模式使用访问令牌鉴权、PostgreSQL 与 S3 Adapter。

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

开发服务器默认使用 `http://localhost:5173`；`npm run preview` 默认使用 `http://localhost:4173`。容器部署配置保留在 [docker-compose.yml](docker-compose.yml)，使用前需提供生产所需的数据库、队列、鉴权与对象存储变量。

## 环境变量

以 [.env.example](.env.example) 为准，不要提交真实密钥。

### Railway 数据、队列与媒体

```dotenv
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
BOTANIC_AUTH_PROVIDER=access-token
BOTANIC_BOOTSTRAP_ACCESS_TOKEN=...
BOTANIC_STORAGE_PROVIDER=s3
S3_ENDPOINT=...
S3_BUCKET=botanic-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

`BOTANIC_BOOTSTRAP_ACCESS_TOKEN` 以及数据库、S3 凭据只能写入 API / Worker，不能使用 `VITE_*` 前缀。

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
FLOCK_TEXT_MODEL=<控制台中的模型 ID>
```

API 与 Worker 必须使用相同的图像 / 视频 Provider 配置。H3 当前目录固定为 2K，画幅支持 `16:9`、`4:3`、`1:1`、`3:4` 与 `9:16`。

### 兼容 Supabase 的部署

需要保留 Supabase 登录或 Storage 时，再配置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY` 与 `SUPABASE_STORAGE_BUCKET`。服务端 secret key 绝不能下发到浏览器。

## 验证

```bash
npm test
npm run check:architecture
npm run build
git diff --check
```

`npm test` 覆盖生成模型目录、任务幂等与恢复、媒体持久化、历史结果回填，以及画布、素材、模板和投放交付的纯领域规则。`check:architecture` 阻止 UI 直接依赖数据库、队列、Worker 或 Provider。

普通 UI 变更不得调用真实生图服务；真实 Provider 冒烟测试需要单独授权并明确允许消耗额度。

## 发布流程

1. 从最新 `main` 创建 `codex/<功能>` 分支。
2. 完成本地测试、生产构建、架构检查与差异检查。
3. 推送分支并通过 PR 合并到 `main`。
4. Vercel 自动部署 Web；Railway 的 API / Worker 服务从同一 GitHub 仓库部署。
5. 发布后验证线上页面、`/api/health`、登录、项目恢复，以及图片 / 视频历史是否可重新打开。

不要把 GitHub 构建成功当作上线完成；最终以线上 HTML、健康接口与真实页面行为为准。
