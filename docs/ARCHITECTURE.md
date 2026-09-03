# Botanic 模块接口与依赖方向

这份说明记录当前代码中的稳定 seam。目标不是把工程拆成更多目录，而是让复杂行为集中在少量深模块中，使 UI 改动不会直接改变生图、队列或存储语义。

## 模块与允许依赖

```text
UI（App / features / components）
        ↓
画布应用模块（store）
        ↓
领域契约（domain） ← 网络与本地持久化接口（lib）
                               ↓
                         同源 Node API
                               ↓
         任务队列 → 生成处理器 → Provider / Media / ProductStore Adapter
```

| 模块 | 主要位置 | 对外接口 | 允许依赖 |
| --- | --- | --- | --- |
| 应用壳 | `src/App.tsx` | 登录恢复与功能入口按需加载 | 会话 `lib` 与功能模块 |
| 功能 UI | `src/features/` | 功能级交互与异步协调；Agent 内部分离消息卡、Composer、消息交付、运行轨迹和工具面板 | Store、领域契约和 `lib` 高层接口 |
| 共享 UI | `src/components/` | 渲染属性与用户事件 | 领域类型与共享 UI，不直接依赖 Store 或网络 |
| 画布应用模块 | `src/store/` | `canvasStore.types.ts` 契约；文档生命周期、素材/图谱、普通生成、批量变体、模板/历史与 Agent 实体命令分别由对应深模块拥有，`canvasStore.ts` 只组合命令和撤销/交付边界 | `domain`、`lib`、种子数据 |
| 领域契约 | `src/domain/` | 画布数据、生成结果放置等纯规则 | 类型依赖与纯计算，不依赖 UI、Store、网络或存储 |
| 浏览器基础设施 | `src/lib/` | 会话、生成请求、项目文档与离线草稿接口 | `domain`、浏览器/网络 Adapter，不依赖 UI 或 Store |
| Node API | `server/index.mjs` | 鉴权后的 HTTP 与 WebSocket 接口；每类资源由独立 Route 模块拥有方法目录和 405 语义 | 队列、处理器、运行时组合根 |
| 授权 | `server/authorization.mjs`、`server/projectAuthorization.mjs` | 工作区/项目权限决策与 403/404 语义 | ProductStore 的用户与项目成员关系，不依赖 UI |
| 生成处理器 | `server/generation/generationProcessor.mjs` | `processGenerationJob(jobId)` | 注入的 ProductStore、Media 与 Provider |
| Agent Run 生成服务 | `server/agent/run/agentRunGenerationService.mjs` | 为已确认 Run 准备工作流、复用幂等任务、入队并回写项目 | ProductStore、生成队列、安全配额与实时事件 |
| Agent Run 提交恢复 | `server/agent/run/agentRunSubmissionSweep.mjs` | 稳定分页找出已落库但尚无首个 Job 的 queued Run，并委托既有提交或深取消服务收口 | ProductStore 只读恢复查询、Agent Run 生成服务、Agent 深取消服务；由 Worker 的 `run.submit` 周期任务驱动 |
| Adapter | `server/*Store.mjs`、`server/objectStore.mjs` 等 | 产品存储、媒体、队列、第三方图像能力 | 各自外部系统；由 `server/runtime.mjs` 选择并组装 |

模型能力由 `server/generation/generationModels.mjs` 统一声明，Worker 只能经
`server/generation/generationService.mjs` 路由到 OpenAI、MiniMax Image、MiniMax H3 或 Flock 生图。
所有供应商输出都先转成 `{ mediaKind, mimeType, buffer }`，再由媒体服务持久化；
H3 的 MP4 与历史图片共用授权 URL，但历史缺少 `mediaKind` 时始终按图片兼容读取。

`src/components/` 是纯 UI 模块，不得直接导入 `src/lib/`、`src/store/` 或 `server/`。`src/features/` 拥有功能内的交互协调，可以使用 Store 与高层浏览器接口；`src/App.tsx` 仅保留登录恢复、跨功能组合和按需加载。只允许最后一次异步结果落地的流程统一使用 `src/domain/latestOperation.ts` 的令牌接口。

生成配方和批量变体的纯规则分别位于 `src/domain/generationRecipe.ts` 与 `src/domain/batchVariations.ts`。前者以生成节点入线与输入顺序构建配方，后者在提交前限制总输出并提供有界并发；Store 只负责把这些规则与持久化、网络任务组合起来。

`canvasDocumentMigration.ts` 与 `canvasDocumentAssets.ts` 分别拥有版本迁移、引用清理及模板快照，不发起 I/O；`canvasGenerationProjection.ts` 只把任务与批量分支投影为画布文档；`canvasGenerationActions.ts` 自持普通生成的幂等提交、轮询、取消与恢复；`canvasDocumentLifecycleActions.ts` 统一项目打开、远端刷新、新建与重命名；`canvasAssetGraphActions.ts` 统一画布图谱、参考素材、素材组和可编辑节点命令；模板/历史、Agent、批量变体分别由对应 Actions 模块拥有。本地持久化模式不发起服务端生成结果对账。

`src/features/canvas/workspaceProjectCoordinator.ts` 统一拥有项目摘要读取、过期请求失效、模板建项、重命名与乐观删除；`useCanvasWorkspaceSynchronization.ts` 统一拥有本地草稿同步、页面恢复、Realtime/Yjs 协作和 Agent Run 追踪；`useCanvasAgentExecutionBridge.ts` 统一 Agent 上下文、Run、Artifact 与画布写回；`useCanvasInteractionCoordinator.ts` 统一 React Flow 变更、视口、连线、边操作和文件拖放；`canvasGenerationInteraction.ts` 统一 4K 分支配方、提交竞态与结果导航。`CanvasWorkspace.tsx` 只组合导航、面板与上述协调器。

## 受保护的稳定接口

以下行为必须通过接口兼容和测试保护，不能由 UI 改动顺带改变：

