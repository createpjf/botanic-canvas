# Agent 面板发布候选 · 2026-09-06

## 当前发布准备结论 · 2026-09-07

### main 发布推进

- 用户已授权全部本地开发合并 main 并部署生产。20 文件提交为 `4e250fd`；确认 origin/main 的树与祖先 `7810a84` 完全一致后，以 `a07afab` 接回 squash 历史，不丢弃 main 独有代码、不强推。
- 隔离 localhost:4195 Chromium 全量：29 passed、19 skipped；跳过项需要额外隔离账号/运行夹具，不作为真实链路通过。两条旧展开断言和旧附件折叠入口已按新 UI 语义更新；移动端输入恢复 16px，桌面保持 14px。构建/架构/diff 检查通过，生产依赖 audit 为 0 vulnerabilities。
- 生产健康响应确认 persistence=postgres、auth=supabase；此次新 Supabase RPC 文件不应用到独立 PostgreSQL Adapter，不自动执行共享迁移。
- 生产 main 推送自动触发 Railway API/Worker 与 Vercel。先发布支持专用版本头的 API，再推 main，避免新前端早于兼容服务端。
- 发布前回滚记录：Vercel `dpl_DAVcyhUQWbk22qvRfEU8Ut2PXGFK`（ef01a56）；API `54620be8-d132-4d37-8330-56aaa83e512d`；Worker `e8de420e-c540-4184-8bdf-a421006efccd`。
- 生产部署结果以后续实际平台状态为准。真实 Staging 断网、付费补图/取消与真机仍未完成，不以本地隔离 E2E 替代。

本节为最新状态，下方历史记录保留原时间点结论，不代表当前全部通过。

- 基线：`9691b7b32bf5aa771d8c6c0f054856d0dabc8067`，分支 `feat/agent-elements-p1-p2`。20 个本地变更文件尚未提交；未推送、未合并、未部署生产。
- 当前 Staging 前端 `dpl_7PHHnroEv2kgPnS7FsCLfR2KKZLQ`（`1plnzs7lb`），API `28d8d3b6-21ec-4be8-a51b-43e798359716`，仅为基线加四文件同步补丁，不是完整工作树。GSAP 与其余 UI 改动尚未包含。
- 全量本地回归：2874 pass、2 skipped、0 fail；架构、构建、安全扫描与 diff 检查通过。固定 Eval 9 条符合期望；意图检查两组 43/69 条通过。无真实 Provider 调用；构建仍有大包警告。
- 测试日志：`/private/tmp/botanic-full-release-{tests,architecture,build,security,evals}.log`。

### 发布文件清单（20 个）

| 组 | 文件 |
| --- | --- |
| 同步版本头与回执恢复（4） | `src/lib/db.ts`、`server/http/projectRoutes.mjs`、`server/http/httpServer.test.mjs`、`scripts/agentRecovery.test.mjs` |
| 欢迎动画生命周期（2） | `src/features/agent/AgentWorkspace.tsx`、`scripts/agentWelcomeAnimation.test.mjs` |
| Agent 展示领域与测试（6） | `src/domain/agentMessageUtilities.ts`、`src/domain/agentMessageUtilities.test.ts`、`src/domain/agentReviewPresentation.ts`、`src/domain/agentReviewPresentation.test.ts`、`src/domain/agentToolAccordion.ts`、`src/domain/agentTimeline.test.ts` |
| Composer、消息、样式（5） | `src/features/agent/AgentComposer.tsx`、`src/features/agent/AgentConversationMessage.tsx`、`src/features/agent/AgentMentionText.tsx`、`src/styles.css`、`src/styles/ai-elements.css` |
| 仓库规则与发布记录（3） | `.gitignore`、`AGENTS.md`、本文件 |

### 已有证据与未完成项

