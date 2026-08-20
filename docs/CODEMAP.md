# Botanic 代码地图

这份地图回答三个问题：需求属于哪里、从哪个接口进入、改完验证什么。文件名表达所有权；同一行为只保留一个权威实现。

## 快速定位

| 需求/行为 | 首要入口 | 相关实现 | 聚焦测试与不变量 |
| --- | --- | --- | --- |
| 画布节点与连线 | `src/domain/canvas.ts` | `generationRecipe.ts`、`generateNodeCreation.ts`、`canvasNodeLayout.ts` | 对应 `src/domain/*.test.ts`；输入连线是生成配方唯一来源 |
| 输出节点与血缘 | `src/domain/generationOutputPlacement.ts` | `src/store/canvasGenerationProjection.ts`、`server/generationResultReconciliation.mjs`、`canvasPresentation.ts` | 每个输出独立成节点；候选 ID 稳定 |
| 应用登录与入口 | `src/App.tsx` | `src/lib/productSession.ts`、功能模块按需加载 | 应用壳不拥有画布或领域规则 |
| 画布交互与面板 | `src/features/canvas/CanvasWorkspace.tsx` | `CanvasEditorViews.tsx`、`CanvasWorkspacePanels.tsx`、`workspaceProjectCoordinator.ts`、`useCanvasWorkspaceSynchronization.ts`、`useCanvasAgentExecutionBridge.ts`、`useCanvasInteractionCoordinator.ts`、`canvasWorkspaceNavigation.ts` | `src/features/canvas/*.test.ts`、UI E2E；项目 I/O、同步、Agent 执行桥和 React Flow 交互分别归对应协调器，工作区只组合导航与面板 |
| Agent 面板交互 | `src/features/agent/AgentWorkspace.tsx` | `AgentConversationMessage.tsx`、`AgentComposer.tsx`、`AgentUtilityPanels.tsx`、`useAgentMessageDelivery.ts`、`useAgentRuntimeTrace.ts` | Agent 领域/Lib 测试；工作区只编排，对话卡和 Composer 各自拥有展示交互 |
| Agent Composer 引用字段 | `src/domain/agentMentions.ts`、`readBotanicAgentMentionQuery`（`agent.ts`） | `AgentComposer.tsx`、`AgentConversationMessage.tsx`、`AgentPromptResponse.tsx`、`botanicAgentPersistence.mjs` | `/` 挂载 Skill、`@` 引用画布节点或图片视频；选中后写入 `mentions` 芯片，不写入可执行 Prompt |
| Agent 回合解析 | `server/botanicAgentTurn.mjs` | `AgentWorkspace.tsx`、`agentApi.ts`、`botanicAgentWebTools.mjs` | 回合与对话共用 `web_search`/`web_fetch`（需 `BOTANIC_WEB_SEARCH_API_KEY`）；流式工具步与时间线收口在回合完成；原始推理仅 `AGENT_RAW_REASONING` 下发且不落盘 |
| 画布应用状态 | `src/store/canvasStore.types.ts` | `canvasStore.ts`、`canvasDocumentLifecycleActions.ts`、`canvasAssetGraphActions.ts`、`canvasGenerationActions.ts`、`canvasGenerationLifecycle.ts`、`canvasGenerationProjection.ts`、`canvasTemplateHistoryActions.ts`、`canvasAgentActions.ts`、`canvasBatchVariationActions.ts` | 先核对 Store 端口；文档、图谱素材、普通生成、模板/历史、Agent 和批量变体命令分别由深模块拥有；远端新结果不得被旧草稿覆盖 |
| 普通生成任务 | `src/lib/generationApi.ts` | `server/generationService.mjs`、`generationProcessor.mjs`、`generationProvider.mjs`、`generationOutputSize.mjs`、`generationComposition.mjs` | `server/generation*.test.mjs`、`src/domain/generationOutputSize.test.ts`、`src/domain/generationComposition.test.ts`；同一次重试复用幂等键；gpt-image-2 可自定义像素；多图合成时标识不得当底图 |
| 生成成本与 Provider 容灾 | `server/generationGovernance.mjs` | `securityControls.mjs`、`providerHealthMonitor.mjs`、`generationRoutes.mjs`、`generationProcessor.mjs` | 任务级唯一记账；多维预算原子预留；仅语义兼容模型可降级；熔断半开后恢复 |
| 版本化生产工作流 | `server/productionWorkflow.mjs` | `productionWorkflowRoutes.mjs`、`generationSubmissionService.mjs`、`src/domain/productionWorkflows.ts`、`src/lib/productionWorkflowApi.ts`、模板面板、Artifact Index | 已验证 Agent/画布操作可提升为版本；运行固定快照；批量项独立恢复；失败重试复用任务与预算；Artifact 保留版本血缘 |
| 批量变化 | `src/domain/batchVariations.ts` | `src/store/canvasBatchVariationActions.ts`、服务端 Processor | `batchVariations.test.ts`、Processor 测试；计划先限制总输出，Store 以有界并发协调独立子任务及恢复，各分支独立持久化 |
| Agent 对话分流 | `src/domain/agentChatContract.ts` | `src/lib/agentApi.ts`、`server/botanicAgentChat.mjs`、`server/agentWebResearch.mjs`、`webSearchProvider.mjs` | 对话测试；浏览器不发送图片字节或私有 URL；Tavily 为默认 `web_search`；URL 守卫与结果清洗只在服务端一份实现 |
| Agent 工具流式时间线 | `src/domain/agentTimeline.ts`、`src/domain/agentChatStream.ts` | `server/agentToolRuntime.mjs`、`/api/agent-chat/stream`、`/api/agent-intent/stream`、`/api/agent-plans/stream`、`AgentWorkspace.tsx` | 工具步仅在 `registry.execute` 前后 emit；禁止客户端 rAF 假进度；确认后 Run/分支投影进同款时间线 |
| Agent 计划和执行 | `src/domain/agentPlanContract.ts` | `agent.ts`、`agentVariations.ts`、`agentInstructionRouting.ts`、`server/botanicAgentPlanner.mjs`、`botanicAgentTools.mjs`、`agentRunGenerationService.mjs` | Agent Planner/Tool/Run 测试；无素材组时按已确认变体轴展开，张数由展开结果决定；Run 生成复用持久化幂等任务，外部行动默认确认；镜像行为由 `scripts/fixtures/agentVariationMirrorCases.json` 两侧对拍锁定 |
| Agent 多模态视觉 | `server/botanicAgentVision.mjs` | `botanicAgentChat.mjs`、`botanicAgentTurn.mjs`、`runtime.mjs`（`AGENT_VISION_MODEL`） | 视觉测试；引用图片优先直接随消息附给视觉模型（原生多模态），被网关拒绝时回退 caption 描述 + 文本模型；识别结果不进任何持久化实体 |
| 局部重绘（选区→蒙版） | `src/domain/regionMask.ts` | `server/regionMaskPng.mjs`、`imageOverlay.mjs`、`generationProvider.mjs`、`generationComposition.mjs`、`RegionMaskEditor.tsx`、`agent.ts`（`region_edit`） | regionMask/overlay/provider/composition 测试；选区是归一化纯数据；贴标识默认走 GPT Image 2 高质 edits，像素贴图层仅 `composeMode=overlay` |
| MCoT 创意分解 | `src/domain/agentCreativeComposition.ts` | `server/botanicAgentTurn.mjs`（`decompose_creative_brief`）、`AgentConversationMessage.tsx`（方案卡）、`agentVariations.ts`（条目分支）、`botanicAgentExecution.mjs` | 分解/持久化/执行测试；成套请求落成 `kind: composition` 消息与方案卡，刷新后从消息恢复「生成第 N 项 / 执行方案」；方案卡逐项/整套按钮绑定该条消息自己的 composition |
| Agent 可观测与评测 | `server/agentExecutionTrace.mjs` | `agentRunObservability.mjs`、`agentQualityEvaluation.mjs`、`src/lib/agentApi.ts` | 稳定 traceId 串联 Run/Job/Artifact；只返回运维字段；固定评测不调用 Provider |
| Agent 权限与审批 | `server/agentActionGovernance.mjs` | `authorization.mjs`、`projectAuthorization.mjs`、`agentRoutes.mjs`、`projectRoutes.mjs` | 服务端权限矩阵、短期行动审批和脱敏审计导出；UI 不可替代鉴权 |
| Agent 持久化 | `server/botanicAgentPersistence.mjs` | 三个 ProductStore Adapter、Canvas 兼容视图 | 独立实体合并测试；Memory 墓碑永久胜出 |
| Agent 协作历史 | `server/collaborationActivityPersistence.mjs` | `agentRoutes.mjs`、三个 ProductStore Adapter、`agentRunEventBus.mjs`、`useCanvasWorkspaceSynchronization.ts` | 稳定游标分页、成员回执单调前进、跨实例实时失效；旧快照不得覆盖远端独立实体 |
| Artifact Index | `server/botanicArtifactIndex.mjs` | 三个 Store Adapter、Agent 结果区 | Artifact 测试和迁移对账；历史不随 UI 删除 |
| 素材与媒体 | `src/domain/asset*.ts`、`agentMedia.ts` | `src/lib/db.ts`、`server/mediaService.mjs`、`objectStore.mjs` | 素材/媒体测试；组件不接触对象存储凭据 |
| 项目同步 | `src/lib/db.ts` | `projectRealtime.ts`、`projectCollaboration.ts`、`server/realtimeHub.mjs`、`server/canvasRealtimeEventBus.mjs`、Store | Realtime/冲突/双实例测试；`revision` 与 `graphRevision` 分工明确，跨实例 Yjs 只在来源实例落库 |
| 账户与权限 | `src/lib/productSession.ts` | `server/authorization.mjs`、`projectAuthorization.mjs` | 授权和账户测试；越权 403、真实缺失 404 |
| HTTP 路由 | `server/httpRouteTable.mjs` | `sessionRoutes.mjs`、`projectRoutes.mjs`、`generationRoutes.mjs`、`accountRoutes.mjs`、`libraryRoutes.mjs`、`agentRoutes.mjs`、`promptMediaRoutes.mjs`、`realtimeTicketRoutes.mjs` | 资源模块返回是否已处理并拥有 405/Allow；组合根只负责鉴权基础设施与处理器编排 |
| ProductStore | `server/runtime.mjs` | `productStore.mjs`、`postgresProductStore.mjs`、`supabaseProductStore.mjs` | Adapter 契约及各 Store 测试 |
| 投放交付 | `src/domain/deliveryPresentation.ts` | `src/lib/deliveryExport.ts` | delivery 测试；视频不进入图片投放模板 |