- 同一次提交在网络重试、超时确认与恢复时复用同一幂等键，服务端按用户与幂等键去重；用户明确发起“重新生成”属于新的计费尝试，使用新的提交键。
- 任务状态由持久化任务记录决定；UI 占位状态不是权威来源。
- 一次任务的每个输出都有任务内唯一身份，并成为独立结果节点。
- 已有 `candidateId` 但尚无图片的节点必须原位补图，不能被误判为已展示。
- 远端成功输出可以纠正本地空节点或旧失败状态。
- 本地草稿不能覆盖更新的远端任务结果；合并任务结果时保留当前画布布局。
- 媒体通过稳定的同源引用进入画布，组件不接触对象存储凭据。
- WebSocket 推送 `{ projectId, revision, graphRevision, updatedAt }` 失效通知，并转发节点/连线的 Yjs 增量；浏览器仍通过项目文档接口读取项目元数据与兼容视图。
- WebSocket 使用独立 `REALTIME_TICKET_SECRET` 签发短期、项目级且绑定浏览器 Origin 的票据；不得回退复用 Supabase、访问码或媒体凭据。
- 所有项目 ID 入口先经 `requireProjectPermission`：对已存在但越权的对象返回 403，对真实缺失对象返回 404；Adapter 仍保留第二层权限校验。
- 工作区敏感审计只能经 `listWorkspaceAuditEvents` 读取，项目审计必须同时指定项目并具备 Owner 权限；审计上报失败不回滚已成功的账户安全操作。
- Yjs 不同步图片/视频字节、本机选择态或视角，也不决定生成任务、历史版本与同 Prompt 的产品冲突。
- Agent Session、Message、Memory 与 Run 以项目级独立实体为权威；旧 `CanvasDocument` 字段只作为迁移兼容视图。Message 按 ID 追加，Memory 删除使用墓碑，旧文档快照不得覆盖新消息或复活已删除记忆。
- Artifact Index 按项目保存 Agent 行动与生成输出的历史身份和血缘；删除画布节点、会话兼容字段或素材库引用不得删除索引中的历史 Artifact。

## 实时同步

`src/lib/projectCollaboration.ts` 是协作图谱的单一入口，组合 `src/lib/projectRealtime.ts` 的连接重试
与 `src/domain/collaborativeGraph.ts` 的 Yjs 增量。CRDT 只拥有节点、连线的即时协作；视角与选择态归本机 UI，
媒体与任务结果归原有持久化模块。`server/realtimeHub.mjs` 只允许 owner/editor 发布增量，先经
`server/canvas/canvasCollaborationRoom.mjs` 持久化成功，再按项目转发。项目元数据使用 `revision`，独立画布图谱使用
`graphRevision`；HTTP 写入只有在图谱确实变化时才校验后者，避免重命名等元数据操作误伤实时协作。
写入成功后才发布 `project.updated`。本地存在未同步草稿时，
`src/lib/db.ts` 会拒绝远端整份覆盖，网络恢复或页面重新聚焦仍作为 WebSocket 之外的降级路径。

`canvas_graphs` 保存可直接读取的节点/连线物化视图与压缩快照，`canvas_graph_updates` 按顺序保存 Yjs 增量。
API 重启后用快照与增量重建房间；累计 64 条后压缩，避免日志无限增长。旧项目首次读取或服务启动时会从
`projects.document.nodes/edges` 自动建立图谱，读取接口再把独立图谱覆盖进兼容项目文档，因此历史项目和旧客户端
不需要一次性迁移。生成任务、媒体输出与历史回填仍以 ProductStore/Worker 的持久化结果为权威，Yjs 不参与
任务状态判断，也不能用缺少媒体字段的临时节点覆盖已有图片或视频。

房间重建时，epoch 1 继续用物化图谱纠正 Yjs 日志；epoch 2 以 snapshot + 增量日志重建图谱，并修复过期物化投影。
最后一个客户端离开后，房间默认空闲 60 秒即释放。
初始化失败的房间 Promise 不缓存，使短暂数据库故障恢复后可以重新连接。

画布房间经 `server/canvas/canvasRealtimeEventBus.mjs` 使用 Redis Pub/Sub 跨 API 实例传播已持久化的 Yjs 增量与 Presence
快照。来源实例先持久化再广播，远端实例只更新内存房间并转发给本机连接，不重复落库；实例 ID、事件 ID 与更新摘要
共同阻止广播回环和重复应用，Yjs 负责乱序依赖补偿。Presence 只传播成员与连接数，按 TTL 清除失联实例；图片/视频
字节、本机选择态和视角不进入事件总线。API 重启或切换实例后仍从 ProductStore 的物化图谱、快照和增量日志恢复。
独立 Agent Run 与协作动态继续经 `server/agentRunEventBus.mjs` 跨实例传播；UI 不感知实例拓扑，断线后仍以 ProductStore
的独立 Agent 实体、协作历史与成员回执恢复。

## Agent 实体持久化

`server/agent/semantic/botanicAgentPersistence.mjs` 定义 Session、Message、Memory 的安全实体形状，以及新实体和旧文档字段的兼容合并规则。ProductStore 的本地文件、PostgreSQL 和 Supabase Adapter 共同实现：

- `agent_sessions` 保存会话设置及服务端从权威 Message 派生的 `threadSummary`；客户端设置接口不能写摘要，也不能用整份 Session 覆盖删除它。摘要写回只走 `compareAndSetAgentThreadSummary`，在行锁内校验旧摘要版本并只 patch `payload.threadSummary`，不改 Session 排序时间或覆盖并发设置；
- `agent_messages` 按消息 ID 和 Session ID 独立追加或更新；`turnRequestSnapshot`、`turnId`、Stop 时间和稳定 Turn 结果的 `entityReferences` 是 sticky 字段：省略不清空、首次可补齐，同一 Turn 的不同引用明确冲突。`CanvasDocument` 迁移兼容写入口会在同步独立实体前剥离 Message 的 `entityReferences`，只有权威 Message 写路径可首次绑定这些引用；
- Agent Turn 新请求只携带 `sessionId + inputMessage`；`server/agentThreadContext.mjs` 从独立 Session/Message 重建最近窗口，相同 Message ID 以服务端内容为准。摘要属于历史用户上下文，只以 `user` 角色注入模型，不提升为系统指令；首次摘要会按稳定游标向旧消息回填，最多覆盖实体上限 500 条，翻页失败时可继续本轮但不写入不完整 Checkpoint。摘要的 `factCandidates` 保存逐 Message revision 来源，修订或撤回会移除旧事实；没有该来源的 legacy 摘要只有拿到完整有界历史后才能重建；
- `agent_memory_items` 保存项目记忆，并用 `deleted_at` 阻止旧快照复活删除项；
- `agent_runs` 继续保存确认计划后的执行状态和分支进度；
- 项目文档写入期间双写独立实体，项目读取时由独立实体覆盖兼容字段；
- 独立实体写入不增加画布 `revision`，因此两台设备追加不同消息不会因整份文档冲突而互相覆盖。
- Session、Message、Memory 与 Run 的真实变更写入可分页的协作历史，并发布项目级失效事件；浏览器收到事件后重新读取独立实体，而不是相信本地兼容快照。
- 协作历史用 `(occurredAt, id)` 稳定游标分页；成员的已读与清空回执只向前推进，失败时保留原 UI 状态并允许重试。
- Session、Message、Memory 与 Run 的实体 ID 全局唯一，`project_id` 是授权与归属边界；跨项目 ID 冲突必须明确失败，不能在历史回填中静默丢失。