1. 同步补丁在原项目双页已通过：静置无写回、A→B/B→A 更新、离开再进入读取新内容；观察到三次画布 PATCH 均 200，没有重复 412。测试名称已恢复。没有用覆盖按钮或清理草稿收尾。
2. GSAP 修复本地打开 Agent 加载历史消息后无目标缺失警告，回归检查通过；尚无该补丁 Staging 证据。
3. 完整候选还需同一版本的 Staging UI 验收：引用移出气泡、评审正文隐藏但 Artifact/评审入口保留、总用时、计划展开/确认、附件移除与键盘操作。历史部分版本的通过结果不能替代完整候选。
4. 真实断网恢复、360/768/1440、200% 缩放及真机验收未完成。离开再进入不等于真实断网。移动规则当前将 Composer textarea 设为 14px，须在 iOS 真机确认焦点缩放/布局，必要时仅移动端恢复 16px，不改桌面密度。
5. 补图、生成中取消仍缺本轮完整链路证据；既有真实单图编辑通过记录保留，不能据此宣称补图/取消也通过。付费 Provider 的额度与授权须在执行前重新核对。
6. `release:ready` 包含 Chromium E2E，本轮尚未运行。现有配置可复用 localhost:4173，但该端口已有用户服务；不可盲跑并把真实工作区当隔离测试环境。

### 落地与放行顺序

- 确认清单后提交完整候选，记录可追溯 SHA；保留所有现有用户改动，不夹带环境文件。
- 从该 SHA 创建独立部署包，先 Staging API、后前端；前端代理显式指向 Staging。此处本地 diff 不涉及 Worker，但生产候选必须另外核对当前 Worker 与目标 SHA 的差异，不能因为本轮没改 Worker 就假定生产已有历史修复。
- 补齐上列真实验收与隔离 E2E；生产关闭 `VITE_CANVAS_WRITE_TRACE` 调试开关。无数据库迁移需求，不清理 Run、Job、Artifact 或草稿。
- 验收通过再确认生产发布范围、API/Worker/前端版本及回滚目标。当前结论：本地门禁通过，尚不具备完整生产放行证据。

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
- [x] 候选提交 `7adcc2153892afbe5c1a9a7ae8f250a0c6501982` 已推送现有功能分支；195 个相关文件，原 `AGENTS.md` / `.gitignore` 修改仍留本地。
- [ ] Staging Web/API/Worker 同一候选版本，确认访问不会落到生产 API。
- [ ] 真实图片生成 → Run/Job → Canvas → Artifact → 消息结果；指定图编辑保持父图不变。
- [ ] 补图只补缺失、取消/迟到确认不重复派发；恢复后图片仍可读。
- [ ] 独立测试项目双会话同步、断线恢复与权限隔离。
- [ ] 物理手机软键盘、附件移除、发送/取消；需用户实际设备反馈，不用桌面模拟替代。
- [ ] 生产发布前确认回滚 revision、在途任务与数据库兼容；发布后核对正式域名、API/Worker、历史结果和控制台。

## 回滚

前端显示回归可回滚对应前端部署；消息/Run 语义回归需回滚兼容的 API/Worker 与前端组合。保留已创建项目、消息、Run、Job 与 Artifact；不通过删除数据或降低 epoch 回滚。生产部署只在上述门禁全部通过后执行。

## Staging 部署检查点

- 部署前只读确认 Staging `agent_turns` / `agent_runs` / `generation_jobs` 均无记录，无在途任务。
- Railway 环境级 `source.branch` 修改返回 `No changes to apply`，回读仍是 `main`，没有宣称来源隔离已生效。改为从 `git archive 7adcc21` 快照显式上传到 Staging API/Worker；在生产放行前不合并 main。
- API 部署 `1c733114-6f11-4261-af10-6f4f0a296130` 与 Worker 部署 `181bd8ab-a0e1-46b5-9dcf-915c9bebb5e9` 均 SUCCESS。两容器通过只读 SSH 核对 `agentVisionImage.mjs`、`agentMessageMerge.mjs`、`package-lock.json` SHA256，与候选全部一致。Staging 与生产健康接口均返回 `ok / postgres / redis / storage / supabase`，生产未部署本候选。
- Web 从同一候选快照部署，唯一环境专用文件差异为 `vercel.json` API rewrite 指向 Staging；显式设置公开客户端 Auth 配置与 `VERCEL_GIT_COMMIT_SHA=7adcc2153892afbe5c1a9a7ae8f250a0c6501982`，不带本地环境文件或产品数据。上传清单检查 1040 文件，敏感路径命中 0。
- Web deployment `dpl_4ipbWCdWSZaaifTDueBiDVhBsuQN` 已 READY（Vite 构建29.53秒，保留大包警告），URL `https://botanic-canvas-rpwjuscqz-createpjfs-projects.vercel.app`。浏览器先被 Vercel Deployment Protection 引导到登录，已请用户在内置浏览器登录 Vercel 与 Botanic 测试账号；没有提取浏览器令牌或放宽保护。部署 READY 不替代受保护页面的登录后验收。
- 新授权图片额度当前 **0/6**。真实链路、补图/取消、双会话、物理手机均未在这个 Staging 候选上验收；生产保持未放行。共享 Supabase 未执行迁移，未切换 epoch，未删除任何远端账号或媒体。

