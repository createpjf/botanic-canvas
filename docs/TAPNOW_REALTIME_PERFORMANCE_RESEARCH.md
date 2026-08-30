# TapNow 实时画布与性能研究

> 研究日期：2026-08-30
> 范围：仅使用 TapNow 官方产品页与官方文档（`tapnow.ai`、`docs.tapnow.ai`）。本文不把第三方文章、浏览器观察或 Botanic 现有实现当作 TapNow 事实。

## 结论摘要

TapNow 将创作组织为“Canvas + 独立节点 + 连接”的可持续工作空间：上传内容、文本、Agent 生成结果和研究结果都成为节点；连接表达生成或引用关系；大多数图像编辑会保留源节点并创建连接后的结果节点。团队画布是多人共同编辑的共享对象，官方明确描述了在线成员、视角跟随、编辑更新、云端保存状态和断线重连。

任务层面，TapNow 把 Agent 工作拆成读取上下文、确认、计划、执行、定向修订和交付六个阶段；Agent 忙碌时后续指令进入 Queue，按顺序执行。官方要求用户查看任务状态与错误，并在失败时缩小为单步、减少结果数或调整模型/设置。官方没有公开任务状态机、事件协议、持久化 schema、冲突解决算法、渲染策略、吞吐/延迟 SLA 或性能基准。

对 Botanic 最可借鉴的是产品语义与用户操作边界：

1. 把源素材、意图/约束、生成输出和后续派生结果保持为可追溯节点与边；源节点不被结果覆盖。
2. 把“实时协作状态”和“已保存状态”作为显式 UI 状态，并在重连期间阻止用户继续编辑。
3. 把 Agent 后续意图排队，而不是在当前任务上隐式并发；让用户能停止错误任务并保留失败上下文。
4. 用 History、节点搜索、标记、Library/Element/Template 降低大画布的查找和重复输入成本；这些是公开资料支持的工作流优化，不等同于底层渲染优化。

## 1. Canvas 节点如何组织

### 1.1 资料直接证实

官方文档将 Canvas 描述为由“节点和连接”构成：节点承载内容，连接展示内容之间的关系。节点类型示例包括上传的产品图、brief/script、图片/视频/音频结果，以及 Agent 整理的研究内容。每个节点保持独立，可以单独查看，也可以选择多个节点交给 Agent；生成新结果时源节点仍保留。

官方给出的典型链路是：

```text
产品图片节点 + 指令节点 → 图片结果节点 → 视频结果节点
```

上传文件不会自动触发生成；文件先成为独立节点，之后通过 `@` 引用或连接到下游节点。图像生成/编辑通常在源图旁边创建新的结果节点，并用连接表达来源；官方同时说明，视频的部分生成模式可能把结果放在当前视频节点中，因此结果物化方式可能随节点类型/模式不同。

TapNow 还把可复用内容拆成不同层次：

| 对象 | 官方定位 | 对 Botanic 的启示 |
| --- | --- | --- |
| Library | 保存可复用的图片、视频、音频等内容 | 素材对象与当前画布引用分开管理 |
| Element | 将同一人物、产品或角色的多种参考归组 | 对稳定参考集合建立一等对象，不重复上传 |
| Template | 保存一组节点、连接和生产步骤 | 复制工作流结构，不复制/覆盖原画布 |
| Playlist | 将多个视频节点编排到时间线 | 时间线是画布上的派生生产对象，源视频仍保留 |
| History | 保存生成内容，可将结果重新加回画布 | 历史产物不应依赖当前节点是否仍存在 |

