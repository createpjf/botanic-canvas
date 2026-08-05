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
| 画布应用模块 | `src/store/` | `canvasStore.types.ts` 契约；`canvasGenerationLifecycle.ts` 恢复持久化任务状态，`canvasAgentActions.ts` 拥有 Agent 实体命令，其余画布命令由 `canvasStore.ts` 组合 | `domain`、`lib`、种子数据 |
| 领域契约 | `src/domain/` | 画布数据、生成结果放置等纯规则 | 类型依赖与纯计算，不依赖 UI、Store、网络或存储 |
| 浏览器基础设施 | `src/lib/` | 会话、生成请求、项目文档与离线草稿接口 | `domain`、浏览器/网络 Adapter，不依赖 UI 或 Store |
| Node API | `server/index.mjs` | 鉴权后的 HTTP 与 WebSocket 接口；每类资源由独立 Route 模块拥有方法目录和 405 语义 | 队列、处理器、运行时组合根 |
| 授权 | `server/authorization.mjs`、`server/projectAuthorization.mjs` | 工作区/项目权限决策与 403/404 语义 | ProductStore 的用户与项目成员关系，不依赖 UI |
| 生成处理器 | `server/generationProcessor.mjs` | `processGenerationJob(jobId)` | 注入的 ProductStore、Media 与 Provider |
| Adapter | `server/*Store.mjs`、`server/objectStore.mjs` 等 | 产品存储、媒体、队列、第三方图像能力 | 各自外部系统；由 `server/runtime.mjs` 选择并组装 |

模型能力由 `server/generationModels.mjs` 统一声明，Worker 只能经
`server/generationService.mjs` 路由到 OpenAI、MiniMax Image 或 MiniMax H3。
所有供应商输出都先转成 `{ mediaKind, mimeType, buffer }`，再由媒体服务持久化；
H3 的 MP4 与历史图片共用授权 URL，但历史缺少 `mediaKind` 时始终按图片兼容读取。

`src/components/` 是纯 UI 模块，不得直接导入 `src/lib/`、`src/store/` 或 `server/`。`src/features/` 拥有功能内的交互协调，可以使用 Store 与高层浏览器接口；`src/App.tsx` 仅保留登录恢复、跨功能组合和按需加载。只允许最后一次异步结果落地的流程统一使用 `src/domain/latestOperation.ts` 的令牌接口。

生成配方和批量变体的纯规则分别位于 `src/domain/generationRecipe.ts` 与 `src/domain/batchVariations.ts`。前者以生成节点入线与输入顺序构建配方，后者在提交前限制总输出并提供有界并发；Store 只负责把这些规则与持久化、网络任务组合起来。

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

当前房间在单个 API 实例内广播，持久化状态支持重启恢复。若未来横向扩容多个 API 实例，需要在相同 seam 后
增加 Redis Pub/Sub 或等价跨实例广播；不应让 UI 感知实例拓扑。

## Agent 实体持久化

`server/botanicAgentPersistence.mjs` 定义 Session、Message、Memory 的安全实体形状，以及新实体和旧文档字段的兼容合并规则。ProductStore 的本地文件、PostgreSQL 和 Supabase Adapter 共同实现：

- `agent_sessions` 只保存会话标题、执行模式和上下文节点；
- `agent_messages` 按消息 ID 和 Session ID 独立追加或更新；
- `agent_memory_items` 保存项目记忆，并用 `deleted_at` 阻止旧快照复活删除项；
- `agent_runs` 继续保存确认计划后的执行状态和分支进度；
- 项目文档写入期间双写独立实体，项目读取时由独立实体覆盖兼容字段；
- 独立实体写入不增加画布 `revision`，因此两台设备追加不同消息不会因整份文档冲突而互相覆盖。
- Session、Message、Memory 与 Run 的实体 ID 全局唯一，`project_id` 是授权与归属边界；跨项目 ID 冲突必须明确失败，不能在历史回填中静默丢失。

迁移阶段不删除 `CanvasDocument.agentSessions / agentMemory / agentRuns`。Supabase 迁移完成、历史数据 Backfill 和双设备门禁通过后，才能停止旧字段写入。

## Artifact Index 与历史回填

`server/botanicArtifactIndex.mjs` 把 Agent Message/Action Receipt 中的工具产物，以及 Generation Job 中的图片或视频输出，规范为同一个项目级索引。Artifact ID 只在项目内唯一，数据库使用 `(project_id, id)` 复合身份，以兼容旧版 `legacy-writeback` 等跨项目重复 ID。

本地 ProductStore 在启动时扫描项目文档、独立消息、行动回执和生成任务；PostgreSQL 启动建表过程与 Supabase Migration 则使用幂等 `upsert` 回填历史记录。后续 Message、Action Receipt、Generation Job 和兼容项目文档写入都会增量维护索引。索引不反向拥有画布节点或素材库记录，因而历史记录不会随 UI 删除而消失。

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