迁移阶段不删除 `CanvasDocument.agentSessions / agentMemory / agentRuns`。Supabase 迁移完成、历史数据 Backfill 和双设备门禁通过后，才能停止旧字段写入。

## Bob Agent Core（Agent Harness 控制面）

Bob Agent Core 是对现有 Agent 控制面（`agentToolRuntime.mjs` + `botanicAgentTurnRuntime.mjs` +
`agentTurnCheckpoint.mjs` 及其 Skill/取消/恢复 seam）在 2026-09-01 可靠性升级后的命名。它不是第二套
Runtime 或新目录，而是一组已实现、可验证的控制面不变量，对应 OpenAI Codex core
（`rust-v0.152.0@316795b3` / 研究快照 `633ab199`）的公开工程不变量：

| 不变量 | Codex core 对应 | Bob Agent Core 实现 |
| --- | --- | --- |
| Immutable step snapshot | 同一步模型可见 context/tools 与实际 dispatch 共用冻结快照 | `freezeAgentStepSnapshot`；Skill catalog 随 durable request 冻结（`skillCatalogSnapshot`），恢复按 binding pin 版本 |
| 严格 Skill binding | metadata catalog → selection → dependency → body 渐进加载 | 挂载 fail-closed（`AGENT_SKILL_*`）、依赖 closure 拓扑注入、聚合预算、`AGENT_SKILL_SNAPSHOT_MISMATCH` |
| Call/result pairing | history 中每个 call 恰好一个 output，缺失合成 aborted | 整批 preflight 逐 call 配对（`BATCH_PREFLIGHT_ABORTED`）、执行期 fatal 收口未启动 call（`BATCH_NOT_STARTED`） |
| Cancellation scope | cancel token 贯穿 task/provider/tool | 根 signal + deadlineAt 冻结进 `runAgentToolLoop`,在模型调用/preflight/每个 execute/终态前检查;web 与子任务组合而非覆盖 |
| Deadline 层次 | per-call timeout 与 turn 生命周期分离 | Provider call timeout（每 sampling 重建）、Turn 顶层 `deadlineAt`（600s 默认）、lease 独立 |
| Bounded repair/loop | RespondToModel 错误回给模型;正常终止由预算控制 | 错误三分法（repairable/terminal-known/outcome-unknown）、同签名一次 repair、volatile 字段忽略 + A→B→A→B 环窗、action budget 不变 |
| Final synthesis | budget 耗尽后仍给出最终回答 | 一次 `tools: [] / tool_choice: none` 综合;terminal checkpoint cursor 允许 =MAX_STEPS |
| External-read lifecycle recovery | rollout append/terminal flush 与 reconstruction 分离 | Checkpoint V2 journal call：prepared/dispatched/completed/failed/unknown 逐 call durable;completed 复用同一 envelope,dispatched 无结果禁止重放 |
| Observability | 事件驱动指标 | `botanic.agent.harness.lifecycle` 语义事件 + `agentOperationalMetrics` harness 族（零容忍计数、null≠0%） |

有意不复制 Codex 的部分：无 hard loop cap 的做法、特定条件下的无界重连、固定 100ms cancel grace、把
compaction 当可靠性边界、平台 sandbox/Guardian。Botanic 的 durable Turn/lease/Receipt/深取消语义保持权威。

### 外层平台收口(2026-09-01 第二阶段)

对照完整 Codex workspace(145 crate)后补齐的四个外层,均沿既有 seam,不新建 Runtime:

| 层 | 模块 | 对应 Codex | 语义 |
| --- | --- | --- | --- |
| Model Provider | `botanicAgentModelProvider.mjs` | `model-provider` | 唯一 Agent 采样传输 seam:`sample()` 隐藏 URL/鉴权/trace header/非流总 timeout + 流 idle watchdog/SSE 严格 `[DONE]`/错误分类/overflow 识别；输出安全 chunk identity 与 content-free TTFT/stream health 指标；不做 transport retry(H3C Gate)；architectureBoundaries 禁止 10 个 caller 再持有 `/chat/completions` |
| Protocol v1 | `agentProtocol.mjs` + `scripts/generateAgentProtocol.mjs` | `app-server-protocol` | 公共 Turn 状态/SSE 事件/ToolCall 状态/错误码单一 catalog;生成前端类型与 JSON Schema,build 前 `--check` 防漂移;缺版本按 v1 兼容,显式未知版本 fail closed |
| Metrics/Diagnostics | `agentTelemetryMetrics.mjs` + `agentRuntimeDiagnostics.mjs` | `otel`/`diagnostics` | 语义事件旁路成低基数 OTel 指标(标识一律丢弃),content-free gauges(active turns/pending cancel acks/内存);exporter 故障 fail-open |
| Connector Gate | ADR 0011(未采纳) | `connectors`/`secrets` | 只冻结未来 seam 与四个进入门槛;Gate 前继续 operator MCP env 配置 |

同阶段收口的 Core 事实:web 工具 journal 语义贯穿根 Turn/Subagent(不再按入口分叉为 never);
`cancel_observed`/`duplicate_dispatch` 有生产 emit;Turn/Chat/Planner 透传 `AGENT_TOOL_*` 具名错误。

### Agent 对话界面控制面(Codex UI 对照升级)