### 2026-09-07 登录后隔离检查（阻塞）

- 用户已完成登录，浏览器实际地址仍为上述 Preview 的 `/#/projects`；页面显示 30 个历史项目。未新建、修改或删除任何项目，未调用图片 Provider。
- 通过 Staging API 容器的 `DATABASE_URL` 只读统计：`projects=0`、`agent_runs=0`、`generation_jobs=0`，与页面项目列表不一致。
- Railway 域名归属确认为 Staging API；Vercel 已上传的 `vercel.json` SHA1 为 `b5fd10b064f9f53bfe8d69d44e081a39fbf0d988`，与隔离快照一致，文件中的 API rewrite 指向 Staging。部署详情返回 `routes: null`，不能据此证明实际路由，也不能据此认定串到生产。
- 当前根因未确认。项目列表实现仅在网络错误时回退本地缓存；尚未取得证据区分缓存回退与有效路由异常。环境隔离核验通过前，暂停写入、真实图片验收和生产放行；新授权额度仍为 **0/6**。

### 2026-09-07 路由根因与修正

- 后续通过 Vercel CLI 的受保护部署健康检查确认：旧 Preview 返回 `agentPlanner.model=deepseek-v4-flash-vision-exp`，与生产一致；直接读取 Staging 健康接口为 `deepseek-v4-pro`。Vercel 项目级 Routes 为 0，排除项目级覆盖。
- Vercel CLI 56.5.0 的 `earlyGetConfig()` 使用 `process.cwd()`，在主流程应用 `--cwd` 之前读取并缓存配置；deploy 又优先复用 `client.localConfig`。此前从工作区运行 `deploy --cwd <隔离快照>`，会携带工作区生产路由，尽管上传的文件确为 Staging 配置。这是发布命令错误，不是 Agent 项目列表数据混合。
- 修正：进程真实 cwd 使用隔离快照，并显式传入绝对路径 `--local-config /private/tmp/botanic-release-7adcc21.lAppWc/vercel.json`，不修改生产配置或项目级路由。
- 新 Preview `dpl_Dgt3FRrWV3nv4UqAdf8rmke9Shok`：`https://botanic-canvas-e6fjmff7f-createpjfs-projects.vercel.app`；构建中的 inspect 已确认 API 有效目标为 `https://api-staging-35d7.up.railway.app/api/$1`。仍须完成 READY 后健康及登录后空项目列表验证，方可开始写入。额度仍 **0/6**。
- 新部署已 READY；Vercel CLI 读取新 Preview `/api/health` 返回 `ok / deepseek-v4-pro / postgres / redis`，与 Staging 一致。浏览器已导航到新地址，但新域名尚无 Botanic 登录态，已打开登录入口。需要用户在新 Preview 登录后继续空列表及真实链路验收；未复制旧域名的会话令牌，未放宽认证。

### 2026-09-07 真实验收第 1 次

