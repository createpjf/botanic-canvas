# Botanic · Supabase 迁移说明

## 映射

| 产品能力 | Supabase 实现 | 服务端补充 |
|---|---|---|
| 身份与会话 | Auth Email/Password、邀请 | API 验证 Bearer JWT |
| 项目、成员、审计 | Postgres + RLS | revision 原子 RPC |
| 图片素材与候选图 | 私有 Storage Bucket + `storage.objects` policy | Worker 以 secret key 上传 |
| 生成任务 | `generation_jobs` 表 | Redis/BullMQ Worker、OpenAI 调用 |

迁移 SQL 位于 [20260729170000_botanic_workspace.sql](/Users/leo/Documents/植物学Demo/supabase/migrations/20260729170000_botanic_workspace.sql)。它创建表、Auth 用户触发器、RLS、私有 Storage policy，以及防止项目静默覆盖的 `botanic_write_project_document` RPC。

## 部署边界

- 浏览器：`VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`，只允许用户 JWT。
- API/Worker：`SUPABASE_URL` + `SUPABASE_SECRET_KEY`，用于受控写入和 Worker 上传；任何 service/secret key 都不能出现在客户端。
- Redis 仍独立运行，用于长耗时图像任务的可靠调度。Supabase Edge Function 不承担实际生图 Worker。

## 上线前检查

1. 在 Staging 执行 migration，使用 owner、editor、viewer 三个账户验证所有 RLS policy。
2. 在 Storage policy tester 或浏览器中确认跨项目媒体读取为 403/404。
3. 配置 Auth 站点 URL、重定向 URL、SMTP 与邀请邮件模板。
4. 将 Supabase secret key、OpenAI Key、Redis URL 放入部署平台密钥管理；不要写入 Git。
5. 对数据库、Storage、Worker 重启和 Redis 停机做恢复演练。
