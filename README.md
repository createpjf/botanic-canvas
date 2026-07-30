# Botanic Canvas · Supabase

Botanic 是以生成节点为中心的创意工作台：画布连线决定参考输入，生成配方、候选图与分支均归属当前节点。

## 生产架构

- **Supabase Auth**：邮箱/密码登录与成员邀请；浏览器仅持有 publishable key 与用户 JWT。
- **Supabase Postgres**：项目、版本、成员、生成任务、媒体元数据与审计记录。
- **RLS**：成员角色、项目、审计和 Storage 对象均有数据库层授权策略。
- **Supabase Storage**：私有 `botanic-media` Bucket 保存上传素材与生成结果。
- **Redis + BullMQ Worker**：处理可恢复的长耗时生图任务；API 与 Worker 均使用 Supabase secret key，绝不下发给浏览器。

Supabase 的 Edge Functions 适合短请求编排；图像生成属于长耗时且需恢复的任务，继续由独立 Worker 承担。[官方说明](https://supabase.com/docs/guides/functions)也建议将重型长任务移到后台 Worker。

## 首次接入 Supabase

1. 新建 Supabase 项目，在 **SQL Editor** 执行 [迁移文件](/Users/leo/Documents/植物学Demo/supabase/migrations/20260729170000_botanic_workspace.sql)。也可在本仓库初始化并链接项目后执行：

   ```bash
   supabase init
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

2. 在 Supabase Auth 打开 Email 登录；把你的生产域名与 `SUPABASE_INVITE_REDIRECT_TO` 加到 Auth URL Configuration。

3. 复制 `.env.example` 为 `.env`，填写：

   ```dotenv
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...
   SUPABASE_BOOTSTRAP_OWNER_EMAIL=owner@company.com
   OPENAI_API_KEY=...
   ```

   `SUPABASE_SECRET_KEY`（或旧的 `SUPABASE_SERVICE_ROLE_KEY`）只能用于 API 与 Worker。它会绕过 RLS，绝不能写入 `VITE_*`、前端构建产物或浏览器环境。[官方密钥说明](https://supabase.com/docs/guides/getting-started/api-keys)

4. 首位使用 `SUPABASE_BOOTSTRAP_OWNER_EMAIL` 登录的用户会成为工作区 owner；之后 owner 通过 `POST /api/users` 发起 Supabase 邮件邀请，并分配项目 owner / editor / viewer。

5. 启动：

   ```bash
   docker compose up --build
   ```

   打开 `http://localhost:8080`，使用 Supabase Auth 邮箱与密码登录。

## 安全与恢复

- RLS policy 使用 `auth.uid()` 和项目成员表判断访问，不读取可被用户篡改的 `user_metadata`。
- Storage Bucket 是私有的；媒体读取必须匹配 `media_objects` 与项目成员关系。
- Redis 保存调度；Worker 启动时会从 PostgreSQL 的 `queued` 任务恢复。取消已发往图像供应商的调用不能撤销上游计费，但结果不会回写。
- 定期备份 Supabase Postgres 与 Storage，并演练恢复；Redis AOF 仅用于任务队列恢复。

## 本地界面原型

无需服务端时可显式使用 IndexedDB：

```bash
VITE_PERSISTENCE_MODE=local npm run dev
```

旧文件与直连 PostgreSQL Adapter 只保留用于本地迁移/测试，Docker 生产编排不再使用它们。
