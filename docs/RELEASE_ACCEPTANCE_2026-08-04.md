# Agent Ontology 与 Artifact Index 发布验收证据

验收日期：2026-08-04（Asia/Shanghai）
目标：PR #15 `codex/release-agent-ontology-artifact-index` → `main`

## 验收结论

合并前门禁通过。生产环境三角色权限、真实生成、Artifact Index 在线写回、安全配置与真实 PostgreSQL 迁移均已完成脱敏验证。

## 自动化门禁

- 服务端测试：184 项通过。
- 客户端测试：120 项通过。
- `npm run build`、`npm run check:architecture`、`npm run check:security`、`git diff --check` 通过。
- PR head `f5486fe` 的 GitHub `Quality and security / verify` 通过；验收文档提交后需再次以新 head 复核。

## PostgreSQL 迁移

使用临时 PostgreSQL 17 空库执行真实 `createPostgresProductStore` 启动与迁移：

| 场景 | 结果 |
| --- | --- |
| 空库完整迁移 | PASS |
| 跨项目 Agent 实体 ID 冲突阻断启动 | PASS |
| Artifact payload 畸形对账阻断启动 | PASS |
| 修正异常数据后恢复启动 | PASS |

临时容器和脚本已清理，不涉及生产数据变更。

## Supabase Auth 安全

- 项目：Botanic Auth（Pro）。
- leaked-password protection 已启用。
- 启用后重新执行 Supabase Security Advisor：0 条告警。
- 变更过程中未输出或归档 Access Token、Secret Key、用户密码或 MFA Secret。

## 生产权限矩阵

- 三个临时独立账号：Workspace Owner / Project Owner、Workspace Member / Project Editor、Workspace Member / Project Viewer。
- 三个账号均完成 TOTP AAL2 验证。
- 66 / 66 个断言通过，66 个响应均捕获 Request ID。
- 覆盖项目文档、生成任务、Agent Run、Artifact Index、项目修改、历史回填、成员管理、项目与工作区审计、共享素材与工作流、项目删除。
- 未授权已存在项目保持 403；不存在项目保持 404；未登录 Artifact Index 保持 401。
- Viewer 提交生成在创建任务前返回 403；Owner 最小真实生成返回 202 并最终成功。
- 三角色重新登录后均可按角色读取 Artifact Index。

## 真实生成与 Artifact Index

- 使用生产图片模型提交 1 个最小图片任务。
- Worker 将任务推进至 `succeeded`，输出数大于等于 1。
- Artifact Index 查询到 `origin.jobId` 与本次任务一致的新 Artifact。
- 验收后删除临时项目；再次查询生产数据库，临时用户、项目、任务、Artifact 计数均为 0。
- 再次扫描 Supabase Auth，`rbac-matrix-*` 临时账号计数为 0。

## 发布后待回填

- Merge commit SHA 与合并时间。
- Railway API、Railway Worker、Vercel Production 新部署 ID。
- 新 revision 的健康检查、浏览器控制台、15 分钟错误日志和 Artifact 对账结果。