## 依赖方向

```text
App / Feature UI → Store → Domain + Browser Lib → Node HTTP → Queue / Processor → Adapter
```

- `src/domain/`：纯规则和数据契约，不依赖 UI、Store、网络或存储。
- `src/lib/`：浏览器网络与本地持久化 Adapter，不依赖 UI 或 Store。
- `src/store/`：组合领域规则和浏览器 Adapter，不依赖 UI。
- `src/components/`：纯展示和用户事件，只依赖领域类型与共享 UI。
- `src/features/`：按产品能力组合 Store、Lib 和组件；对外暴露一个明确功能入口。
- `src/App.tsx`：应用壳，只负责登录恢复和功能模块加载，不拥有画布或领域规则。
- `src/domain/latestOperation.ts`：跨 Store/功能 UI 复用的最后请求令牌，项目切换时显式失效旧结果。
- `src/features/agent/useAgentMessageDelivery.ts`：Agent 消息本地追加、离线排队与联网重放的单一入口。
- `src/features/agent/AgentConversationMessage.tsx` 与 `AgentComposer.tsx`：分别拥有消息/计划卡展示和输入区交互，避免工作区编排器继续吸收视图细节。
- `src/store/canvasGenerationLifecycle.ts`：从持久化任务重建请求与 UI 生命周期状态的单一入口；不从本地 loading 推断任务真相。
- `src/store/canvasAgentActions.ts`：保持 `CanvasStore` 接口不变，集中 Session、Message、Memory 与 Run 的兼容提交命令。
- `server/runtime.mjs`：服务端组合根，选择 ProductStore、队列、媒体和 Provider Adapter。