- 登录后确认 0 个项目；新建隔离项目 `project-1788744037050`，普通问答返回“Staging 文本验收通过”。
- 确认单图计划（GPT Image 2，1:1，2K，1 张），生成绿色陶瓷花盆与薄荷。Job `job_CimDyqD4rg6H-CvvPwobeQeIRoX_7jlR0q8c1bwRq-c` 数据库状态 `succeeded`，Run `agent_run_QFW78_bOMb6fbw2w_9nSdwXIFmDNVvR8xcu60AtroJs` 为 `completed`；UI 用时 44 秒，画布与对话出现图片。已提交 1 次单图生成，预算保守记 **1/6**（尚未逐条核对 Provider 内部请求日志）。
- 同一图片、执行过程和“继续修改”在对话出现两套；第二页面恢复后仍复现，UI 去重验收不通过。
- Staging `REALTIME_PUBLIC_URL` 仍为生产 API 地址；已仅修改 Staging API 为 `https://api-staging-35d7.up.railway.app`。待 Job/Run 终态后显式上传同一候选，部署 `0c66ae9c-02ad-4579-a4da-4ea712b60671` SUCCESS；Worker 与生产未更改。两页面随后显示“已保存”。
- 第二个同账号页面成功恢复 1 个结果，将其命名为“Staging 薄荷验收 01”。第一页面仍为“新图”，有版本冲突，本地 revision 10、云端 revision 14；双页面实时同步尚不能判通过，且不等同跨账号权限验收。
- 第一页面打开“协作动态”，显示“协作动态同步失败”；点击“放弃本地，使用云端”后出现浏览器原生确认“确定用云端版本替换当前本地草稿吗？”。自动点击被确认框中断，后续 AX 读取超时，未重复点击或宣称恢复成功。仅涉及本轮隔离项目。
- 指定图编辑、补图、取消、双页面恢复完整验证、真机与生产发布仍未完成。生产继续不放行。

### 确认使用云端后的复核

- 用户确认后，第一页面图片名称恢复为“Staging 薄荷验收 01”，协作动态可读取 30 条；原先读取失败已不再出现。
- 返回对话后，原会话标题仍在，但正文历史消失、显示空态；历史菜单亦显示“还没有消息”。重新导航同一项目后仍复现。期间云端新版本提示再次出现，不能判定冲突恢复流程通过。
- 同一 Staging API 的只读数据库检查：该项目仍有 `agent_messages=6`、`agent_sessions=1`、`agent_runs=1`、`generation_jobs=1`。因此本次证据是前端消息恢复/展示异常，不是已证实的数据库消息删除。
- 暂停追加付费生成，保持预算暂记 **1/6**；需先修复消息恢复与结果重复展示，再继续编辑、补图和取消验证。

### 本地修复与门禁

- 云端恢复在重新打开文档后，复用 `refreshAgentEntitiesFromRemote()` 刷新独立 Session/Message/Run；刷新期间切换项目则不向新项目写入成功状态。仅重新读取，不重发生成。
- 提取纯展示 `agentConversationMessages()`，把携带同一 Run 的 assistant `text` 评审回复纳入原有 `run/notice` 去重；用户消息、确认计划、其他 Run 均保留，不删除持久化消息。
- 新增去重回归测试：完整测试通过 1993 条服务端 + 847 条客户端，0 失败、2 条原有可选测试跳过；架构检查、构建、diff 检查通过。构建仍有原有大包警告。初次默认沙箱监听端口 EPERM，随后通过权限机制运行成功。
- 四个修复文件尚未提交、尚未部署；平台审批拒绝本次 Git 提交，要求明确提交授权。不得将本地测试当作 Staging 恢复验收。预算仍暂记 **1/6**，补图、取消和双会话验收未继续，生产未发布。

### 授权后的修复发布

- 用户明确授权后，仅四个修复文件提交到当前 `feat/agent-elements-p1-p2` 分支：`d721079f7567d848c7a68e01ee75a58603a05998`。用户的 `.gitignore`、`AGENTS.md` 与本验收记录未并入该提交；未推送 Git、未合并 main。
- 从该提交归档创建隔离快照，仅快照的 `vercel.json` 使用 Staging API；真实进程 cwd 与 `--local-config` 均显式指向快照。
- Web Preview：`dpl_Dx44ki4sDrXnqoq48k5END91oZAD`，`https://botanic-canvas-grc2id94p-createpjfs-projects.vercel.app`。本次只更新前端，API/Worker、数据库与生产不变；未调用图片 Provider。
- 已确认 READY；构建中的有效 API route 指向 `api-staging-35d7.up.railway.app`，完成后的健康响应为 `ok / deepseek-v4-pro / postgres / redis`，与 Staging 一致。修复的登录后浏览器复验以及补图、取消、双会话验收仍待继续，不标记已通过。

### d721079 登录后复验与遗漏补丁

