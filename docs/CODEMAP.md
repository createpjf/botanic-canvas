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
| 结果评审与人工决定 | `server/agentReviewTask.mjs` | `agentReviewDeterministic.mjs`、`agentReviewVision.mjs`、`agentReviewRunner.mjs`、`agentReviewService.mjs`、`mediaSpec.mjs`、`derivedTaskQueue.mjs`（`review.run`）、`agentRoutes.mjs`（评审任务读取与决定） | `server/agentReview*.test.mjs`、`mediaSpec.test.mjs`；硬规格走确定性层不调模型，第 1 层 fail 不进第 2 层；rubric 来自 `CompiledCreativePlan.qualityPolicy` 并记指纹；覆盖策略与被跳过数必须可见，不静默截断；每个候选都有结论才能 completed；评审从不改写 Run/Job 状态；自动结论一律停在待人工；视觉层判据全部来自计划快照的质量策略，模型漏答判无法验证而非通过；界面展示规则在 `src/domain/agentReviewPresentation.ts`（覆盖摘要必带被跳过数、`未验证` 与 `不符合` 是两个词、无人工决定即「待你决定」），组件只渲染 |
| 交付包打包 | `server/zipArchive.mjs`、`server/deliveryPackage.mjs` | `deliveryManifest.mjs`（装哪些文件完全由清单决定）、`productionWorkflowRoutes.mjs`（`/production-workflow-runs/:id/package`）、`mediaService.readGenerationInput`（带项目归属校验）、`src/lib/productionWorkflowApi.ts` | `server/zipArchive.test.mjs`、`deliveryPackage.test.mjs`；仓库无 zip 依赖故手写，与 `mediaSpec`/`imageOverlay` 同一路数，但更危险 —— 中央目录写错的表现**不是报错，是交付给客户的包损坏**，因此测试里的读取器按规范独立重写（用自己的读法验自己的写法只能证明两边一致），并已用 Python `zipfile.testzip()` 与系统 `unzip -t` 交叉验证；**只用 store 不压缩**（交付物本身已压缩，deflate 收益≈0，却引入压缩流状态与 data descriptor 一整类可写错的东西）；逐文件缓冲因此 CRC 与长度在写头前就已知，峰值内存是最大单文件而非整包；条目数/大小/偏移越过 32 位边界自动切 ZIP64（视频批量很容易超 4GB，静默溢出会得到字段回绕、看似正常却解不开的包）；置 UTF-8 标志位否则中文名乱码；Zip Slip 与同名条目**报错而非自动改名**（改名会让文件名与清单对不上）；**取不到字节让整个包失败**，少几张的包比报错糟得多 —— 报错能重试，收到包的人不会去数够不够；清单本身以 `manifest.json` 进包；响应头在写第一个字节前发出，因此清单级冲突必须在开始写之前暴露，写到一半失败只能 `destroy` 连接而不是正常结束（正常结束会让客户端拿到「下载成功」的截断 zip） |
| Campaign 矩阵与跨输出一致性 | `src/domain/campaignMatrix.ts`、`server/campaignConsistency.mjs` | `src/domain/workflowBatchInput.ts`（CSV 导入，同一批量项形状）、`deliveryManifest.mjs`（清单带一致性结论）、`productionWorkflow.mjs` | `src/domain/campaignMatrix.test.ts`、`server/campaignConsistency.test.mjs`、`deliveryManifest.test.mjs`；张数必须在提交**前**能算出（`campaignMatrixSize` 不展开即可给出），超上限**拒绝并说明**而不是截断到上限（截断会让用户以为整批都提交了）；重复取值去重但报告，否则同一业务标识出现两次、「只重试失败的 2 项」会对不上号；Reference Pack 与品牌上下文全批共享而不是逐项复制；一致性 Gate 只查**能被证明**的维度（参考、品牌指纹、计划指纹、模型），比例与分辨率按设计本来就会变、默认不参与判定，否则每个正常 Campaign 都报警；缺记录判「无法验证」而不是默认通过；不一致时给出分成了哪几组、各含哪些 Artifact；Gate **报告而不阻断**出包，但清单上必须写明 |
| 品牌规则（Brand Kit） | `server/brandKit.mjs`、`src/domain/brandKitPresentation.ts`（界面展示） | `botanicCreativePlanCompiler.mjs`（编译进执行契约 + 质量策略）、`creativePlanResolver.mjs`（`resolveRunBrandKit`，Resolve 侧读权威状态）、`agentReviewVision.mjs`（逐条判据带规则原文）、`agentReviewTask.mjs`（品牌判据进策略指纹）、`libraryRoutes.mjs`（`/api/brand-kits`、`/api/projects/:id/brand-kit`）、`agentRunGenerationService.mjs` | `server/brandKit.test.mjs`、`brandKitPipeline.test.mjs`、`src/domain/brandKitPresentation.test.ts`；三层按 `global < project < run` 就近覆盖，`facet + key` 是槽位，同层同槽位重复**报错**不静默保留其一；多品牌按 `brandId` 硬校验，绑错品牌报错而不是过滤成空品牌；手册解析产出一律 `proposed`，`document_import` 未经确认不得激活，判不出维度的留空 `facet` 因而无法通过校验；`must` 不满足才判不合格、`should` 不满足是让步，该判定只有 `isBrandConcession` 一份实现，评审汇总与品牌 QA 摘要共用；品牌规则进计划指纹与评审任务指纹，但**无品牌判据时该键整个缺席**，否则存量策略指纹全变、已评审完的 Run 会再评一次；界面不重算覆盖优先级，解析一律由服务端做 |
| Subagent 治理 | `server/agentSubtask.mjs`、`server/agentSubtaskScheduler.mjs` | `agentSubagentRunner.mjs`（模型执行器）、`botanicAgentTools.mjs`（`subagent_research` 派发工具）、`botanicAgentPlanner.mjs`（注入执行器）、`canvasRegionLease.mjs`（区域租约与候选终态）、`runtime.mjs`（`AGENT_SUBAGENT_MODEL`） | `server/agentSubtask.test.mjs`、`agentSubtaskScheduler.test.mjs`、`agentSubtaskDispatch.test.mjs`、`canvasRegionLease.test.mjs`；子任务**不能持有需要确认或会产生终态的工具**，判定取自注册表里工具自己的声明（`requiresConfirmation` / `terminal` / `risk`），不另列名单 —— 审批凭据签给 (userId, toolCallId, 参数摘要)，子 Agent 三样都没有；`web_search` 这类外呼但只读、根 Agent 也无需确认的工具是允许的，禁掉只会让调研退化成瞎编；预算、超时、白名单、输出 Schema 四样必填，缺一即存在一条没有上限的路径；产出只能是 `proposal` / `artifact_candidate`，夹带 `canvasCommands`/`writeback`/`artifacts` 按违约终止而非忽略；未声明字段直接丢弃不透传；子任务标识由 (父轮次, 角色, 输入, 白名单, Schema) 指纹派生，重放命中已结算记录直接复用，因此不重复外呼也不产生第二个终态决定；一路失败不取消其余；扇出摘要必须把终止数与完成数并列；模型未显式配置时派发工具整个不注册 |
| 画布区域租约与候选终态 | `server/canvasRegionLease.mjs` | `agentSubtask.mjs`（多 Agent 并发编排）、项目文档 `writeProject` 的版本条件更新 | `server/canvasRegionLease.test.mjs`；租约是**咨询性**的，不替代持久化层的条件更新（只靠内存租约在多进程部署下失效）；区域标识由排序后的节点集合派生，换个书写顺序拿不到「另一个区域」；相交即冲突、不相交可并行（整文档版本冲突会让不相干的改动白跑）；同一持有者重复申请是续期不是冲突（重试是正常路径）；只有持有者能释放；落地前版本漂移返回 `requiresRevalidation` 而不是直接失败 —— 直接失败会把「有人改了画布另一角」变成「你这次编排作废」；候选终态不是文档写入，因此单独按 (候选, 决定) 幂等：同一决定重放是无操作，不同决定冲突 |
| 项目记忆治理 | `server/botanicAgentMemory.mjs`、`src/domain/agentMemoryComparison.ts`（界面对比） | `botanicAgentPersistence.mjs`（`validateAgentMemoryEntity`）、`agentRoutes.mjs`（规划输入）、`botanicAgentContextTools.mjs`（`project_memory_search`）、`productionWorkflow.mjs`（`resolveWorkflowBrandRules`） | `server/botanicAgentMemory.test.mjs`、`botanicAgentPersistence.test.mjs`；**项目内只允许一条读取路径**，构造 Prompt/Plan/工作流定义都必须经选择器；`status` 是激活开关、`confidence` 是可信程度，不得互相顶替；active 需人工来源或已确认证据；已确认的人工规则不因措辞未命中而落选；冲突记忆不同时进同一 Plan 且落选可见 |
| Skill 版本与生命周期 | `server/botanicAgentSkill.mjs` | `botanicAgentTools.mjs`（内置 Skill 版本、`botanicAgentSkillRisk` 取自称与 Manifest 的较高者、挂载时解析依赖）、`agentRoutes.mjs`（创建时按当前注册表校验 Manifest）、`agentRoutes.mjs`（创建批准人、绑定固定版本）、`src/domain/agent.ts` | `server/botanicAgentSkill.test.mjs`、`agentRoutes.test.mjs`；已发布版本不原位改写，修改追加新版本且历史版本可按版本取回；治理状态由流程产生，`published` 必须有批准人；Run 绑定的 version 与 contentHash 必填，内置 Skill 不例外；**Manifest（Epic 6 遗留项，消费方由 Epic 11 提供）**：`capabilities` 此前是没人核对的**自称** —— 声明 `read` 就直接应用、不需要用户确认，而没有任何东西约束这个声明。`manifest.toolAllowlist` 让风险取「自称」与「白名单里工具在注册表中的真实风险」两者**较高者**，少报能力不再能换来跳过确认；白名单里查不到的工具按最高风险处理（与「未知能力按最高风险」同一判断）；少报在**创建时**直接拒绝（`AGENT_SKILL_CAPABILITY_UNDERSTATED`），运行时仍取最大值兜底，因为存量 Skill 没有 Manifest；依赖缺失/已弃用/指定版本取不到的 Skill **仍然挂载但带 `dependencyIssues`**，简报明说规则不完整 —— 静默丢掉会让用户以为规则在生效，静默照用会让 Agent 拿着少半截的约束创作；自依赖与环在解析时挡住；有意**不做** `inputSchema`/`outputSchema`：Skill 产出是指令文本而非结构化输出，至今没有消费方 |
| 计划 Resolve 与 Compile | `server/creativePlanResolver.mjs` | `botanicCreativePlanCompiler.mjs`、`botanicAgentExecution.mjs`、`generationSubmissionService.mjs`、`botanicAgentRun.mjs`（`compiledPlanProvenance`） | `server/creativePlanResolver.test.mjs`、`botanicCreativePlanCompiler.test.mjs`、`botanicAgentExecution.test.mjs`；Resolve 是唯一读权威文档的一侧并抛阶段化错误，Compile 保持纯；plan 级指纹只能由 Resolve 统一计算，分支指纹由它派生；确认后的快照落在 Run 上，重试只读快照；快照与实际解析出的引用身份不一致时阻断而不换素材顶替 |
| Turn 与 Run 关联 | `run.turnId`（`botanicAgentRun.mjs`） | `productStore*.listAgentRunsForTurn`、`agentRoutes.mjs`（Turn 读模型 `linkedRunIds`）、`src/domain/agentPlanContract.ts` | `server/productStore.test.mjs`、`agentRoutes.test.mjs`、`botanicAgentRun.test.mjs`；权威边只在 Run 上，Turn 侧读时派生（Turn 记录会被整条覆盖写）；反查按 Turn 走存储查询，不得列全部 Run 再本地过滤 |
| 取消生成与成本停止 | `server/generationCancellation.mjs` | `generationCancelCapability.mjs`、`localCancelRegistry.mjs`、`agentRunEventBus.mjs`（`botanic-agent-cancels`）、`generationProcessor.mjs`、`worker.mjs`、`src/domain/generationCancelCopy.ts` | `server/generationCancellation.test.mjs`、`generationProcessor.test.mjs`、`src/domain/generationCancelCopy.test.ts`；判定按取消前状态算，出队只对未派发有效，广播是 Worker 就地 abort 的唯一途径；取消回执随任务落库，重复取消返回同一判定；无 Provider 支持远端停止计费，文案不得暗示取消等于省钱 |
| 版本化生产工作流 | `server/productionWorkflow.mjs` | `productionWorkflowRoutes.mjs`、`productionWorkflowAdvance.mjs`、`deliveryManifest.mjs`、`src/domain/workflowBatchInput.ts`（CSV 导入 + 表格编辑）、`generationSubmissionService.mjs`、`src/domain/productionWorkflows.ts`、`src/lib/productionWorkflowApi.ts`、模板面板、Artifact Index | 已验证 Agent/画布操作可提升为版本；版本固定计划指纹、Skill/Memory 绑定与质量策略，新版本不影响进行中的运行；批量项标识来自业务身份（SKU/渠道/语言）而非位置；运行推进在 Worker 侧周期对账（`workflow.advance`），页面无人打开也能收口，但状态收敛沿用 `applyWorkflowItemResult` 那一份判定；交付清单只含人工批准过的候选，被排除项与原因一并给出，文件名冲突拒绝出包；版本固定的品牌规则以执行契约前缀进入 Prompt（不拼进画面描述）；CSV 导入自己解析引号与换行，列数不符与重复标识**报告**而不是补空或丢弃；**批量输入界面**（`CanvasWorkspacePanels` 的 `production-batch`）此前发的一直是写死的 `items: [{ id: 'item-1' }]`，整条批量能力从界面上用不到 —— 现在 CSV 粘贴导入 + 可增删改的表格，编辑时**实时**重查重复标识并逐行标出原因（只在提交时报「有错」的话，用户不知道该改哪一行，而提交之后钱已经花出去了）；清空单元格删除该键而不留空串（空串会被当成「声明了该字段且值为空」，插值出空白 Prompt）；一行都没有时退回单项运行，不逼用户先填一行空表格 |
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