- `useAgentComposerState` 按 project/session 隔离完整 transient state;sessionStorage 只保存展开后的文本+caret,切tab失效,pagehide在debounce前flush。Context/Skill/错误/恢复快照不进浏览器草稿。
- `agentComposerQueue` + `useAgentInstructionQueue` 拥有最多3条 queue-after-turn:FIFO只在Turn completed发送,failed/idle空输入弹回,waiting confirmation保持;入队不提前创建Message,并冻结model/mode/context/Skill/target/group/生成覆盖。
- `AgentComposer` 的 `/` 同时提供本地导航命令与Skill,`@`引用画布;popup支持dismissed token、fuzzy、disabled-skip键盘语义;空输入Up/Down从当前Session用户消息召回且不劫持多行编辑。
- 大粘贴只在展示层折为placeholder,发送/入队/session草稿前恢复原文;浏览器不实现Terminal PasteBurst。
- Timeline用稳定toolCall ID更新;快速本地read采用300ms reveal/600ms linger并折成可展开摘要;Subagent进度复用同一tool事件durable投影;截断轨迹只经GET+nextAfter继续加载,不进入observer执行路径。
- Transcript始终是安全presentation/状态/耗时/错误/source/Receipt引用;raw args/result/reasoning/Provider body不进入UI协议。

## Agent Turn Runtime 与恢复

`server/agent/turn/botanicAgentTurnRuntime.mjs` 是回合控制权的唯一入口。Turn 先以 `queued` 持久化，再由 ProductStore 原子
`claimAgentTurnExecution` 取得 lease 与 fencing token；heartbeat、Checkpoint、事件和终态都只能由当前 token 通过
`commitAgentTurnExecution` 提交。旧实例租约过期后即使继续返回，也不能覆盖新实例的 Checkpoint 或终态。本地、PostgreSQL、
Supabase 三个 Adapter 实现同一契约，数据库 Adapter 使用数据库时钟和事务锁裁决多实例竞争。

`server/agentRuntimeRequest.mjs` 是 Runtime operation 的单一 dispatcher。主 `/api/agent-turns` 与兼容期的
`/api/agent-plans|chat|intent` 都先建立同一种 durable Turn；旧 URL 只还原原响应形状，不再拥有 Provider 调用或
AbortController。显式提交键按 operation 隔离；无键旧请求按 transport requestId 保持“一次 POST 一次请求”。Planner/Chat
同样冻结模型、工具、Skill/Memory 快照并写步骤 Checkpoint，Worker 按存储的 operation 恢复；恢复时运维只读工具复用
`agentOperationalReaders.mjs`，联网工具必须重新消费共享配额，缺少配额服务时 fail closed。

`server/agent/turn/agentTurnCheckpoint.mjs` 在模型返回工具调用、任何副作用发生前持久化 prepared 步骤，完成后再推进步骤游标。
Checkpoint 只保存固定模型/工具快照和安全恢复意图：只读调用保存可重放参数；写入、计费和外部调用只保存 Receipt 引用；
不保存工具输出、媒体字节、Provider 原始回包或完整推理。`turnReclaim.mjs` 先读 Checkpoint 再决定继续、等待回执或明确失败，
不会从头重跑整轮。

浏览器先把带完整 `turnRequestSnapshot` 的 pending 用户 Message 写入独立实体；`POST /api/agent-turns` 再用其稳定 Message ID
派生幂等键。服务端重建权威线程上下文，原子 claim 并持久化不可变 request binding，再把权威 Message 关联到 `turnId`，最后才发
SSE `accepted` 或返回普通 HTTP `202 + runtimeTurn + observer`。旧 Turn 即使
ID 相同，只要 request binding 不同就明确冲突；Message 已绑定但 Turn 不存在时也 fail closed，不用当前 UI 上下文
重建意图。后续持久事件以 `sequence` 作为 `id`。HTTP 断开只 detach 观察者，不 abort Runtime；浏览器刷新后从
Message 的 `turnId` 重挂 GET observer，以 `after` 游标与单调去重补齐丢帧，排空事件页后才按 Turn 终态用稳定结果
Message ID 投影。accepted 前断网时，持久化的 pending Message 只用同一稳定键退避重提。原始 reasoning 与逐token answer delta仍只属于当次实时连接；ADR 0012仅允许当前lease持有者把用户可见answer合并为有界replace-style `TurnOutputPreview`。Preview正文只存在于active Turn payload，Event仅存revision/charCount元数据，所有终态原子清除。

Provider SSE 只有 `[DONE]` 才正常结束；坏 JSON、未闭合 tail 或提前 EOF 以 `PROVIDER_STREAM_MALFORMED/CLOSED` 具名失败。非流采样使用总 timeout，流采样按每个网络 chunk/心跳重置 idle watchdog，总预算仍由 Turn deadline 拥有。每个 vision/text/chat/plan attempt 先发 `attempt-start`，answer/reasoning 带 attemptId + chunkIndex；客户端 domain PartialAccumulator 在新 attempt 清除废弃临时前缀，并拒绝重复或旧 attempt 迟到 chunk。Tool 状态仍只来自 execute 前后事件；attempt/chunk cursor 是 live-only。`answer_snapshot`只用于replace恢复当前TurnOutputPreview，不是Message或完成答案；reasoning、tool args与Provider body继续绝对禁止持久化。每个Turn终态只发一条content-free preview summary(writeCount/maxCharCount/nonEmptyCount)，浏览器observer以两条固定Sentry事件计算恢复命中率；ADR 0013在生产样本达到门槛前禁止新增interrupted Message。

兼容 Plan/Chat 客户端收到 SSE `accepted` 后也切换到同一 GET observer；流断开不会再发起第二次模型调用。非流客户端可用
`Prefer: respond-async` 获得 `202 + runtimeTurn + observer`。Planner 子 Turn 的稳定键由来源根 Turn 派生，刷新后重新进入生成
continuation 时只观察同一计划；Stop 在身份返回前保留取消意图，返回后走 durable cancel。

`server/agent/context/agentContextBudget.mjs` 和 `agentThreadContext.mjs` 共同把 Summary 与最近 Message 限在 8k token；Summary 最多 2k，最近窗口
最多 16 条，当前输入本身超过总预算返回 413，不通过丢弃当前输入来“成功”。`agentToolRuntime.mjs` 把单个工具结果限在 2k、单轮
累计限在 6k，超限时保留有效 JSON envelope 和截断原因。只有 Provider 明确返回 context overflow 时，`botanicAgentTurn.mjs` 才在
同一 model step、任何工具调用尚未发生前做一次严格裁剪重试；system 与当前用户输入不变，历史 assistant tool-call 与 tool message
按原子组保留。

