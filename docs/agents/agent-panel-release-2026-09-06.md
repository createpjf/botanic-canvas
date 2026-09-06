# Agent 面板发布候选 · 2026-09-06

## 范围与状态

- 目标：本地候选 → Staging 真实生成/编辑/补图/取消及双会话 → 真机 → 生产。任何未通过项不作为已上线证据。
- 候选从现有 `feat/agent-elements-p1-p2` 整理，不切换或覆盖原工作树。基线 `7810a84` 与远端 `main@ef01a56` 文件树一致（此前 squash 合并）。
- 收录 Agent UI、领域投影、消息/运行恢复、共享画布同步修复、对应测试、协议和依赖，以及既有修复计划/进度文档。`AGENTS.md` 与本地 `.gitignore` 修改不纳入此发布提交。
- 移除没有代码消费者的 `ansi-to-react`，消除其 `linkify-it` 高危依赖链。移除后 `npm audit --omit=dev --audit-level=high` 为 0 漏洞；完整发布门禁另记执行结果。

## 已核实的部署目标

| 部分 | Staging | Production |
| --- | --- | --- |
| Railway project | `76d2b880-d294-462b-b6df-205d678c6f5f` | 同项目 |
| environment | `785ddd8c-d18d-4a6d-b83a-c7a7b32cd58a` | `b46f722a-ed5f-4b4d-b41f-bda25ed9cd35` |
| API | `api-staging-35d7.up.railway.app` | `api-production-cc46.up.railway.app` |
| API service | `fc11b511-0af8-46ea-b905-17fdaabf455c` | 同服务、不同环境 |
| Worker service | `1ea46de4-fdfd-4f98-8d55-418e64765048` | 同服务、不同环境 |
| Web | 需使用指向 Staging API 的候选预览 | `botanic-canvas.vercel.app` |

- 检查时 Staging / Production 的 API 与 Worker 均跟随 `main`，且 `checkSuites=false`。不可先合并 main 再做 Staging 验收；必须先使用候选来源部署 Staging。
- Vercel 项目 `prj_mcbfB7jmKQF1WDDSiMf8Ef8towkn`，team `team_1ZXgDM69v9sgStD8kS1m4wUa`。检查时最新生产部署 `dpl_DAVcyhUQWbk22qvRfEU8Ut2PXGFK` 为 READY；不是本候选发布结果。
- 当前 `vercel.json` 的 `/api` rewrite 固定指向生产。候选预览必须显式核对同源 API 与 WebSocket 的实际目的地，不能把普通 Preview URL 当作 Staging。
- Staging 健康接口：`persistence=postgres, queue=redis, media=storage, auth=supabase`。数据库和 Redis 配置与生产不同；媒体 bucket/endpoint 与 Supabase Auth URL 相同。测试只创建独立项目及唯一媒体键，不清桶、不改真实用户、不做共享 Auth 破坏性故障注入。

## 数据库兼容边界

- 随代码保留三份 Supabase Adapter 迁移：`20260904234954` 确认答案一致性、`20260905004125` JSONB 优先级、`20260905065929` 部分结果重试。
- 它们尚未应用到共享 Supabase。不可因产品使用 Supabase Auth 就把产品 RPC 迁移施加到该库；当前 Staging 产品数据权威是 Railway PostgreSQL。
- PostgreSQL Adapter 复用本次变更的 JS 消息/Run 合并语义；部署前仍需核实生产 persistence 与运行版本。不得默认执行所有历史 Supabase 迁移或切换项目 epoch。
- 若目标实际使用 Supabase ProductStore，必须先在隔离数据库核对 RPC 前置迁移、新旧调用兼容、执行权限和回滚，再申请对应共享库迁移操作。

## 本轮验收额度与放行项

- 用户新增授权：最多 **6 次**真实图片 Provider 请求；单独计数，派发后取消也计入；用尽即停止。本地前轮 6/6 不重置、不与本轮混算。
- [x] 当前候选内容完整 `release:ready`：2839 单元/契约通过、2 可选 PG 跳过；Eval 与安全/架构/构建通过；Chromium 29 通过、19 隔离 UAT 跳过（52.9秒）。日志 `/private/tmp/botanic-release-20260906-gates.log`；隔离 UAT 需另验，不将跳过计为通过。依赖审计 0 漏洞、diff 检查通过。
- [ ] 候选提交与部署版本绑定。
- [ ] Staging Web/API/Worker 同一候选版本，确认访问不会落到生产 API。
- [ ] 真实图片生成 → Run/Job → Canvas → Artifact → 消息结果；指定图编辑保持父图不变。
- [ ] 补图只补缺失、取消/迟到确认不重复派发；恢复后图片仍可读。
- [ ] 独立测试项目双会话同步、断线恢复与权限隔离。
- [ ] 物理手机软键盘、附件移除、发送/取消；需用户实际设备反馈，不用桌面模拟替代。
- [ ] 生产发布前确认回滚 revision、在途任务与数据库兼容；发布后核对正式域名、API/Worker、历史结果和控制台。

## 回滚

前端显示回归可回滚对应前端部署；消息/Run 语义回归需回滚兼容的 API/Worker 与前端组合。保留已创建项目、消息、Run、Job 与 Artifact；不通过删除数据或降低 epoch 回滚。生产部署只在上述门禁全部通过后执行。
