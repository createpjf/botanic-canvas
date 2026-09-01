# AIGC 产品底层架构调研

> 调研日期：2026-09-01
> 范围：Canva Apps/AI、Adobe Firefly、Runway、Figma multiplayer、OpenAI Images 公开官方资料。
> 目标：提炼异步生成任务、模型路由、媒体资产持久化、画布/协作同步、版本与可编辑性、错误恢复和可观测性等底层模式。
> 资料边界：只使用官方文档或官方帮助中心；没有读取本仓库或任何环境变量中的密钥、token、cookie、`.env` 实值。

## 结论摘要

1. **生成任务应是持久化资源，不应绑定浏览器请求。** Adobe Firefly 明确返回 `jobId/statusUrl/cancelUrl`，Runway 返回可轮询的 task；OpenAI Images 也支持 SSE 增量事件，但这更适合作为观察通道。官方事实见 [Firefly 异步 API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)、[Runway SDK task polling](https://docs.dev.runwayml.com/api-details/sdks/)、[OpenAI Images streaming](https://platform.openai.com/docs/api-reference/images-streaming/image_generation/partial_image)。**架构推断：** 服务端应保存任务快照、状态、尝试/租约、输出引用，客户端断线后重新观察同一任务。
2. **模型路由至少要记录“能力/模型/版本/参数”的不可变快照。** Firefly 允许通过 `customModelId` 与 `x-model-version` 选择品牌定制模型；Runway 在创建任务时显式传入模型；OpenAI 将分析与生成分为不同 endpoint/工具。官方事实见 [Firefly Custom Models](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/)、[Runway SDK](https://docs.dev.runwayml.com/api-details/sdks/)、[OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)。**架构推断：** 路由决策不能只保留一个可变 provider 名称，应保留 resolved provider、model、model version、能力、输入引用和计费/质量策略。
3. **媒体资产是独立持久化对象，画布只保存可授权的稳定引用。** Canva 的 `upload` 明确把资产写入用户私有媒体库，并要求缩略图；AI 生成或显著修改还必须带 `aiDisclosure: "app_generated"`。Firefly 的结果是 URL，且输入 URL 有允许的存储域限制。官方事实见 [Canva 资产上传](https://www.canva.dev/docs/apps/uploading-assets/)、[Canva upload API](https://www.canva.dev/docs/apps/api/latest/asset-upload/)、[Firefly usage notes](https://developer.adobe.com/firefly-services/docs/firefly-api/getting-started/usage-notes/)。**架构推断：** 生成输出应先物化为媒体记录，再被画布节点、Artifact/历史等多个投影引用；不能把临时预签名 URL 当作永久资产身份。
4. **“实时协作状态”和“业务事实”应分层。** Figma 的官方资料确认同一 live file 可同时编辑，并且离线时不能接收协作者更新；版本历史、分支和合并另有持久化语义。官方事实见 [Figma design files](https://help.figma.com/hc/en-us/articles/15297425105303-Explore-design-files)、[Figma offline](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma)。**架构推断：** WebSocket/SSE/CRDT 只负责传递变更和在线状态；任务状态、媒体、审计和历史血缘仍由数据库/对象存储权威持有。
5. **版本与可编辑性是产品数据模型，不是导出格式的附属能力。** Figma 版本可浏览、恢复、复制，分支可独立编辑后合并；Canva Apps 的 Design Editor intent 让应用把结果写入 Canva 编辑器，而上传资产本身仍是媒体对象。官方事实见 [Figma version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)、[Figma branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching)、[Canva Generative AI app template](https://www.canva.dev/docs/apps/app-templates/generative-ai/)。**架构推断：** 生成结果至少要同时保存原始 recipe、输入血缘、输出媒体和可编辑结构；只有 PNG/JPEG 的“结果”无法支持可解释重生成或局部编辑。
6. **恢复必须区分“可安全重试”和“结果未知”。** Runway 官方建议通过 `AbortSignal` 取消轮询并警告不要无限等待；Adobe 返回 `failed` 与错误信息，且部分结果/状态 URL 有生命周期。官方事实见 [Runway SDK](https://docs.dev.runwayml.com/api-details/sdks/)、[Firefly 异步 API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)、[Adobe Substance async jobs](https://developer.adobe.com/firefly-services/docs/s3dapi/getting-started/asynchronous-jobs/)。**架构推断：** 网络超时不应直接变成失败或自动二次扣费；应有 queued/running/succeeded/failed/cancelled/uncertain 等状态，并通过幂等键和 provider 查询收口。
7. **可观测性应围绕任务生命周期和资源血缘，而不是只记录请求日志。** Firefly 将 job ID 明确用于日志，Runway 将 task ID 用于 bookkeeping，OpenAI streaming 事件提供完成状态与 usage。官方事实见 [Firefly 异步 API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)、[Runway SDK](https://docs.dev.runwayml.com/api-details/sdks/)、[OpenAI image streaming reference](https://platform.openai.com/docs/api-reference/images-streaming/image_generation/partial_image)。**架构推断：** 至少关联 `requestId → jobId/taskId → attempt → assetId → canvasNodeId/version`，记录阶段耗时、重试次数、错误类别、provider/model、输出计数和用量；禁止记录 Authorization、Cookie、原始私有媒体 URL 或完整 prompt（除非有明确治理边界）。

## 按能力拆解

### 1. 异步生成任务

| 官方确认 | 直接资料 | 对底层设计的含义（推断） |
| --- | --- | --- |
| Firefly 的异步请求快速返回 `jobId`、状态 URL 和取消 URL；客户端轮询直到 `succeeded`/`failed`。 | [Using the Asynchronous Adobe Firefly APIs](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis) | 提交接口和执行 Worker 解耦；取消、状态读取和结果下载都围绕稳定 job identity，而不是 HTTP 生命周期。 |
| Runway 的生成方法返回 task，SDK 提供 `tasks.retrieve`、`waitForTaskOutput`，并建议避免固定间隔 `setInterval`。 | [Runway SDK task polling](https://docs.dev.runwayml.com/api-details/sdks/) | 轮询器应使用退避/截止时间/取消信号；浏览器可以订阅自己的 observer，不应持有执行权。 |
| Adobe Substance 任务以 `202 Accepted` 返回，状态包含 `not_started`、`running`、`succeeded`、`failed`。 | [Adobe asynchronous jobs](https://developer.adobe.com/firefly-services/docs/s3dapi/getting-started/asynchronous-jobs/) | “已接受”不能显示为“已完成”；队列态和执行态必须可区分，状态机应可被恢复扫描。 |
| OpenAI Images streaming 会发送 partial/completed 事件，并可返回 image token usage。 | [OpenAI Images streaming reference](https://platform.openai.com/docs/api-reference/images-streaming/image_generation/partial_image) | 流式预览是增量读模型；最终媒体与任务终态仍应独立落库，断线后从终态/事件游标恢复。 |

推荐最小状态机：`queued → running → succeeded | failed | cancelled | uncertain`。其中 `uncertain` 只表示调用结果无法安全判断，不等于失败，也不应自动重跑可能已计费的 provider 调用。

### 2. 模型路由与执行快照

| 官方确认 | 直接资料 | 对底层设计的含义（推断） |
| --- | --- | --- |
| Firefly Custom Models 使用 Adobe 托管的模型资产 ID，并用模型版本选择推理版本；模型可按 subject/style 组织。 | [Firefly Custom Models overview](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/) | 模型注册表不能只存 display name；要存稳定模型 ID、版本、训练/能力类型与适用输入。 |
| Runway 的创建调用显式传入 `model`，例如 `gen4_image`。 | [Runway SDK examples](https://docs.dev.runwayml.com/api-details/sdks/) | 一次任务要冻结实际解析出的模型，不要在任务执行中跟随“当前默认模型”漂移。 |
| OpenAI 区分 Responses API 的图像工具和 Images API，并说明 GPT Image 模型可生成或编辑。 | [OpenAI Images and vision guide](https://developers.openai.com/api/docs/guides/images-vision) | 路由层应先按能力（生成/编辑/分析/视频）选 endpoint，再按策略选择模型；产品领域不应直接拼 provider 请求。 |

建议执行快照字段：`capability`、`provider`、`model`、`modelVersion`、`promptVersion`、输入资产 ID、尺寸/比例、质量、种子（如适用）、安全策略版本、路由原因、预算与幂等键。上述字段是基于资料的架构建议，不是厂商统一标准。

### 3. 媒体资产持久化与血缘

Canva 官方 `upload` 的语义是“上传到用户私有媒体库”，并支持 `parentRef`、媒体类型、缩略图、尺寸和 AI disclosure；AI 生成、风格改变、合成、扩图、生成式背景等场景需要声明 `app_generated`。[Canva assets](https://www.canva.dev/docs/apps/uploading-assets/)；[Canva upload API](https://www.canva.dev/docs/apps/api/latest/asset-upload/)

Adobe Firefly 的输出示例包含尺寸、seed、outputs 和图片 URL；官方同时说明某些输入 URL 只接受允许的存储域，且结果 URL 是供取回的资源地址。[Firefly async API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)；[Firefly usage notes](https://developer.adobe.com/firefly-services/docs/firefly-api/getting-started/usage-notes/)

**基于资料的推断：** 资产管线应拆成四层：

1. `AssetRecord`：项目/用户归属、媒体类型、尺寸、mime、AI disclosure、权限和生命周期；
2. `MediaObject`：对象存储 key、缩略图/预览、校验和、来源 provider 和外部 ID；
3. `Derivation`：输入资产、recipe、模型版本、父子关系和变换类型；
4. `Reference`：画布节点、Artifact、版本或导出任务对资产的引用。

这样画布删除只删除引用，不会误删仍被历史版本或 Artifact 使用的媒体。这个分层是研究推断，官方资料没有公开各平台的完整内部数据库 schema。

### 4. 画布、多人协作与同步

Figma 官方确认设计文件是 live file，多人可以同时在同一文件工作；断网时可以继续进行部分本地编辑，但不能接收其他协作者更新，也不能使用 multiplayer 功能。[Explore design files](https://help.figma.com/hc/en-us/articles/15297425105303-Explore-design-files)；[What can I do offline](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma)

**基于资料的推断：** AIGC 画布应把同步对象分为：

- 可合并的结构变更：节点、连线、位置、文本、编辑参数；
- 不应由 CRDT 决定的业务状态：GenerationJob、媒体上传、审核结论、计费、Artifact 血缘；
- 本地临时状态：选择、视口、拖拽中的预览、连接状态。

同步协议至少需要项目权限、客户端游标/版本、变更序列、冲突响应、离线 outbox、重连补读和幂等 mutation ID。上述具体协议不是 Figma 公开的内部实现，而是从其 live/offline 行为推导出的通用设计要求。

### 5. 版本、分支和可编辑性

Figma 版本历史支持查看时间点、恢复、复制、分享特定版本；官方还说明会自动保存 checkpoint，并在断网或崩溃时加入 autosave checkpoint。[Figma version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)

Figma branching 是主文件的隔离副本，可独立修改、请求评审、合并；创建分支和合并都会写入版本历史。[Figma branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching)

**基于资料的推断：** AIGC 产品应把“重新生成”和“编辑当前结果”建模为不同操作：

- 重新生成：新 attempt/新输出，保留原始结果和 recipe；
- 编辑：从某个可编辑版本派生新版本，保留输入节点与编辑操作；
- 接受候选：改变当前工作版本的引用，不删除未选候选；
- 分支：隔离画布变更，合并时按版本/节点冲突处理。

如果 provider 只返回栅格结果，产品仍应保存可解释的 recipe 和父资产；否则只能“再次生成相似图”，不能保证可追溯、可局部编辑或恢复到某个确定版本。

### 6. 错误恢复、取消和重试

Runway 官方建议给等待 task output 的流程提供 `AbortSignal`，并指出禁用超时可能在并发达到上限或服务中断时造成问题。[Runway SDK](https://docs.dev.runwayml.com/api-details/sdks/)

Firefly 官方返回 `failed` 状态，并提供错误结果；其异步 API 还提供取消 URL。[Firefly async API](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)

**基于资料的推断：** 恢复器需要：

- 用稳定 `idempotencyKey` 识别同一次提交；
- 以数据库状态和 lease/heartbeat 判断孤儿任务，而不是依赖进程内 Promise；
- provider 已接受但响应丢失时先查询/对账，再决定失败或 `uncertain`；
- 只对明确可重试的验证错误、网络连接前失败、限流等重试；
- 对已可能执行的昂贵调用禁止静默换 key 重跑；
- 终态先写任务，再写画布/Artifact 等投影，投影失败可单独补偿。

### 7. 可观测性与安全边界

Firefly 文档建议用 job ID 做 logging；Runway 文档把 task ID 描述为 bookkeeping 用途；OpenAI streaming 的 completed 事件带 usage 字段。[Firefly](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)；[Runway](https://docs.dev.runwayml.com/api-details/sdks/)；[OpenAI](https://platform.openai.com/docs/api-reference/images-streaming/image_generation/partial_image)

**基于资料的推断：** 推荐的最小事件模型如下：

```text
request.accepted
  → job.claimed / task.submitted
  → provider.started
  → output.received
  → asset.materialized
  → projection.committed
  → job.succeeded
```

每个事件应有稳定实体 ID、单调序号、时间、阶段、provider/model、耗时、重试次数、输出数量和受控错误码。指标应至少覆盖：接受到开始延迟、provider latency、成功率、失败/未知结果率、取消收敛时间、恢复次数、资产物化失败率、投影落后量和单位输出成本。

日志/trace 不应包含 Authorization、Cookie、token、lease、幂等密钥、完整私有 URL 或未经治理的原始 prompt/模型响应。该隐私限制是本研究的安全设计建议，不声称是上述厂商公开的统一日志规范。

## 对 Botanic 当前架构的映射

仓库现有产品文档已经采用与上述研究一致的核心分层：`GenerationJob` 作为生成权威、`MediaObject/AssetRecord` 作为媒体对象、`Canvas Graph Revision` 作为画布协作版本、`Artifact Index` 作为历史血缘目录，且 Agent Turn/Run 与浏览器观察连接分离。详见 [PRODUCT_ARCHITECTURE.md](../PRODUCT_ARCHITECTURE.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)、[ADR 0002](../adr/0002-agent-entity-persistence.md)、[ADR 0003](../adr/0003-project-scoped-artifact-index.md)、[ADR 0004](../adr/0004-agent-turn-runtime.md)、[ADR 0009](../adr/0009-agent-distributed-tracing.md)。

**研究结论：** 当前方向不需要新增第二套 AIGC 任务状态机。后续若继续演进，优先验证以下边界是否始终成立：

1. provider 任务丢响应后能否通过同一任务身份对账，而不是重复计费；
2. 媒体物化、画布节点和 Artifact 投影是否可独立恢复且幂等；
3. 协作变更冲突是否不会覆盖新生成结果；
4. 可编辑版本是否保留 recipe、输入血缘和父资产；
5. trace/log 是否能定位一次生成全链路，同时不泄露敏感内容。

## 未确认事项与研究边界

- Canva、Adobe、Runway、Figma、OpenAI 均未在本组公开资料中完整披露其内部队列、数据库、CRDT 算法、租约实现或跨区域故障转移方案；相关部分均标为“基于资料的推断”。
- Figma “multiplayer”公开帮助资料描述产品行为，不等同于官方确认使用某一种 CRDT/OT 实现。
- OpenAI Images streaming 描述实时事件，不等同于公开承诺一个长时、可恢复的后台 generation job；若需要断线可恢复，应由产品自己的任务层补足。
- 本稿没有进行真实 provider 调用、生产环境验证、性能压测或代码修改。

## 官方资料索引

1. [Canva Apps — Assets](https://www.canva.dev/docs/apps/uploading-assets/)
2. [Canva Apps — upload API](https://www.canva.dev/docs/apps/api/latest/asset-upload/)
3. [Canva Apps — Generative AI app template](https://www.canva.dev/docs/apps/app-templates/generative-ai/)
4. [Adobe Firefly — asynchronous APIs](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis)
5. [Adobe Firefly — Custom Models](https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/custom-models/)
6. [Adobe Firefly — usage notes](https://developer.adobe.com/firefly-services/docs/firefly-api/getting-started/usage-notes/)
7. [Adobe Substance 3D — asynchronous jobs](https://developer.adobe.com/firefly-services/docs/s3dapi/getting-started/asynchronous-jobs/)
8. [Runway — SDKs and task polling](https://docs.dev.runwayml.com/api-details/sdks/)
9. [Figma — explore design files](https://help.figma.com/hc/en-us/articles/15297425105303-Explore-design-files)
10. [Figma — offline behavior](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma)
11. [Figma — version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)
12. [Figma — branching](https://help.figma.com/hc/en-us/articles/360063144053-Guide-to-branching)
13. [OpenAI — Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
14. [OpenAI — Images streaming reference](https://platform.openai.com/docs/api-reference/images-streaming/image_generation/partial_image)