`server/agentEntityReferences.mjs` 只从明确的「工具名 + 固定结果路径」提取受支持的业务引用，禁止递归扫描任意 `*Id`；单工具最多
8 条、单 Turn 最多 24 条。引用先进入受 fence 保护的 Checkpoint/Turn，再只投影到 `agent-turn-result-<turnId>` 助手 Message；Summary
只消费这种稳定投影。原始工具输出、URL、Prompt、媒体元数据和未知 MCP JSON 都不能借引用链进入 Message 或 Summary。

显式 Stop 由浏览器先把 `turnCancellationRequestedAt` 写入独立 Message；该字段与 `turnId` 都是独立于正文 LWW 的
sticky 事实，迟到旧快照只能补绑 Turn 或取更早的取消时间，不得回退正文与状态。已获得 Turn ID 时调用 cancel API 并
继续观察 `cancelling → cancelled`；身份尚未返回时保留意图，并在同 key 恢复拿到 Turn 后重试深取消，不把 404/断网伪造为
`cancelled`。只有不属于 durable Turn 的旧规划/对话请求才中断本地 HTTP。
`server/agentCancellationService.mjs` 先写 `cancelling` durable fence，再通过跨实例取消通道中止实际执行者，
并按 `Turn → linked Run → active GenerationJob` 传播。Run 创建及首个 Job 提交前后都检查 delegation fence；取消竞态中已经
落库的下游实体会补偿取消。运行中 Job 的 Redis publish 或本地 `abort()` 只代表发出请求；实际 Worker 必须在 Provider、heartbeat
和本地 registry 都退出后，以不可变 `signalId + executionGeneration` 写 durable release ack。Worker 崩溃时只能由数据库时钟确认
原 generation 的 lease 已过期后替代确认。Ack 未完成时 Turn 保持 `cancelling`；全部传播完成后，
`finalizeAgentTurnCancellation` 才把新事件、`lastSequence` 与 `cancelled` 终态原子提交。

Run 落库到首个 Generation Job 落库之间另有独立崩溃窗口。Worker 的 `run.submit` 周期任务通过
`server/agent/run/agentRunSubmissionSweep.mjs` 按 Run ID 稳定分页，只选择仍缺少 Job 的 queued 分支；正常路径复用
`agentRunGeneration.submitGeneration` 的幂等、配额与 delegation fence，来源 Turn 已取消时则复用
`agentCancellation.cancelAgentRun`，不在清扫器内另写一套 Job 创建或取消逻辑。
浏览器 auto 模式也先持久化 pending Plan Message，再用 `Message ID + Plan 指纹` 派生的稳定 submission key 创建 Run；
响应丢失时保留 pending 并退避重提同一身份，明确业务失败才写 failed。`status/runId` 每次转移都经同一 Message
离线队列落库，与后端 `run.submit` sweep 共同封闭 Plan → Run → Job 的两个崩溃窗口。

## Durable Subagent Runtime

主 Planner 的 `subagent_research` 经 `agentSubagentBroker.mjs` 进入独立持久化运行时，不再
直接在根进程内扇出 Provider 调用。Descriptor 冻结服务端模型、指令、只读工具、输出
Schema 与预算；每次 Activation 原子创建输入 Message 和独立 Durable Turn，并按 sequence
严格 FIFO。Planner Checkpoint 重放同一稳定 Subtask ID 时只观察原 Activation 与结果 Message。

running 根 Turn 派发必须携带 Runtime 注入的 `execution generation + leaseToken`，三个 Store
Adapter 都在锁住根 Turn 后验证该 fence；takeover 后旧执行者不能新增 Activation。Subagent
使用独立 BullMQ 队列、并发和恢复扫描；根 Turn 深取消再按 `rootTurnId` 反查并级联全部
Descriptor，任一子项状态不确定时根 Turn 保持 `cancelling`。普通 Session 列表默认隐藏子会话，
专用 HTTP 资源只返回安全提案与公共状态。完整决策见 ADR 0007。

`server/generation/generationRecoverySweep.mjs` 拥有 Generation Job 恢复扫描：三个 Adapter 按毫秒时间与 ID 提供稳定 keyset 页，清扫器限制
单轮页数、在尾部回绕、检测游标停滞，并逐 Job 隔离入队失败。Supabase 对 Turn、失败 Run 分支、待执行 ReviewTask 与可恢复
GenerationJob 四类恢复记录持久化 `recovery_updated_at_ms`，由全量写 trigger 从 `updated_at` 回填重算；对应 RPC 的过滤、排序与
`(recovery_updated_at_ms, id COLLATE "C")` partial index 使用同一复合行 cursor；首屏与续页拆成两条静态查询，避免 nullable `OR` 在 generic plan 下把深页 after 条件移出 Index Cond。各类任务复用拥有业务规则的 Service，不在 Worker 复制状态机。

## Agent 评审执行与原子重试

`server/agent/review/agentReviewService.mjs` 通过 ReviewTask execution generation、lease token 与 prepared checkpoint 执行评审；heartbeat、逐候选
Result 和终态都必须由当前 fence 条件提交。prepared 后租约失效而无法证明 Provider 是否已执行时收敛为 `outcome_unknown`，不静默
重跑视觉评审或 evaluator Skill。Provider 调用始终在数据库事务外，事务只提交已完成结果。

显式停止评审先持久化 `cancelling` 与 `signalId + executionGeneration`，再通过跨实例 cancel channel 中止匹配的 Worker；HTTP 返回、
Redis 发布成功都不是退出证明。当前 Worker 真正退出时用匹配 lease 写 `worker_exit`，Worker 崩溃时只能由数据库时钟确认旧租约过期；
两者之一成立后才收口 `cancelled`。未知 Provider 结果只允许人工选择 `continue_unverifiable` 或 `retry_once`：前者写入来源为
`human_resolution` 的 truthful `unverifiable` Result，后者明确记录重复调用/计费风险且整个任务最多一次。对账本身不调用 Provider，
`retry_once` 在 Route 与三个 Adapter 内都重新校验生成权限。

