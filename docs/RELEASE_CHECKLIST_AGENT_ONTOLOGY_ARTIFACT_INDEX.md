# Agent Ontology 与 Artifact Index Release Checklist

快照日期：2026-08-04（Asia/Shanghai）
目标 PR：#15 `codex/release-agent-ontology-artifact-index` → `main`

## A. 已固化基线

- [x] Release commits：`26c6a1a 发布 Agent Ontology 与 Artifact Index 闭环`、`f5486fe 完善提交恢复与实体冲突收口`
- [x] 分支已推送并创建 Draft PR #15
- [x] PR CI `Quality and security / verify` 通过
- [x] 基线测试：服务端 175 项、客户端 116 项通过
- [x] `npm run build`、`npm run check:architecture`、`npm run check:security` 通过
- [x] Railway API、Worker 与 Vercel 已有成功部署记录
- [x] 生产历史 Artifact 对账：期望 40、缺失 0、畸形 0

## B. 合并前阻断项

- [x] “提交状态未知恢复 + Agent 实体时间戳冲突规则”任务完成
- [x] 确认对方任务不再运行，避免同一工作区并发覆盖
- [x] 审查其未提交 diff，只纳入当前 Release 范围内文件
- [x] 解决 [PR Standards / Spec 审查](./PR15_REVIEW.md)中的代码 blocker
- [x] 执行 [权限矩阵验收计划](./ROLE_MATRIX_ACCEPTANCE_PLAN.md)，附脱敏证据
- [x] Supabase leaked-password protection 已启用，安全顾问复核为 0 条告警
- [x] 工作区 `git status --short` 干净（验收文档提交前基线）
- [x] 最终差异通过 `git diff --check`

## C. 最终门禁

整合提交后重新执行，不复用旧结果：

- [x] `npm test`：服务端 184 项、客户端 120 项
- [x] `npm run build`
- [x] `npm run check:architecture`
- [x] `npm run check:security`
- [x] PostgreSQL 与 Supabase 迁移回归测试通过
- [x] Agent Session / Message / Memory / Run 的旧新数据合并测试通过
- [x] Artifact Index 回填、查询、权限与删除节点后保留测试通过
- [x] 离线消息、提交状态未知、重连与跨设备恢复测试通过
- [ ] GitHub PR checks 全绿且 head SHA 与待合并 SHA 一致

## D. 人工验收

- [x] Owner / Editor / Viewer 项目 API 权限矩阵通过
- [x] 工作区 Owner / Member 敏感 API 权限矩阵通过
- [x] 三角色 AAL2 登录、重新登录及 Artifact 恢复读取通过
- [x] Artifact 历史查询、回填与继续修改的服务端角色权限通过
- [ ] 生产或 staging 浏览器首屏、控制台和关键网络请求无新增错误
- [ ] 历史项目恢复抽样完成，记录项目 ID 与 Artifact 数量

## E. 需要单独授权的验收

- [x] 使用真实生成额度创建一个最小图片任务
- [x] 验证 Worker 完成后 Artifact Index 出现对应新增记录
- [x] 验证新增 Artifact 的 `projectId`、`jobId`、类型与媒体引用一致
- [x] 验证重新登录后 Artifact 仍可通过服务端索引读取

脱敏执行证据见 [Release Acceptance](./RELEASE_ACCEPTANCE_2026-08-04.md)。

## F. PR 与合并

- [ ] 将后续提交推送到 PR #15
- [ ] 更新 PR 变更范围、测试数量、已知限制和验收证据
- [ ] Draft 转 Ready for review
- [ ] 至少完成一次人工审查，关闭所有 blocker
- [ ] 确认 PR 可合并且没有落后 `main`
- [ ] 合并到 `main`，记录 merge commit SHA 和时间

## G. 合并后发布

- [ ] 从 `main` 发布 Railway API
- [ ] 从同一 revision 发布 Railway Worker
- [ ] 从同一 revision 发布 Vercel Production
- [ ] 记录三个部署 ID，确认代码 revision 一致
- [ ] Railway `/api/health` 返回 200，且 `persistence=postgres`、`auth=supabase`、`queue=redis`
- [ ] Vercel `/api/health` 返回 200 且与 Railway 一致
- [ ] 未登录 Artifact Index 返回 401；角色矩阵关键用例抽样通过
- [ ] 观察至少 15 分钟：API 无新增 5xx，Worker 无 error / stalled，前端控制台无新增错误
- [ ] 重新执行 Artifact 数量与 payload 完整性对账

## H. 回滚与关闭

- [ ] 发布前确认上一成功 API / Worker / Vercel 部署 ID 可用
- [ ] 若出现越权、重复生成、Artifact 丢失或迁移异常，立即停止继续发布并回滚应用版本
- [ ] 加法迁移不以删除新表作为常规回滚手段
- [ ] 回滚后复核健康接口、历史项目读取和 Artifact 对账
- [ ] 在 PR 或发布记录中写明原因、影响、回滚版本和后续修复项
- [ ] 全部验收证据归档后关闭 Release
