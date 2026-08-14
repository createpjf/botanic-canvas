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
| 生成处理器 | `server/generationProcessor.mjs` | `processGenerationJob(jobId)` | 注入的 ProductStore、Media 与 Provider |
| Agent Run 生成服务 | `server/agentRunGenerationService.mjs` | 为已确认 Run 准备工作流、复用幂等任务、入队并回写项目 | ProductStore、生成队列、安全配额与实时事件 |
| Adapter | `server/*Store.mjs`、`server/objectStore.mjs` 等 | 产品存储、媒体、队列、第三方图像能力 | 各自外部系统；由 `server/runtime.mjs` 选择并组装 |

模型能力由 `server/generationModels.mjs` 统一声明，Worker 只能经
`server/generationService.mjs` 路由到 OpenAI、MiniMax Image 或 MiniMax H3。
所有供应商输出都先转成 `{ mediaKind, mimeType, buffer }`，再由媒体服务持久化；
H3 的 MP4 与历史图片共用授权 URL，但历史缺少 `mediaKind` 时始终按图片兼容读取。

`src/components/` 是纯 UI 模块，不得直接导入 `src/lib/`、`src/store/` 或 `server/`。`src/features/` 拥有功能内的交互协调，可以使用 Store 与高层浏览器接口；`src/App.tsx` 仅保留登录恢复、跨功能组合和按需加载。只允许最后一次异步结果落地的流程统一使用 `src/domain/latestOperation.ts` 的令牌接口。

生成配方和批量变体的纯规则分别位于 `src/domain/generationRecipe.ts` 与 `src/domain/batchVariations.ts`。前者以生成节点入线与输入顺序构建配方，后者在提交前限制总输出并提供有界并发；Store 只负责把这些规则与持久化、网络任务组合起来。

`canvasDocumentMigration.ts` 与 `canvasDocumentAssets.ts` 分别拥有版本迁移、引用清理及模板快照，不发起 I/O；`canvasGenerationProjection.ts` 只把任务与批量分支投影为画布文档；`canvasGenerationActions.ts` 自持普通生成的幂等提交、轮询、取消与恢复；`canvasDocumentLifecycleActions.ts` 统一项目打开、远端刷新、新建与重命名；`canvasAssetGraphActions.ts` 统一画布图谱、参考素材、素材组和可编辑节点命令；模板/历史、Agent、批量变体分别由对应 Actions 模块拥有。本地持久化模式不发起服务端生成结果对账。

`src/features/canvas/workspaceProjectCoordinator.ts` 统一拥有项目摘要读取、过期请求失效、模板建项、重命名与乐观删除；`useCanvasWorkspaceSynchronization.ts` 统一拥有本地草稿同步、页面恢复、Realtime/Yjs 协作和 Agent Run 追踪；`useCanvasAgentExecutionBridge.ts` 统一 Agent 上下文、Run、Artifact 与画布写回；`useCanvasInteractionCoordinator.ts` 统一 React Flow 变更、视口、连线、边操作和文件拖放。`CanvasWorkspace.tsx` 只组合导航、面板与上述协调器。

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
`server/canvasCollaborationRoom.mjs` 持久化成功，再按项目转发。项目元数据使用 `revision`，独立画布图谱使用
`graphRevision`；HTTP 写入只有在图谱确实变化时才校验后者，避免重命名等元数据操作误伤实时协作。
写入成功后才发布 `project.updated`。本地存在未同步草稿时，
`src/lib/db.ts` 会拒绝远端整份覆盖，网络恢复或页面重新聚焦仍作为 WebSocket 之外的降级路径。

`canvas_graphs` 保存可直接读取的节点/连线物化视图与压缩快照，`canvas_graph_updates` 按顺序保存 Yjs 增量。
API 重启后用快照与增量重建房间；累计 64 条后压缩，避免日志无限增长。旧项目首次读取或服务启动时会从
`projects.document.nodes/edges` 自动建立图谱，读取接口再把独立图谱覆盖进兼容项目文档，因此历史项目和旧客户端
不需要一次性迁移。生成任务、媒体输出与历史回填仍以 ProductStore/Worker 的持久化结果为权威，Yjs 不参与
任务状态判断，也不能用缺少媒体字段的临时节点覆盖已有图片或视频。

房间重建时先用物化图谱纠正可能过期的 Yjs 日志；最后一个客户端离开后，房间默认空闲 60 秒即释放。
初始化失败的房间 Promise 不缓存，使短暂数据库故障恢复后可以重新连接。

画布房间经 `server/canvasRealtimeEventBus.mjs` 使用 Redis Pub/Sub 跨 API 实例传播已持久化的 Yjs 增量与 Presence
快照。来源实例先持久化再广播，远端实例只更新内存房间并转发给本机连接，不重复落库；实例 ID、事件 ID 与更新摘要
共同阻止广播回环和重复应用，Yjs 负责乱序依赖补偿。Presence 只传播成员与连接数，按 TTL 清除失联实例；图片/视频
字节、本机选择态和视角不进入事件总线。API 重启或切换实例后仍从 ProductStore 的物化图谱、快照和增量日志恢复。
独立 Agent Run 与协作动态继续经 `server/agentRunEventBus.mjs` 跨实例传播；UI 不感知实例拓扑，断线后仍以 ProductStore
的独立 Agent 实体、协作历史与成员回执恢复。

## Agent 实体持久化

`server/botanicAgentPersistence.mjs` 定义 Session、Message、Memory 的安全实体形状，以及新实体和旧文档字段的兼容合并规则。ProductStore 的本地文件、PostgreSQL 和 Supabase Adapter 共同实现：