人工接受/拒绝由 `review_decide` 承载，只要求编辑权限；重新生成由独立 costly 工具 `review_retry` 承载，同时要求生成权限和用户确认。
`server/agent/review/agentReviewDecisionService.mjs` 与 `agentReviewRetryMaterialization.mjs` 让 Human Decision、每个结果上的
`retryMaterialization` 绑定和稳定 queued Agent Run 在 ProductStore 同一原子操作内提交。重复请求返回同一 Run；批量中任一冲突整体零写；
不同 Editor 重放不改 first-writer owner。事务提交后由 `run.submit` sweep 将 Run 物化为 Generation Job，因此决定事务内不调用 Provider。
历史数据若已有 `retry_requested` 却没有可证明的物化绑定，返回 `outcome_unknown`，不能猜测并补建一份可能重复计费的 Run。

## Artifact Index 与历史回填

`server/botanicArtifactIndex.mjs` 把 Agent Message/Action Receipt 中的工具产物，以及 Generation Job 中的图片或视频输出，规范为同一个项目级索引。Artifact ID 只在项目内唯一，数据库使用 `(project_id, id)` 复合身份，以兼容旧版 `legacy-writeback` 等跨项目重复 ID。

本地 ProductStore 在启动时扫描项目文档、独立消息、行动回执和生成任务；PostgreSQL 启动建表过程与 Supabase Migration 则使用幂等 `upsert` 回填历史记录。后续 Message、Action Receipt、Generation Job 和兼容项目文档写入都会增量维护索引。索引不反向拥有画布节点或素材库记录，因而历史记录不会随 UI 删除而消失。

## Agent 执行可观测性

`server/agentExecutionTrace.mjs` 使用 `agent-trace:<runId>` 作为稳定关联标识，把 Agent Run、Planner 模型、
工具调用、生成 Job 与 Artifact Index 组合为只读执行快照。它不改变 Session、Message、Run、Job 或 Artifact 的
既有身份和幂等键，也不返回 Prompt、媒体地址或 Provider 原始请求。浏览器通过 Agent API 读取简洁状态；技术阶段、
失败类型、耗时、重试与回填状态留在可展开 Runtime/执行链路中。

`server/agent/run/agentRunObservability.mjs` 为 API 与 Worker 日志写入同一 traceId；失败分支继续使用原有幂等重试入口，
已存在的 Job 在配额扣减前即被复用，因此重放不会重复创建任务或重复扣费。离线质量评测由
`server/agentEvalSuite.mjs` + `scripts/evalGate.mjs` 承担，只消费固定夹具，普通验证不得调用真实 Provider。

分布式执行使用另一套真实 W3C 身份：`agentTraceContext.mjs` 只提取/注入 `traceparent` 与受限
`tracestate`，并通过 Generation、Derived、Subagent 三类 BullMQ payload 跨实例传播；Worker 在进入业务
Handler 前剥离 carrier。`baggage` 首版不注册、不传播，外部 Provider/MCP 只允许 `traceparent`。
`executionTelemetry.mjs` 是 Span 的唯一入口；属性先经过固定 allowlist，错误只记录类型码，不记录异常正文。
OTLP exporter 故障必须 fail-open，不能改变 Turn、Tool、Queue 或 Provider 的状态。

Canvas Agent 的 query / proposal / approval / execution 生命周期复用同一安全 semantic event → OTel metrics 管线；只记录固定 kind/outcome/mode/completeness、规范化 reason 与有界计数/耗时，project/user/node ID、Prompt、URL 和原始错误均不进入 metrics 标签。查询与提案在 `agentOperationalReaders.mjs` 记录，审批在 `agentActionRoutes.mjs` 记录，原子执行与冲突在 `canvasAgentEditing.mjs` 记录；任何日志或 exporter 故障继续 fail-open。运维告警优先观察审批拒绝率、Action Set 冲突/失败率、查询截断率和执行延迟。

`agentSemanticEvent.mjs` 定义版本化安全 schema，Context rollout/shadow/compaction/overflow/usage anchor
与 Run lifecycle 只记录受控身份、计数、耗时、cohort 和错误码。Legacy `agent.run.*` 在迁移期双写，旧消费者
不变；运维指标由 `agentOperationalMetrics.mjs` 聚合，零样本继续为 `null`。OTel trace ID 与既有
`agent-trace:*` 不互换：前者描述一次分布式执行，后者仍是 Run/Job/Artifact 产品聚合视图。

## 项目权限与 Agent 行动审批