- 新登录打开 Agent 能读取原问答与生成历史，但同一结果仍出现两次：另一个来源是 `status=submitted` 的 plan，不是仅有 notice/text。此前去重回归缺少这个真实组合，不能标记修复通过。
- 补充原有测试，先确认失败，再将已提交且带 Run 的计划纳入去重；未提交计划和用户消息保留，只有计划而尚无后续回复时仍显示计划。提交 `f6809ba9486fb930d9a3b6517b81020eade8dccc`，仅修改此前授权范围内的两个文件。完整回归、架构、构建、diff 检查通过。
- 同账号第二页面将结果命名为“Staging 双页验收 02”；第一页面在两次核对中仍为“Staging 薄荷验收 01”，双页同步未通过，不等同跨账号验收。
- 补丁 Preview `dpl_77K4hNNVfgq8fE4GbkjvZmSvEJmi`：`https://botanic-canvas-2xg3we2al-createpjfs-projects.vercel.app`。仍只更新前端，未追加图片调用，预算暂记 **1/6**。云端冲突恢复的原始复现路径、补图、取消及双会话完整验收均未完成。
- 补丁部署已 READY，健康响应 `ok / deepseek-v4-pro`。浏览器已打开新 Preview，但新域名需要重新登录 Botanic；尚未将补丁标记为浏览器验收通过。

### f6809ba 登录后浏览器复验

- 同版本两个页面在历史加载后均只显示一张结果卡、一组执行记录和一对“定位画布 / 继续修改”；本次已提交计划与评审回复的重复结果路径通过。
- 第一页面首次打开 Agent 时显示空历史，且“已保存”与离线草稿提示并存；重试同步后出现云端新版本提示，历史仍未恢复。关闭并重新打开 Agent 后历史恢复；第二页面正常加载。消息首次加载与失败重试仍不通过，不能将重开面板的临时恢复视为原路径修复。
- 代码核对：`useAgentSessionMessages` 会记录读取错误，但 execution bridge 未向面板输出该错误；loading 虽返回，当前 CanvasWorkspace 没有向面板传递。该展示缺口已确认，首次读取异常的底层原因尚未确认。
- 同版本第二页面将图片名称改为“Staging 同步复验 03”，第一页面仍为“Staging 双页验收 02”；通过 DOM input.value 核对，两页状态均显示“已保存”。双页面变更传播验收不通过，不代表跨账号权限测试结论。
- 本轮未追加图片请求，额度仍暂记 **1/6**。消息恢复和同步仍为发布阻塞；指定图编辑、补图、取消、真机验收与生产发布未完成。未更改生产、API/Worker 或持久化数据结构。

### 消息读取与漏收增量恢复补丁（本地，未部署）

- 消息读取失败现在向恢复调用者拒绝，不再吞错后报告成功；面板显示读取状态和可点击重试，失败或读取期间不显示“空会话”欢迎页。复用 latest-operation 令牌防止迟到旧请求清空新结果，焦点、可见性与网络恢复触发重新读取。
- 当前 epoch 2 的 HTTP 刷新保留 CRDT 图谱，不能补回漏收增量。页面重新聚焦/可见时，协作连接复用 state-vector 握手补齐；握手期间仍禁止 Outbox 发包，并复用原有超时/阻塞逻辑，不整图覆盖、不改变 epoch 或幂等语义。
- 新增两条执行真实模块的隔离回归：失败读取→同面板重试→迟到旧响应，以及漏收改名→重新握手→名称恢复。旧代码两条失败，补丁两条通过；第二条还核对重复刷新不并发握手、握手前发送门禁。该测试使用模拟网络边界，不代表已证明 Staging 最初漏收的传输层原因。
- 全量检查：1995 条服务端/脚本 + 847 条客户端通过，0 失败、2 条原有可选项跳过；架构、构建和 diff 检查通过。保留原有大包与 Node 实验性提示。日志为 `/private/tmp/botanic-recovery-path-tests.log` 和 `/private/tmp/botanic-recovery-path-build.log`。
- 本次涉及六个实现文件和一个测试文件，尚未提交或部署；线上仍为 f6809ba。须在新 Staging 版本验证原项目首次加载、读取失败重试与实际双页变更传播，不能据本地回归解除发布阻塞。未调用图片 Provider、未触碰用户 `.gitignore` / `AGENTS.md` 改动。

### 1d848d0 授权提交与 Staging 发布