来源： [Explore the canvas](https://docs.tapnow.ai/en/docs/canvas/explore-the-canvas)、[Upload files to the canvas](https://docs.tapnow.ai/en/docs/canvas/upload-files-to-the-canvas)、[Generate and edit images](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-images)、[Create and use elements](https://docs.tapnow.ai/en/docs/canvas/create-and-use-elements)、[Use library & templates](https://docs.tapnow.ai/en/docs/canvas/use-library-and-templates)、[Use playlists](https://docs.tapnow.ai/en/docs/canvas/use-playlists)、[Organize your canvas](https://docs.tapnow.ai/en/docs/canvas/organize-your-canvas)。

### 1.2 合理推断

- 连接至少承担了“输入血缘/引用关系”的展示与复用作用，而不是单纯视觉连线；这是由官方示例链路和“检查结果使用了哪些输入”的说明推断的。
- 源节点保留、结果新增的模式适合版本比较和局部重试，说明 TapNow 的用户模型偏向追加式派生，而非原地覆盖；这是产品行为层推断，不代表其数据库一定采用事件溯源或不可变记录。
- Library、Element、Template、History 的分层意图是减少大画布中的重复内容与重复上下文；官方没有说明这些对象的存储表、缓存或索引实现。

### 1.3 公开资料无法确认

- 节点/连接的实际 JSON schema、唯一 ID、版本号、排序字段和权限字段。
- 是否使用 React Flow、Yjs、WebSocket、WebRTC、SSE、CRDT、OT 或自研同步协议。
- 同一节点被多人同时移动/编辑时的冲突裁决、合并顺序和丢失更新策略。
- 大画布是否采用视口虚拟化、分块加载、LOD、图片缩略图缓存或增量渲染。

## 2. 实时协作与更新

### 2.1 资料直接证实

团队画布的官方说明包括：

- 个人画布移入团队空间后，团队成员可以打开同一张画布；大家看到同一批节点、连线和 Agent 产物，修改会保存到该画布。
- 多人同时打开时，页面显示当前在线成员；成员进入或离开时，协作列表会更新。
- “跟随”只同步视角，不会替用户选择、移动或编辑节点；这将 presence/viewport 与内容编辑分开。
- 有人移动节点、改文字或添加内容时，其他在线成员会看到更新；顶部保存状态在“Saving…”和“Saved to cloud”之间变化。
- 协作连接断开时，TapNow 尝试重连；显示“Reconnecting…”时官方建议暂停编辑，待恢复并显示已保存后再继续。
- 分享链接是只读视图；接收方可以查看、缩放和克隆，但不能编辑原画布。克隆后是独立画布，不接收原画布的后续更新。需要编辑同一画布时，应使用团队画布。

来源： [Create with your team](https://docs.tapnow.ai/en/docs/projects/create-with-your-team)（也有[中文官方页](https://docs.tapnow.ai/zh/docs/projects/create-with-your-team)）、[Share, view, and clone](https://docs.tapnow.ai/en/docs/projects/share-view-and-clone)、[Manage canvases](https://docs.tapnow.ai/en/docs/projects/manage-canvases)、[Troubleshoot issues](https://docs.tapnow.ai/en/docs/account/troubleshoot-issues)。

### 2.2 合理推断

- TapNow 至少存在“在线 presence/视角更新”和“画布内容更新”两类实时信息；官方把跟随视角明确限定为不改变内容，因此 Botanic 不应把 presence 事件当作图谱写入。
- “Saving… → Saved to cloud”与“断线期间暂停编辑”的组合，表明客户端需要区分本地交互态、同步中态、已持久化态和重连态；这是交互/可靠性推断，不足以证明服务端采用何种一致性模型。
- 团队画布与分享克隆是两种不同的协作语义：前者共享同一资源，后者复制资源并切断后续更新；Botanic 的共享编辑、只读审阅和模板复制也应保持边界清晰。

### 2.3 公开资料无法确认

- 更新是实时广播、短轮询、长轮询还是其他机制；官方只说明“看到更新”和“尝试重连”。
- 是否有离线编辑队列、客户端重放、幂等键、服务器版本检查或自动冲突提示。
- 在线成员状态的心跳周期、离开判定、跨实例传播和断线重连退避。
- 保存完成是否代表所有媒体/生成任务都已持久化，还是仅代表画布结构保存。

## 3. 任务、生成状态与 Agent 执行

### 3.1 资料直接证实

官方把 Agent 任务描述为六阶段：读取明确提供的 brief/附件/节点；确认交付物、受众、规格、期限和约束；计划将使用的 App、产物和审批点；执行生成/编辑/整理；针对特定结果修订并保留已批准细节；准备交付。高成本生成、发布或外部同步建议使用 Ask 模式。

Agent 运行期间，用户可以：

- 停止当前任务（例如目标或参考错误）；
- 在当前任务忙碌时继续发送指令，指令进入 Queue，当前任务完成后按发送顺序运行；
- 继续整理画布、检查引用和准备后续材料。

官方的失败处理要求用户读取精确错误和任务状态，检查网络、余额、输入引用，然后把任务缩小为一个生成步骤；也可以减少时长、结果数量、无关参考，或切换模型/设置。官方建议保留失败节点、输入、设置、任务状态、时间和画布链接，而不是立即删除失败节点或反复刷新/提交。

生成设置和状态也部分公开：图像生成前可查看模型、比例、尺寸、结果数量和预计 Tapies；结果完成后通常成为连接到源图的结果节点。视频文档说明 Tapies 是估算值，最终使用量按实际结算；某些视频任务完成后结果出现在当前视频节点，另一些流程创建新的连接节点。

对话层面，官方建议把已批准方向、脚本、角色标准、产品规则和最终设置保存为画布节点或文件，给节点标记“已批准/审核中/旧”，新对话只引用当前材料；被拒选项可以保留在历史中，但不要作为生成输入。分支会保留分支点以前的消息，并为新方向建立自己的历史。

来源： [TapNow Agent](https://docs.tapnow.ai/en/docs/agent/tapnow-agent)、[Manage conversations](https://docs.tapnow.ai/en/docs/agent/manage-conversations)、[Generate and edit images](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-images)、[Generate and edit video](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-video)、[Troubleshoot issues](https://docs.tapnow.ai/en/docs/account/troubleshoot-issues)。

### 3.2 合理推断

- Queue 是用户可见的串行意图层，至少应与当前运行任务区分；不能把“发送成功”误当作“生成已开始”或“已完成”。
- “停止错误任务”“保留失败节点”“只修订一个问题”的建议，指向可恢复、可诊断、局部重试的产品模型；但不能据此推断 TapNow 后端一定有 durable job、lease 或工作流引擎。
- “已批准/审核中/旧”标签与新对话只引用当前材料，体现了上下文选择与版本治理策略；这是官方工作流建议，不是公开的强制数据约束。

### 3.3 公开资料无法确认

- 任务状态枚举及状态转换，例如 queued/running/succeeded/failed/cancelled 是否真实存在。
- 任务 ID、生成 ID、幂等键、重试语义、取消是否能停止已提交的模型调用。
- 任务进度是百分比、阶段、日志还是仅有 loading/完成/失败。
- 生成结果写入画布的原子性、重复回调处理、服务端恢复和跨设备一致性。
- Agent 使用的模型路由、并发上限、队列调度、公平性和成本限额实现。

## 4. 性能优化：公开事实与边界

### 4.1 官方直接提供的用户层优化

官方没有发布“TapNow 性能优化指南”或性能数字，但文档提供了几类可观察的工作流优化：

| 优化方向 | 官方做法 | 证据性质 |
| --- | --- | --- |
| 大画布定位 | Node Search 可按标题、prompt、文本搜索，并按类型筛选；History 可按关键词/项目恢复；颜色 Pin 可聚合待处理、待审批、已交付节点；Minimap、Fit view、Follow 用于导航 | 直接证实 |
| 减少上下文重复 | 直接选择当前节点/多个节点，或用 `@` 引用；Element 将同一对象的参考归组；Library 保存可复用内容 | 直接证实 |
| 降低生成成本/等待 | 失败时减少时长、结果数、无关参考；图像 Outpainting 的 Low 用于快速构图试验；先小批量批准再批量生成；按模型选择分辨率 | 直接证实 |
| 降低流程并发风险 | Agent 忙碌时使用 Queue；避免相互矛盾的排队指令；Playlist 导出进行中不要重复启动 | 直接证实 |
| 缩小故障面 | 失败时减为一个输入、一个模型、一组设置或一个生成步骤；保留失败节点和错误上下文 | 直接证实 |

来源： [Organize your canvas](https://docs.tapnow.ai/en/docs/canvas/organize-your-canvas)、[Explore the canvas](https://docs.tapnow.ai/en/docs/canvas/explore-the-canvas)、[Create and use elements](https://docs.tapnow.ai/en/docs/canvas/create-and-use-elements)、[TapNow Agent](https://docs.tapnow.ai/en/docs/agent/tapnow-agent)、[Manage conversations](https://docs.tapnow.ai/en/docs/agent/manage-conversations)、[Generate and edit images](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-images)、[Download in batches](https://docs.tapnow.ai/en/docs/canvas/download-in-batches)。

### 4.2 面向 Botanic 的借鉴（推断，不是 TapNow 底层事实）

1. **把导航性能问题与渲染性能问题分开。** 先实现可搜索、可恢复、可标记、可缩放定位的节点索引；只有有真实测量证明时，才引入视口虚拟化或分块渲染。
2. **把生成等待与画布编辑解耦。** 生成任务应有独立状态来源；画布可以继续组织节点，但生成控制应明确显示排队、运行、完成、失败和取消边界。
3. **默认保留源与失败上下文。** 新结果形成独立输出和血缘边；失败节点保留输入与设置，便于诊断和同身份恢复。
4. **采用“一个主要修订/小批量先验收”的交互护栏。** 这能降低模型漂移、重复计费和大批量失败的成本，但不应伪造模型进度。
5. **用可复用引用集合减少重复传输与用户操作。** Element/Library/Template 的产品语义值得借鉴；其具体缓存、压缩和传输策略需要 Botanic 自己测量后决定。
6. **实时状态要可解释且可恢复。** 至少区分在线成员、视角跟随、内容同步中、已保存、重连中、任务执行中；断线时保护用户免于继续写入未确认状态。

## 5. 事实、推断与未知清单

### 资料直接证实

- Canvas 以独立节点承载内容，以连接表达关系；源节点通常保留。
- 团队空间支持同一画布的多人查看和编辑，在线成员列表会更新，视角可跟随。
- 内容变更会被其他在线参与者看到，并显示保存状态；断线会尝试重连，重连时官方建议暂停编辑。
- 分享链接只读；克隆是独立副本，不接收原画布后续更新。
- Agent 有确认/计划/执行/修订/交付阶段；忙碌时后续指令排队并按顺序执行。
- 失败排查依赖精确任务状态、错误、输入、设置和画布链接；官方建议缩小任务与减少结果/参考。
- Search、History、Pin、Library、Element、Template、Playlist 提供用户层面的组织和重复使用能力。

### 合理推断

- 节点/连接承载可追溯的创作血缘；结果偏向追加式派生。
- presence/视角事件和内容写入应是不同事件类别。
- Queue 应是独立于当前生成状态的意图队列；保存状态应独立于 HTTP 连接状态。
- Botanic 可以借鉴这些用户语义，但不能把它们升级为 TapNow 已证实的 CRDT、事件溯源或 durable workflow 设计。

### 无法从公开资料确认

- 底层同步协议、数据模型、版本/冲突机制、任务状态机和进度事件。
- 服务端持久化、队列、Provider 调用、恢复、重试和取消机制。
- 前端渲染、缩略图/媒体缓存、虚拟化、分块加载、内存占用和性能基准。
- 多人并发编辑的强一致性、最终一致性或具体丢失更新行为。

## 6. 对 Botanic 的最小落地建议

仅作为研究转化建议，不在本次任务中修改代码：

1. 继续以独立 `CanvasNode`/`Edge` 表达内容与血缘；生成输出不要覆盖源节点。
2. 继续让持久化 GenerationJob/Agent Run 成为任务权威，UI 的 loading、Toast 和实时连接只做观察层。
3. 将图谱实时更新、presence/viewport、任务事件分别建模；断线恢复从持久化版本/事件游标读取，而不是相信本地状态。
4. 在大画布优化前先测量：节点数量、首屏时间、拖拽帧率、同步延迟、重连恢复时间和媒体缩略图内存；没有数据就不引入复杂渲染架构。
5. 借鉴 TapNow 的“Queue + 小批量确认 + 保留失败上下文”，但保持 Botanic 已有的幂等、租约、恢复、Artifact 血缘和取消语义不变。

## 官方来源索引

- [TapNow 官方产品页](https://www.tapnow.ai/)
- [TapNow 官方文档首页](https://docs.tapnow.ai/en/docs)
- [Explore the canvas](https://docs.tapnow.ai/en/docs/canvas/explore-the-canvas)
- [Organize your canvas](https://docs.tapnow.ai/en/docs/canvas/organize-your-canvas)
- [Create with your team](https://docs.tapnow.ai/en/docs/projects/create-with-your-team)
- [Share, view, and clone](https://docs.tapnow.ai/en/docs/projects/share-view-and-clone)
- [Manage canvases](https://docs.tapnow.ai/en/docs/projects/manage-canvases)
- [TapNow Agent](https://docs.tapnow.ai/en/docs/agent/tapnow-agent)
- [Manage conversations](https://docs.tapnow.ai/en/docs/agent/manage-conversations)
- [Generate and edit images](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-images)
- [Generate and edit video](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-video)
- [Create and use elements](https://docs.tapnow.ai/en/docs/canvas/create-and-use-elements)
- [Use library & templates](https://docs.tapnow.ai/en/docs/canvas/use-library-and-templates)
- [Use playlists](https://docs.tapnow.ai/en/docs/canvas/use-playlists)
- [Troubleshoot issues](https://docs.tapnow.ai/en/docs/account/troubleshoot-issues)
- [Download in batches](https://docs.tapnow.ai/en/docs/canvas/download-in-batches)