完整规则见 [ARCHITECTURE.md](ARCHITECTURE.md)，自动检查见 `scripts/architectureBoundaries.mjs`。

## 检索建议

优先搜索领域名和公开命令，不要从 CSS 类名反推业务：

```bash
rg "runGraphGeneration|runBatchVariation" src server
rg "BotanicAgentRun|AgentArtifact" src/domain server
rg "requireProjectPermission" server
rg "revision|graphRevision" src/lib server
```

如果需求同时命中 App、Store 和服务端，先固定跨层接口与不变量，再逐层修改；不要在一次 UI 修改中顺带改变任务或持久化语义。

## 验证矩阵

| 改动范围 | 必跑验证 |
| --- | --- |
| Domain / Lib | 对应 `node --test ...`，然后 `npm test` |
| UI / Store | 对应行为测试、`npm run build`、必要的浏览器回归 |
| Server / Adapter | 对应 `server/*.test.mjs`、`npm test` |
| 依赖方向 | `npm run check:architecture` |
| 发布相关 | 以上全部，加生产浏览器、控制台、HTTP 与 Provider 分项验证 |

UI E2E 门禁使用本地持久化与伪健康接口，覆盖项目 → 画布 → Agent、面板互斥、Composer 执行模式、`/` Skill 与 `@` 引用和 hash 刷新恢复；不消耗真实 Provider 额度。