- 用户明确授权七个文件提交、Staging 部署及原双页复验。提交 `1d848d09d411b06b57c33fb984a248c94e2f076f`，当前分支不变；未推送 Git、未合并 main，用户规则与本记录不在提交内。
- 从该提交归档到 `/private/tmp/botanic-sync-release.eIHQTc`，仅快照改写 Staging API。部署 `dpl_7h7vkoZkoemrCaAZjjELQ8pWP1Ze`，Preview `https://botanic-canvas-2l4yyt5ov-createpjfs-projects.vercel.app`；构建中已核对有效 API route 指向 `api-staging-35d7.up.railway.app`。
- API/Worker、数据库和生产未修改，未追加图片调用。READY、健康检查和登录后原双页复验待核实，不提前标记通过。
- 新 Preview 已 READY；从已关联项目上下文读取健康接口为 `ok / deepseek-v4-pro`，与 Staging 一致。原来的两个验收标签页已切换至新 Preview 的同一项目；新域名没有 Botanic 登录态，主页面已打开登录入口。未读取或迁移旧会话令牌，双页复验等待用户登录，尚未通过。

### 1d848d0 登录后真实双页与读取失败重试

- 主页面首次打开 Agent 恢复原文本、生成历史及一张结果卡；原第二验收标签页已关闭，因此新建同版本第二页，使用同源已有登录态打开同一隔离项目，也恢复历史。未提取或复制凭据，未触碰 localhost 标签页。
- 主页面改名为“Staging 正向同步 04”，第二页 DOM 的 input.value 与删除按钮标签均同步更新；第二页再改为“Staging 反向同步 05”，主页面也同步更新。两页最终均“已保存”，各一张结果卡。正反向改名传播本轮通过。
- 主页面以新的 verification 查询参数重新载入，仍显示“Staging 反向同步 05”。打开 Agent 后先显示“正在读取消息…”，随后真实进入“消息读取失败 · 重试”；点击原面板重试后，历史和唯一结果卡恢复，错误消失。没有关闭面板或重发 Agent 请求，真实失败后的原地恢复路径通过。
- 过程中短暂出现过“云端已有新的画布编辑，本地草稿已保留”提示，最终消失；两页读取 Console error 均为空。尚未定位此次消息读取失败的底层网络/接口原因，不能宣称首次读取稳定性或所有同步冲突都已解决。
- 仅修改隔离项目的图片名称，未追加图片调用，额度仍暂记 1/6；补图、取消、指定图编辑、跨账号权限/真机与生产放行不在本轮已通过范围。

### 后续指定图编辑验收（阻断，未确认图片生成）

- 只读核对该项目唯一 GenerationJob 为 succeeded，`providerAttempts` 长度为 1，图片调用额度确认 1/6。当前同步从“正在同步”收敛到“已保存”后才继续操作。
- 点击对话结果“继续修改”后，输入区出现两次“基于「Staging 反向同步 05」继续修改：”前缀；随后主动替换为明确的单张编辑指令：仅将绿色花盆改哑光蓝色，保持薄荷、构图、白色背景和光线，保留原图，先计划后确认，不自动重试。
- 首次 Turn `turn_0058f79a4287c954fbf143f31bfcd6eb` 失败，服务端错误码 `PROVIDER_TIMEOUT`，UI 显示“Agent 模型响应超时，请重试”。只测试了一次“恢复本轮”；新 Turn `turn_ae310a840b5bb69fad542e13fbb0da2d` 最终 completed，但对话追加了相同用户指令，不能描述为沿用相同 Turn ID。
- 恢复后的计划把单张颜色修改变成 4 张场景变体，标签为“Staging指 / 薄荷 / 构图 / 白色”，保持项显示人物、服装、商品等，按钮为“生成 4 张”。这与明确指令冲突，未点击生成。源码中该“场景替换为…保持人物、服装与商品不变”模板存在于两侧 agentVariations，但本轮未修改解析逻辑，也未宣称已定位完整根因。
- 末次只读复核仍只有原来的一个成功图片 Job、一次 Provider attempt，没有新付费出图。最近另一条 Turn `turn_47930b6fbbbfe6d609030497dbb7c2d3` 为 failed / INVALID_PROVIDER_RESPONSE，其触发关联尚未查明。
- Staging 消息接口 HTTP 日志筛选未返回记录，不代表接口无故障。指定图编辑验收失败；补图、生成中取消、真机和生产发布继续未放行，保留错误计划现场，不通过修改数据库制造验收条件。