`server/canvas/canvasAgentQuery.mjs` 是 Agent 全图查询的安全投影 seam：每次由 `agentOperationalReaders.mjs` 经当前用户和项目权限重读 ProductStore，不接受客户端上传的全图作为权威。同一 `canvas_query` 提供 nodes、aggregate、keyword 三种模式：节点查询按稳定 ID cursor 分页，聚合按 type/status/stage 统计完整过滤集，关键词只对 ID、类型、短名称、Text/Prompt 有界正文、状态和 Stage 做规范化 AND 匹配并按 score→ID 稳定分页；边截断和 continuation 必须显式返回。输出只含有界文本、生成设置、语义关系、权威实体标识及节点邻接关系 hash，媒体 URL、字节、Generate Prompt 和 Provider payload 不进入投影或检索语料。`canvasAgentSemanticSearch.mjs` 是默认关闭的 OpenAI-compatible `/embeddings` Adapter：按 ID 内部分页收集最多 500 个安全候选，并按每批 50 个调用 embeddings；相同 Provider 模型与安全文本的向量由进程内有界 LRU 复用，节点安全文本变化会自然失效，避免每次查询重复嵌入未变化画布。semantic 用余弦分数、hybrid 叠加有界关键词分数并按 score→ID 稳定排序；向量不持久化、不成为 Canvas authority，禁用、配置缺失或 Provider/响应失败均显式降级 keyword，并保留当前节点分页 cursor 以避免重复首屏。`server/canvas/canvasAgentActionSet.mjs` 将创建文字/Generate、更新、参考连接和删除规范为领域操作；触达既有节点必须携带该 hash，故无关协作修改可继续、触达实体变化则要求重新确认。提案时服务端从当前权威画布重建 touched-entity hash、规范化 arguments，并在内存副本预演出冻结的结构化 Preview；连接未变化端点只进入安全 context 投影。`agentCanvasPreviewGraph.ts` 仅把该 DTO 确定性缩放为 display-only SVG，确认卡仍保留可访问语义列表且不读取实时 Canvas；真正授权仍由审批 Token 的 arguments hash 与 Action Receipt 的 intent hash 决定，previewHash/SVG 不是凭据。整组任一失败零写入；通过后由 `canvasAgentEditing.mjs` 仅调用一次 durable Canvas Graph commit。模型不能创建 Result、系统边或权威任务血缘；`canvasAgentArtifactProjection.mjs` 只从 Artifact Index 有界解析已完成、未隔离且使用同源授权媒体的生成图片/视频，提案与执行分别校验 Artifact hash，再由 `project_artifact + create_generate + connect_reference` 组成新的复用子图。preserve/change 只接受固定创意维度，并编译进 Generate 的执行契约；复用不创建 Job 或 system/output 边。`organize_nodes` 只允许有界精确坐标与可选名称；`layout_nodes` 则把 row/column/grid/workflow/align/distribute 声明交给 `canvasAgentLayout.mjs` 按稳定顺序和节点 bounds 计算绝对坐标，不让模型手算像素；`canvasAgentFrameRules.mjs` 拥有 Frame/Stage 数据、单归属、禁止嵌套与删除解除归属规则，成员仍使用绝对坐标，UI 不把 React Flow parentId/extent 当持久化权威；文档迁移将未知 Stage 归为 custom、尺寸 clamp 到领域范围并清除 Frame 嵌套或孤儿 membership；这些变化都进入结构化 Preview；可复用工作流继续由既有 `workflow_create` / `workflow_publish` 确认工具提升，不在 Canvas Action Set 内复制发布逻辑。完整决策见 ADR 0014。

项目权限由服务端区分读取、编辑、生成、内容删除、工作流修改、成员管理、外部工具、项目删除、审计与运行详情。
Owner 可管理成员、读取治理信息并审批外部工具；Editor 可编辑、生成和维护工作流；Viewer 只读。UI 隐藏按钮不是鉴权边界。

`server/agent/action/agentActionGovernance.mjs` 把 Agent 工具映射为项目权限。付费生成与外部工具行动必须携带绑定项目和工具调用的
短期审批；过期、跨项目或跨行动审批均由服务端拒绝。审计导出只允许白名单字段，不返回 Prompt、密钥、原始请求或私有媒体地址。

`server/agentActionExecution.mjs` 在执行副作用前以 Action Receipt 原子取得所有权。回执将同一提交键绑定到
`intentHash`，并通过 `running → succeeded / failed / uncertain`、租约 Token 与条件 settle 阻止多 API 实例重复执行。
已成功结果直接重放；明确失败且声明 `safe` 的动作可用新租约重试；超时、租约过期或 `never` 动作的未知结果收敛为
`uncertain`，界面只允许人工核对，不自动再执行；`running` 则表示原执行仍可能在途。同一租约的 claim/settle 是传输重试，
必须幂等返回；租约取得后即使成员角色被撤销，持有者仍须能 settle，避免已发生副作用永久悬空。Receipt 的身份、意图与
重放策略在首次 claim 后不可改写，数据库 Adapter 用数据库时钟判断租约。PostgreSQL 和 Supabase 负责多实例原子性；Local
Adapter 只保证单进程开发语义。Supabase 通过单个事务 RPC 同步 settle Receipt、Artifact Index 与 Audit，不能退回
read-then-upsert 或提交后尽力补写。

`server/mcpClient.mjs` 只公开安全 `catalog()` 与受控 `invoke()`：目录固定 `server.tool`、版本、输入/输出 Schema、
capability hash 与 `never` replay，不暴露 URL、token 或传输参数。Action Proposal 固定这份身份；执行前先验证
版本/hash 并投影输入，漂移或非法输入在出网前拒绝。请求严格使用 JSON-RPC 2.0 `tools/call`，响应按字节上限读取、
校验 request id 并投影输出。Runtime 将取消信号传播到外部请求，且只以受控 Header 传递 `intentHash`；派发后取消、
远端错误、协议错误或输出契约失败都不能证明未产生副作用，统一由 Receipt 收敛为未知结果。外部响应中的 URL
不是媒体授权，不能直接提升为 Artifact 或写入画布。旧 `putAgentActionReceipt` 仅允许插入兼容回执，不得覆盖 running
或终态记录。完整决策见 ADR 0010。

`server/agentActionReconciliation.mjs` 与 `/api/agent-actions/status|resolve` 只接受绑定独立 Session、Message 与 Action 的
服务端权威 Proposal；客户端不能选择 Receipt ID、intent hash 或参数。状态查询只回读已持久化的成功结果，绝不执行工具；
`confirmed_applied` 只确认外部事实，不伪造 output 或 Artifact。`confirmed_not_applied` 的 v2 路径要求浏览器先把非敏感 retry key
写入 Message，再由 Store 原子预留并绑定对应 retry Receipt；响应只回该 key 与过期时间，不下发 raw token。用户再次明确点击时
必须使用同一 key 与 fresh approval，Store 再把消费原子绑定到 `consumedByReceiptId`。若 consume 后、retry claim 前进程退出，
状态接口返回稳定恢复码，只允许同 key 无 token 恢复。其他 key、第二次消费及 retry 再次未知后的第二份授权都被拒绝；v1 raw
token 仅用于旧服务兼容，且只能停留在组件内存，不能进入 Message、Plan、Run 或 Artifact Index。

发布该迁移前必须在真实 PostgreSQL/Supabase 执行迁移与并发 claim 门禁，并先排空仍会绕过 claim 的旧执行实例；新旧版本
不能普通滚动混跑，再切换数据库函数与新流量。数据库变更按
`20260827120000_agent_turn_runtime_statuses.sql` → `20260827130000_agent_action_execution_claim.sql` →
`20260827140000_agent_turn_execution_claim.sql` → `20260827150000_agent_action_reconciliation.sql` →
`20260827160000_agent_recovery_pagination.sql` → `20260827170000_generation_job_execution_fence.sql` →
`20260827180000_agent_thread_summary_cas.sql` → `20260828120000_idempotency_request_binding.sql` →
`20260828130000_agent_branch_retry_claim.sql` → `20260828140000_agent_review_execution.sql` →
`20260828150000_agent_recovery_keyset.sql` → `20260828160000_agent_review_retry_atomic.sql` →
`20260828170000_agent_cancellation_exit_ack.sql` → `20260828180000_agent_message_entity_references.sql` 顺序执行；仓库测试只验证契约，
不代表生产迁移已经执行。
行动卡的 `running / succeeded / failed / uncertain / dismissed` 同步写入独立 Agent Message；发送中的旧快照若遇到新终态，
离线队列保留并补送新版。刷新或换设备不得把 `uncertain` 回退成待确认，也不得因本地化错误而丢失服务端业务码。

