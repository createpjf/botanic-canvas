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
| 界面动效 | `src/components/gsapMotion.ts` | `ProductLanding.tsx`、`AgentComposer.tsx`、`AgentWorkspace.tsx`、`AgentConversationMessage.tsx` | `src/components/gsapMotion.test.ts`；只动 transform/opacity；工具面板用 Flip（simple，不插值宽高）；不伪造工具进度；reduced-motion 时长为 0 |
| Agent Composer 引用字段 | `src/domain/agentMentions.ts`、`readBotanicAgentMentionQuery`（`agent.ts`） | `AgentComposer.tsx`、`AgentConversationMessage.tsx`、`AgentPromptResponse.tsx`、`botanicAgentPersistence.mjs` | `/` 挂载 Skill、`@` 引用画布节点或图片视频；选中后写入 `mentions` 芯片，不写入可执行 Prompt |
| Agent 回合解析 | `server/botanicAgentTurn.mjs` | `AgentWorkspace.tsx`、`agentApi.ts`、`botanicAgentWebTools.mjs` | 回合与对话共用 `web_search`/`web_fetch`（需 `BOTANIC_WEB_SEARCH_API_KEY`）；流式工具步与时间线收口在回合完成；原始推理仅 `AGENT_RAW_REASONING` 下发且不落盘 |
| 画布应用状态 | `src/store/canvasStore.types.ts` | `canvasStore.ts`、`canvasDocumentLifecycleActions.ts`、`canvasAssetGraphActions.ts`、`canvasGenerationActions.ts`、`canvasGenerationLifecycle.ts`、`canvasGenerationProjection.ts`、`canvasTemplateHistoryActions.ts`、`canvasAgentActions.ts`、`canvasBatchVariationActions.ts` | 先核对 Store 端口；文档、图谱素材、普通生成、模板/历史、Agent 和批量变体命令分别由深模块拥有；远端新结果不得被旧草稿覆盖 |
| 普通生成任务 | `src/lib/generationApi.ts` | `server/generationService.mjs`、`generationProcessor.mjs`、`generationProvider.mjs`、`generationOutputSize.mjs`、`generationComposition.mjs` | `server/generation*.test.mjs`、`src/domain/generationOutputSize.test.ts`、`src/domain/generationComposition.test.ts`；同一次重试复用幂等键；gpt-image-2 可自定义像素；多图合成时标识不得当底图 |
| 生成成本与 Provider 容灾 | `server/generationGovernance.mjs` | `securityControls.mjs`、`providerHealthMonitor.mjs`、`generationRoutes.mjs`、`generationProcessor.mjs` | 任务级唯一记账；多维预算原子预留；仅语义兼容模型可降级；熔断半开后恢复 |
| 线程摘要与执行冻结 | `server/agentThreadSummary.mjs` | `agentToolRuntime.mjs`（`freezeAgentStepSnapshot`）、`botanicAgentTurn.mjs`（摘要作为独立上下文层注入）、`agentRoutes.mjs`（派生并写回会话）、`botanicAgentPersistence.mjs`（会话上的检查点校验） | `server/agentThreadSummary.test.mjs`、`agentToolRuntime.test.mjs`；四类上下文层（turn_context / thread_summary / project_memory / artifact_reference）不得混用；摘要**确定性派生**自消息结构字段，不让模型复述约束；不含 Prompt 原文、媒体地址、链接与凭据；检查点只增不改写历史；工具集在进入循环前定格，中途改配置不影响已开始的执行 |
| 分支重试与工作流发布 | `server/agentBranchRetryService.mjs`、`server/productionWorkflowPublishService.mjs` | `agentBranchRetryPolicy.mjs`、`agentBranchRetrySweep.mjs`、`agentRoutes.mjs`、`productionWorkflowRoutes.mjs`、`worker.mjs`（`branch.retry`） | `server/agentBranchRetry*.test.mjs`；两者各只有一份实现，路由与运维工具共用 —— 重试复制出错等于重复扣费，发布复制出错等于同一次发布固定出不同的不可变契约；自动重试是白名单（未知错误码不重试）、只重一次、高成本与预算不足停下并记录原因 |
| Agent 运维工具 | `server/botanicAgentOperationalTools.mjs` | `botanicAgentTurn.mjs`（只读工具接入回合）、`botanicAgentTools.mjs`（写工具进确认注册表）、`agentActionGovernance.mjs`（权限表）、`agentRoutes.mjs`（读取器与执行器） | `server/botanicAgentOperationalTools.test.mjs`、`agentRoutes.test.mjs`；只返回结构化状态不拼文案；**不返回受控媒体地址、Prompt 或 Provider 原始回包**；缺读取器/执行器或权限不足就不暴露（Viewer 看不到写工具）；暴露判定与服务端权限表同源，有测试逐角色比对 |
| 结果评审与人工决定 | `server/agentReviewTask.mjs` | `agentReviewDeterministic.mjs`、`agentReviewVision.mjs`、`agentReviewRunner.mjs`、`agentReviewService.mjs`、`mediaSpec.mjs`、`derivedTaskQueue.mjs`（`review.run`）、`agentRoutes.mjs`（评审任务读取与决定） | `server/agentReview*.test.mjs`、`mediaSpec.test.mjs`；硬规格走确定性层不调模型，第 1 层 fail 不进第 2 层；rubric 来自 `CompiledCreativePlan.qualityPolicy` 并记指纹；覆盖策略与被跳过数必须可见，不静默截断；每个候选都有结论才能 completed；评审从不改写 Run/Job 状态；自动结论一律停在待人工；视觉层判据全部来自计划快照的质量策略，模型漏答判无法验证而非通过 |
| 项目记忆治理 | `server/botanicAgentMemory.mjs` | `botanicAgentPersistence.mjs`（`validateAgentMemoryEntity`）、`agentRoutes.mjs`（规划输入）、`botanicAgentContextTools.mjs`（`project_memory_search`）、`productionWorkflow.mjs`（`resolveWorkflowBrandRules`） | `server/botanicAgentMemory.test.mjs`、`botanicAgentPersistence.test.mjs`；**项目内只允许一条读取路径**，构造 Prompt/Plan/工作流定义都必须经选择器；`status` 是激活开关、`confidence` 是可信程度，不得互相顶替；active 需人工来源或已确认证据；已确认的人工规则不因措辞未命中而落选；冲突记忆不同时进同一 Plan 且落选可见 |
| Skill 版本与生命周期 | `server/botanicAgentSkill.mjs` | `botanicAgentTools.mjs`（内置 Skill 版本）、`agentRoutes.mjs`（创建批准人、绑定固定版本）、`src/domain/agent.ts` | `server/botanicAgentSkill.test.mjs`、`agentRoutes.test.mjs`；已发布版本不原位改写，修改追加新版本且历史版本可按版本取回；治理状态由流程产生，`published` 必须有批准人；Run 绑定的 version 与 contentHash 必填，内置 Skill 不例外 |
| 计划 Resolve 与 Compile | `server/creativePlanResolver.mjs` | `botanicCreativePlanCompiler.mjs`、`botanicAgentExecution.mjs`、`generationSubmissionService.mjs`、`botanicAgentRun.mjs`（`compiledPlanProvenance`） | `server/creativePlanResolver.test.mjs`、`botanicCreativePlanCompiler.test.mjs`、`botanicAgentExecution.test.mjs`；Resolve 是唯一读权威文档的一侧并抛阶段化错误，Compile 保持纯；plan 级指纹只能由 Resolve 统一计算，分支指纹由它派生；确认后的快照落在 Run 上，重试只读快照；快照与实际解析出的引用身份不一致时阻断而不换素材顶替 |
| Turn 与 Run 关联 | `run.turnId`（`botanicAgentRun.mjs`） | `productStore*.listAgentRunsForTurn`、`agentRoutes.mjs`（Turn 读模型 `linkedRunIds`）、`src/domain/agentPlanContract.ts` | `server/productStore.test.mjs`、`agentRoutes.test.mjs`、`botanicAgentRun.test.mjs`；权威边只在 Run 上，Turn 侧读时派生（Turn 记录会被整条覆盖写）；反查按 Turn 走存储查询，不得列全部 Run 再本地过滤 |
| 取消生成与成本停止 | `server/generationCancellation.mjs` | `generationCancelCapability.mjs`、`localCancelRegistry.mjs`、`agentRunEventBus.mjs`（`botanic-agent-cancels`）、`generationProcessor.mjs`、`worker.mjs`、`src/domain/generationCancelCopy.ts` | `server/generationCancellation.test.mjs`、`generationProcessor.test.mjs`、`src/domain/generationCancelCopy.test.ts`；判定按取消前状态算，出队只对未派发有效，广播是 Worker 就地 abort 的唯一途径；取消回执随任务落库，重复取消返回同一判定；无 Provider 支持远端停止计费，文案不得暗示取消等于省钱 |
| 版本化生产工作流 | `server/productionWorkflow.mjs` | `productionWorkflowRoutes.mjs`、`productionWorkflowAdvance.mjs`、`deliveryManifest.mjs`、`generationSubmissionService.mjs`、`src/domain/productionWorkflows.ts`、`src/lib/productionWorkflowApi.ts`、模板面板、Artifact Index | 已验证 Agent/画布操作可提升为版本；版本固定计划指纹、Skill/Memory 绑定与质量策略，新版本不影响进行中的运行；批量项标识来自业务身份（SKU/渠道/语言）而非位置；运行推进在 Worker 侧周期对账（`workflow.advance`），页面无人打开也能收口，但状态收敛沿用 `applyWorkflowItemResult` 那一份判定；交付清单只含人工批准过的候选，被排除项与原因一并给出，文件名冲突拒绝出包 |
| 批量变化 | `src/domain/batchVariations.ts` | `src/store/canvasBatchVariationActions.ts`、服务端 Processor | `batchVariations.test.ts`、Processor 测试；计划先限制总输出，Store 以有界并发协调独立子任务及恢复，各分支独立持久化 |
| Agent 对话分流 | `src/domain/agentChatContract.ts` | `src/lib/agentApi.ts`、`server/botanicAgentChat.mjs`、`server/agentWebResearch.mjs`、`webSearchProvider.mjs` | 对话测试；浏览器不发送图片字节或私有 URL；Tavily 为默认 `web_search`；URL 守卫与结果清洗只在服务端一份实现 |
| Agent 工具流式时间线 | `src/domain/agentTimeline.ts`、`src/domain/agentChatStream.ts` | `server/agentToolRuntime.mjs`、`/api/agent-chat/stream`、`/api/agent-intent/stream`、`/api/agent-plans/stream`、`AgentWorkspace.tsx` | 工具步仅在 `registry.execute` 前后 emit；禁止客户端 rAF 假进度；确认后 Run/分支投影进同款时间线 |
| Agent 计划和执行 | `src/domain/agentPlanContract.ts` | `agent.ts`、`agentVariations.ts`、`agentInstructionRouting.ts`、`server/botanicAgentPlanner.mjs`、`botanicAgentTools.mjs`、`agentRunGenerationService.mjs` | Agent Planner/Tool/Run 测试；无素材组时按已确认变体轴展开，张数由展开结果决定；Run 生成复用持久化幂等任务，外部行动默认确认；镜像行为由 `scripts/fixtures/agentVariationMirrorCases.json` 两侧对拍锁定 |
| Agent 多模态视觉 | `server/botanicAgentVision.mjs` | `botanicAgentChat.mjs`、`botanicAgentTurn.mjs`、`runtime.mjs`（`AGENT_VISION_MODEL`） | 视觉测试；引用图片优先直接随消息附给视觉模型（原生多模态），被网关拒绝时回退 caption 描述 + 文本模型；识别结果不进任何持久化实体 |
| 局部重绘（选区→蒙版） | `src/domain/regionMask.ts` | `server/regionMaskPng.mjs`、`imageOverlay.mjs`、`generationProvider.mjs`、`generationComposition.mjs`、`RegionMaskEditor.tsx`、`agent.ts`（`region_edit`） | regionMask/overlay/provider/composition 测试；选区是归一化纯数据；贴标识默认走 GPT Image 2 高质 edits，像素贴图层仅 `composeMode=overlay` |
| MCoT 创意分解 | `src/domain/agentCreativeComposition.ts` | `server/botanicAgentTurn.mjs`（`decompose_creative_brief`）、`AgentConversationMessage.tsx`（方案卡）、`agentVariations.ts`（条目分支）、`botanicAgentExecution.mjs` | 分解/持久化/执行测试；成套请求落成 `kind: composition` 消息与方案卡，刷新后从消息恢复「生成第 N 项 / 执行方案」；方案卡逐项/整套按钮绑定该条消息自己的 composition |
| Agent 可观测与评测 | `server/agentExecutionTrace.mjs` | `agentRunObservability.mjs`、`agentOperationalMetrics.mjs`、`agentEvalSuite.mjs`、`agentQualityEvaluation.mjs`、`scripts/evalGate.mjs`、`src/lib/agentApi.ts` | 稳定 traceId 串联 Run/Job/Artifact；只返回运维字段；**指标只消费既有结构化事件，不反过来改埋点**；比率无样本时返回 null 而不是 0；发布 Gate 只跑固定回归集（`scripts/fixtures/agentEvalRegressionSet.json`），不读生产素材也不调用 Provider，视觉判据记为无法验证；`pass` 只代表「检查过的没失败」，未验证的层单独列出 |
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