### 单图误判为变体的本地修复

- 使用原始改色指令调用服务端 `resolveBotanicAgentVariationRequest`，精确复现“Staging指 / 薄荷 / 构图 / 白色”四个场景分支。根因是 `instructionRequestsBatchVariation` 的 `\d+ 张` 把 1 张也识别为批量，进而允许长指令枚举挖掘。
- 前后端各修改一条数量正则，只让至少 2 张触发此批量条件。共用镜像夹具加入原始单张改色请求及 0/1/2/10 张边界；旧代码夹具失败，修复后前后端相关 138 条测试通过。
- 全量回归 2842 条通过，0 失败、2 条原有跳过；架构、构建、diff 检查通过，保留原有大包提示。日志 `/private/tmp/botanic-single-edit-tests.log`、`/private/tmp/botanic-single-edit-build.log`。仅本地修改，未提交/部署、未调用图片 Provider，不标记 Staging 编辑通过；重复前缀、恢复消息与 Provider 超时未纳入本次修复。

### ffe6fbb 三端 Staging 部署

- 授权后仅提交三个修复文件：`ffe6fbbfa12bf9edcd2348e9ac754d8f38c04fda`，分支不变、未推送 Git 或合并 main；用户 `.gitignore` / `AGENTS.md` 与验收文档未并入提交。
- 部署前只读确认 Staging 在途 Job、Run、Turn 均为 0。API `82c313f5-978e-4588-8898-f90c425864a1`、Worker `004f0787-82e1-4b22-9686-23b0c6df778f` 均 SUCCESS；由相同提交归档 `/private/tmp/botanic-single-release.NvDagG` 显式部署。
- 两个运行容器的修复文件 SHA256 均为 `380024ca2e1086525024f2ac435d7b4d512e8089ccd3bdd1398c11a91f318afa`，与本地一致；容器内纯解析检查：1 张不是批量、2 张是批量，原改色指令返回 none。不调用模型、图片或写数据库。
- 前端 `dpl_Aempi1sZzrvXrXT2jmLS7k1ccZXF` 已 READY，Preview `https://botanic-canvas-ptv733bfo-createpjfs-projects.vercel.app`；实际 API route 指向 Staging，健康响应 `ok / deepseek-v4-pro`。仅前端快照改写路由，生产配置不变。
- 主验收页已打开新 Preview 登录入口，另页保留旧错误计划现场；新域名需要用户登录，尚未验证新版 UI 计划或真实编辑。未追加图片调用，额度仍 1/6；生产与数据库未修改。

### ffe6fbb 登录后真实单图编辑验收

- 使用原始单张改色指令重新走“继续修改 → 计划 → 确认生成”。新计划正确显示 1 张、GPT Image 2、1:1、2K，实际提示词为哑光蓝盆并保留薄荷、构图、白背景与光线；未执行历史遗留的“生成 4 张”计划。
- 新 Job `job_9j5-V845YGQPrE-TWcE0RiDmgkntE1oBsgNBK44YwoI` 为 succeeded，关联 Run `agent_run_bUukG5UHVP_BwdpcyNdBIA3RqNCVO5W2G8z4WUhahqk`；Provider attempt 为 1，UI 显示“已出图 · 哑光蓝盆 / 57秒”。真实截图确认蓝色花盆、薄荷和白背景，点击“定位画布”可定位新图。
- 原节点“Staging 反向同步 05”与新节点“精修候选 1”均保留。刷新后两节点仍在，新结果可见；消息历史再次读取失败，点击原面板“重试”后恢复两组结果，各一张且图片加载成功，最终“已保存”。读取的 Console error 为空，但不代表消息接口无故障。
- 刷新后只读复核数据库仍只有两个 succeeded Job，各一次 Provider attempt；累计图片额度 2/6，没有刷新重复生图。本轮证明单张计划、真实编辑、结果展示与重试后恢复，不代表首次历史读取稳定性通过，也未单独审查完整 Artifact 血缘字段。
- 补图、生成中取消、真机与生产放行仍未完成；重复输入前缀、历史错误计划仍可执行及首次消息读取失败未在本次修复范围内处理。未追加代码改动或生产部署；本记录保留为未提交验收证据。