- `agent_sessions` 只保存会话标题、执行模式和上下文节点；
- `agent_messages` 按消息 ID 和 Session ID 独立追加或更新；
- `agent_memory_items` 保存项目记忆，并用 `deleted_at` 阻止旧快照复活删除项；
- `agent_runs` 继续保存确认计划后的执行状态和分支进度；
- 项目文档写入期间双写独立实体，项目读取时由独立实体覆盖兼容字段；
- 独立实体写入不增加画布 `revision`，因此两台设备追加不同消息不会因整份文档冲突而互相覆盖。
- Session、Message、Memory 与 Run 的真实变更写入可分页的协作历史，并发布项目级失效事件；浏览器收到事件后重新读取独立实体，而不是相信本地兼容快照。
- 协作历史用 `(occurredAt, id)` 稳定游标分页；成员的已读与清空回执只向前推进，失败时保留原 UI 状态并允许重试。
- Session、Message、Memory 与 Run 的实体 ID 全局唯一，`project_id` 是授权与归属边界；跨项目 ID 冲突必须明确失败，不能在历史回填中静默丢失。

迁移阶段不删除 `CanvasDocument.agentSessions / agentMemory / agentRuns`。Supabase 迁移完成、历史数据 Backfill 和双设备门禁通过后，才能停止旧字段写入。

## Artifact Index 与历史回填

`server/botanicArtifactIndex.mjs` 把 Agent Message/Action Receipt 中的工具产物，以及 Generation Job 中的图片或视频输出，规范为同一个项目级索引。Artifact ID 只在项目内唯一，数据库使用 `(project_id, id)` 复合身份，以兼容旧版 `legacy-writeback` 等跨项目重复 ID。

本地 ProductStore 在启动时扫描项目文档、独立消息、行动回执和生成任务；PostgreSQL 启动建表过程与 Supabase Migration 则使用幂等 `upsert` 回填历史记录。后续 Message、Action Receipt、Generation Job 和兼容项目文档写入都会增量维护索引。索引不反向拥有画布节点或素材库记录，因而历史记录不会随 UI 删除而消失。

## Agent 执行可观测性

`server/agentExecutionTrace.mjs` 使用 `agent-trace:<runId>` 作为稳定关联标识，把 Agent Run、Planner 模型、
工具调用、生成 Job 与 Artifact Index 组合为只读执行快照。它不改变 Session、Message、Run、Job 或 Artifact 的
既有身份和幂等键，也不返回 Prompt、媒体地址或 Provider 原始请求。浏览器通过 Agent API 读取简洁状态；技术阶段、
失败类型、耗时、重试与回填状态留在可展开 Runtime/执行链路中。

`server/agentRunObservability.mjs` 为 API 与 Worker 日志写入同一 traceId；失败分支继续使用原有幂等重试入口，
已存在的 Job 在配额扣减前即被复用，因此重放不会重复创建任务或重复扣费。`server/agentQualityEvaluation.mjs`
只消费固定离线夹具，计算成功率、等待时间、恢复率、重复提交率和结果回填完整性，普通验证不得调用真实 Provider。

## 项目权限与 Agent 行动审批

项目权限由服务端区分读取、编辑、生成、内容删除、工作流修改、成员管理、外部工具、项目删除、审计与运行详情。
Owner 可管理成员、读取治理信息并审批外部工具；Editor 可编辑、生成和维护工作流；Viewer 只读。UI 隐藏按钮不是鉴权边界。

`server/agentActionGovernance.mjs` 把 Agent 工具映射为项目权限。付费生成与外部工具行动必须携带绑定项目和工具调用的
短期审批；过期、跨项目或跨行动审批均由服务端拒绝。审计导出只允许白名单字段，不返回 Prompt、密钥、原始请求或私有媒体地址。

## 生成成本与 Provider 容灾

`server/generationGovernance.mjs` 把一次持久化 Generation Job 作为唯一记账单元，按工作区、项目、成员、模型、媒体类型和
任务记录估算成本单位；同一幂等任务的重连、查询、恢复和 Worker 重启不会再次预留预算。`securityControls.reserveMany`
使用 Redis Lua 原子预留工作区、项目和成员额度，任一维度不足时全部拒绝，并在临界值向任务返回提醒。

`server/providerHealthMonitor.mjs` 在 Worker 间共享 Provider 失败计数、熔断和半开探测租约；Redis 暂时不可用时降级到进程内
熔断，但不改变任务身份。`generationProcessor.mjs` 只有在尚无成功变体，且媒体类型、输入角色、比例、清晰度和视频时长
语义完全兼容时才切换备用模型；否则返回明确的不可安全切换提示。重试和备用模型继续使用原任务 ID 与幂等键，不能创建
第二个任务或第二次预算预留。备用 Provider 真正接管后，任务的 `effectiveModel`、尝试记录与消耗归因同时更新为实际执行方，
不会把备用模型消耗误记到原模型。

## 版本化生产工作流

`server/productionWorkflow.mjs` 定义只追加版本的生产工作流与运行状态机；每个版本固定 Prompt、模型参数、输出设置、
品牌规则、素材组和确认策略。运行先持久化版本快照与批量输入，再经 `server/generationSubmissionService.mjs` 的单一提交
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

节点式营销 DAG 是可选叠加：`definition.graph` 含 approval / generation / validation / delivery。
文案批准前生成节点保持 blocked；校验失败时交付节点不得运行。浏览器经 `publishMarketingPlanWorkflow`、
`startProductionWorkflowRun`、`approve-node` / `advance` / `retry-node` 操作服务端权威，不在 UI 推演整链。
`marketingWorkflowRunProjection` 把 NodeRun、`approvals[]` 与 `validationReports[]` 投影给 Agent 面板；
刷新从 `readProductionWorkflowRun` 恢复，本地 Demo 执行不是权威。

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