## 生成成本与 Provider 容灾

`server/generation/generationGovernance.mjs` 把一次持久化 Generation Job 作为唯一记账单元，按工作区、项目、成员、模型、媒体类型和
任务记录估算成本单位；同一幂等任务的重连、查询、恢复和 Worker 重启不会再次预留预算。`securityControls.reserveMany`
使用 Redis Lua 原子预留工作区、项目和成员额度，任一维度不足时全部拒绝，并在临界值向任务返回提醒。

`server/generation/generationJobExecution.mjs` 把 Job 的 `executionGeneration + leaseToken` 定义为 Worker 执行权。普通 `putGenerationJob`
不能创建或改写 fence；Worker 必须先原子 claim，heartbeat、变体进度与终态都由当前 generation 条件提交。任务 retry 会清除旧
lease，并保留单调 generation 水位；旧 Worker、旧回写恢复器和旧 Job→Run 投影因此不能覆盖新尝试。Job 终态先 durable 落库，
Canvas、Artifact Index 与 Agent Run 都只是可恢复投影；投影未完成时 `projectWritebackPending` 保持可扫描。Run 的普通整行写入在
Store 行锁内按 branch attempt、`activeJobId`、分支时间和终态优先级合并，避免更新 A 分支时把并发完成的 B 分支写回旧状态。
租约过期接管若发现本机旧执行 handle 仍占用，`generationProcessor.mjs` 会先请求中止旧 handle，再 fail-safe 退出且不调用 Provider；
新租约保持可恢复，等待旧执行真正释放或后续租约回收，避免同一进程出现双 Provider 调用。

`server/providerHealthMonitor.mjs` 在 Worker 间共享 Provider 失败计数、熔断和半开探测租约；Redis 暂时不可用时降级到进程内
熔断，但不改变任务身份。`generationProcessor.mjs` 只有在尚无成功变体，且媒体类型、输入角色、比例、清晰度和视频时长
语义完全兼容时才切换备用模型；否则返回明确的不可安全切换提示。重试和备用模型继续使用原任务 ID 与幂等键，不能创建
第二个任务或第二次预算预留。备用 Provider 真正接管后，任务的 `effectiveModel`、尝试记录与消耗归因同时更新为实际执行方，
不会把备用模型消耗误记到原模型。

Flock 图生图在 `generationProviderAdmission.mjs` 取得进程级高内存许可后才解码 data URL 或读取媒体 ID；等待许可受同一任务
deadline 与取消信号约束，跨 Provider fallback 只有真正进入 Flock 时才重新物化输入。许可覆盖 Provider、输出持久化与仍持有
输入 Buffer 的 fallback 区间，避免 Worker 并发把 48MB 单任务预算放大为进程 OOM。用户上传仍限制 8MB；Provider 图片统一按
32MB 输出契约保存，并可作为下一轮受控媒体 ID 输入，单任务全部参考、父图与蒙版仍共用 48MB 总预算。

## 版本化生产工作流

`server/productionWorkflow.mjs` 定义只追加版本的生产工作流与运行状态机；每个版本固定 Prompt、模型参数、输出设置、
品牌规则、素材组和确认策略。运行先持久化版本快照与批量输入，再经 `server/generation/generationSubmissionService.mjs` 的单一提交
入口创建 Generation Job，避免工作流、HTTP 与 Agent 各自实现幂等、预算和队列语义。失败项重试复用运行项的稳定哈希键，
不会再次预留预算，也不会复制已成功输出。

`server/productionWorkflowRoutes.mjs` 提供发布、读取、批量运行、暂停、恢复、取消和失败项重试；新版本不会改变进行中或
历史运行。运行读取时以持久化 Generation Job 对账状态，再关联 Artifact ID 与画布结果节点。Artifact Index 在每个生成输出
中保存工作流、版本、运行和运行项来源，因此删除临时画布节点后仍可从历史定位、下载、入库和继续迭代。

浏览器只通过 `src/lib/productionWorkflowApi.ts` 使用稳定资源契约；项目文档中的可选工作流目录是三类 ProductStore Adapter
共同保存的兼容视图，任务、Artifact 与画布图谱继续分别由原有权威记录拥有。生产工作流不得把媒体字节、Provider 凭据或
本机 UI 状态写入定义和运行记录。`src/domain/productionWorkflows.ts` 只把已完成的 Agent/画布生成操作转换为无媒体字节的
工作流草稿，模板面板提供发布、运行、暂停、恢复、取消、失败项重试、结果定位与审核入口；运行时由服务端从项目权威文档
解析稳定媒体标识，临时 Object URL 或未入库素材会被明确拒绝。

## 自动护栏

`npm test` 会同时执行：

- 服务端生成、幂等、媒体、存储和历史结果回填测试；
- `src/domain/` 的纯领域契约测试；
- 当前源码的依赖方向检查。

也可单独执行：

```bash
npm run check:architecture
```

检查会拒绝：

- 任意前端源码导入 `server/`；
- UI 组件直接导入网络、存储或 Store；
- `domain` 反向导入 UI、Store、种子数据或基础设施；
- `lib` 反向导入 UI 或 Store；
- Store 反向导入 UI。

## 变更准则

1. 先确定需求归属的模块，只修改拥有该行为的实现。
2. 跨 seam 时先固定或扩展稳定接口，再修改两侧 Adapter。
3. UI 需求使用 Fake/Mock 数据验证，不调用真实图像 Provider。
4. 生图或存储变更必须增加对应接口测试，并覆盖已有项目和历史任务。
5. 生产数据清理、数据库重置和真实生图验证需要单独授权。
