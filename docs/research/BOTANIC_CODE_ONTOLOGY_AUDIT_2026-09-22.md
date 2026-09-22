# Botanic 代码、逻辑与 Ontology 决策层审查

日期：2026-09-22。代码基线：`c7de68ef114970eefcb80cdd7ca4388973a01944`。

> 状态更新：以下第 1–5 节保留最初只读审查记录；用户随后授权修复 F1–F3，修复及当前验证结果见第 6 节。原始问题的行号对应上述基线。

## 结论

需要优化，但优先级不是换主模型或重写 Agent Runtime，而是修复上下文进入模型前的语义损失。

本轮确认了三个可复现问题：Memory 治理字段被安全投影丢弃、Ontology 截断吞掉显式引用、Artifact 搜索在过滤前截断。它们足以让正确的实体、规则和历史结果不能被正确使用；接入分类模型不能修复这些问题。

建议保留现有 durable Turn → Plan → 确认 → Resolve/Compile → Run → GenerationJob → Canvas/Artifact 的执行主干。决策分类器可作为有界、可弃权的语义建议源，不可成为权限、批准、身份、幂等或状态机的权威。

这是横跨主要产品链路的只读代码审查，不是逐行审计所有文件，也不是生产安全认证。没有修改业务代码、AGENTS.md、数据库或外部配置；没有运行真实生成、视觉评审或候选分类模型。本地测试不证明生产迁移、真实 UI 或线上模型质量。

## 1. 覆盖范围与应保留的设计

| 层面 | 本轮核对的关键入口 | 判断 |
| --- | --- | --- |
| 产品与领域 | `docs/PRODUCT_ARCHITECTURE.md`、ADR 0005/0006、代码地图相关条目 | 已区分执行、评审、人工批准，方向正确；勿再合并成单一“成功” |
| UI / 应用编排 | `src/domain/agentInstructionRouting.ts:83`、`src/features/agent/AgentWorkspace.tsx:1918` | 新消息已统一 durable Turn；UI 内仍有大量分支编排，宜沿现有接口渐进收缩 |
| 请求持久化与恢复 | `server/agentRuntimeRequest.mjs:79`、`server/agent/turn/agentTurnSubmission.mjs:118` | 正式与兼容入口共享 Runtime，提交身份及 Message link 有明确边界，不应另建分类器专用请求链 |
| 上下文 / Memory / Ontology | `botanicAgentOntology.mjs`、`botanicAgentContextTools.mjs`、`botanicAgentMemory.mjs` | 发现 F1/F2；领域规则存在，但调用链没有完整保留它们 |
| 图谱与历史检索 | `server/canvas/canvasAgentQuery.mjs`、`canvasAgentSemanticSearch.mjs`、`agentOperationalReaders.mjs` | 已有安全节点、关系角色、游标和降级协议；应复用。历史 Artifact 搜索存在 F3 |
| 计划、执行与结果 | `server/agent/semantic/creativePlanResolver.mjs:301`、`server/generation/generationProcessor.mjs:925` | 确认快照、参考绑定、Job 先落库再补偿 Canvas/Artifact 值得保留 |
| 评审与人工决策 | `server/agent/review/agentReviewDecisionService.mjs:55`、ADR 0006 | 原子重试与缺身份 fail-closed 有意义，不能被分类分数替代 |
| 画布同步与 Adapter | `server/canvas/canvasCollaborationRoom.mjs:489`、三种 Store 的相关读路径 | durable append 与 revision 边界存在；本轮不是多实例数据库/浏览器实测 |
| 验证 | `package.json:10`、`scripts/evalGate.mjs:26` | 本地测试通过不等于语义调用链无缺陷；确定性 Eval 与模型效果需要分开衡量 |

具体应保留的实现：

- `agentTurnSubmission.mjs:118–158`：HTTP observer 的等待有界且不把连接中断当作 Runtime 取消；`299–306` 冻结 Skill catalog，`317–326` 绑定并验证目标。
- `creativePlanResolver.mjs:301–385`：用户确认后的计划、每个分支、参考、Memory/Skill 与品牌规则参与快照/指纹，历史重试不应重新分类后改语义。
- `generationProcessor.mjs:925–956`：成功 Job 先持久化 `projectWritebackPending`，Canvas 与 Artifact 完成后才收口；恢复不应重新调用 Provider。
- `agentReviewDecisionService.mjs:55–96`：重试 Run 与决定绑定必须一致；历史未知结果不自动补建可能重复计费的任务。
- `canvasCollaborationRoom.mjs:489–534`：先 append、处理重复/冲突，再交付提交结果；快照压缩失败不把已 durable 的增量撤销。

以上是源码确认的设计，不是生产故障注入或部署生效证明。

## 2. 已确认问题

### F1 · P1：Memory 的治理字段在安全投影时丢失

**实际调用链：**

1. `server/store/productStore.mjs:182–202,544–556`：读取项目时把未被墓碑删除的 Memory 实体合入文档，并非只返回 active。
2. `server/agent/semantic/botanicAgentPersistence.mjs:847–855`：合并保留治理字段，只处理版本、墓碑、排序和数量。
3. `server/agent/turn/agentTurnSubmission.mjs:349`：把该项目文档传给 Runtime。
4. `server/agent/turn/botanicAgentTurn.mjs:967–981` 与兼容聊天 `server/agent/semantic/botanicAgentChat.mjs:312–313`：先调用 `safeBotanicAgentMemory`。
5. `server/agent/semantic/botanicAgentOntology.mjs:123–137`：先截前 30 条，再投影为部分字段，丢失 `status`、`subject`、`subjectValue`、`conflictsWith`、`confidenceScore`、`updatedAt`。
6. `server/agent/tools/botanicAgentContextTools.mjs:79–89`：对已损失语义的对象调用选择器，而且没传主体上下文与 `contextNodeIds`。

选择器本身在 `botanicAgentMemory.mjs:69–96,116–119,212–263` 实现了主体匹配、active 过滤和对称冲突消解；字段缺失触发历史兼容逻辑，不能执行原本的治理规则。

**本轮复现：**四条 Memory 先通过真实 `validateAgentMemoryEntity`，再经过文档合并与工具调用：

| 输入 | 直接调用权威选择器 | 实际工具路径 |
| --- | --- | --- |
| `draft`：proposed + confirmed | 排除 | 返回 |
| `channel`：active，但仅适用天猫，本轮没有渠道信息 | 排除 | 返回 |
| `red` / `blue`：声明冲突的两个 active 规则 | 只返回 `blue` | 两条都返回 |

直接结果：`["blue"]`；工具结果：`["blue","channel","draft","red"]`。

这不是构造了非法数据：`botanicAgentPersistence.mjs:219–220,692–705` 明确把激活状态与可信度分开，允许 proposed + confirmed。影响是待批准、已替代或范围不匹配的规则可能进入模型上下文，不是已证明能绕过整个生成审批系统。

**最小修复方向：**

- 在完整权威 Memory 上执行同一个选择器，再对选中结果做安全投影；或确保内部投影保留选择必需的治理字段。不要让模型输出决定 active。
- 传入已知的 `brandId`、`userId`、上下文节点；SKU/渠道仅在真实存在时提供，缺失时按现有规则排除。
- 移除“先截 30 条再选”的顺序问题，保留输出预算但不提前丢掉候选。
- 返回有界的排除/冲突原因。区分 catalog bindings 与实际使用 bindings，核对 `botanicAgentTurn.mjs:990` 不把全部候选误记为已使用规则。
- 把上面的跨模块调用作为回归边界，覆盖 Turn 和兼容 Chat 共用路径。规划 HTTP 已在 `server/http/agentRoutes.mjs:925–932` 使用完整选择器，可复用其上下文原则，不再复制一套规则。

对应规范：ADR 0006 `55–65` 要求状态与置信度分离、冲突显式、单一 Memory 读取路径。

### F2 · P2：Ontology 在解析显式引用前截断，误报有效节点不存在

`server/agent/semantic/botanicAgentOntology.mjs:32–38` 先截取前 240 个节点，再判断引用是否存在；`93–112` 用这个结果生成“当前权威画布快照无法解析”的提示。

**本轮复现：**构造 241 个合法节点，明确引用 `n240`（第 241 个）。实际文档存在该节点，但返回 240 个节点、`contextNodeIds: []`，briefing 声称该引用无法解析。

`ontology_read` 又在 `botanicAgentContextTools.mjs:52–62` 返回最多 160 个节点、200 条边，却不说明完整总量或提供分页。素材组也在查询前截 80 个。因此“不在模型窗口”被混成了“不存在”。原生视觉走另一条引用路径，不能由此推断图片必然没有附上；相反，它可能造成元数据说明与视觉上下文不一致。

**最小修复方向：**

- 先从完整节点集合解析显式引用与目标，再形成有预算的摘要；优先保留已引用节点及必要邻域。
- 明确区分 `not_found`、`not_loaded/truncated`、`media_unavailable`，只有权威查找失败才能说不存在。
- 复用 `canvas_query` 的 `nodeIds`、关系角色和分页能力，见 `server/canvas/canvasAgentQuery.mjs:138–175`、`server/agent/tools/botanicAgentOperationalTools.mjs:227–253`。
- `ontology_read` 保持轻量项目概览即可，不再与 `canvas_query` 维护两套不一致的查找真相。不能靠单纯加大 240 的常量解决正确性问题。

### F3 · P2：Artifact 搜索先取最近结果，再过滤，静默漏掉历史命中

`server/observability/agentOperationalReaders.mjs:75–83` 先读取 `min(limit * 4, 200)` 个 Artifact，再过滤 query/kind；`server/agent/tools/botanicAgentOperationalTools.mjs:305–328` 默认 limit=20，且把已返回数组长度作为 total，没有截断说明或下一页参数。

三个 Adapter 的 `listAgentArtifacts` 按时间倒序取页，不会替调用者做关键词过滤：本地 `productStore.mjs:1161–1174`、PostgreSQL `postgresProductStore.mjs:1674–1694`、Supabase `supabaseProductStore.mjs:1383–1409`。

**本轮复现：**81 条历史结果，唯一的“春季已批准主视觉”位于第 81 条。调用真实 reader 与工具定义、用符合 Adapter 取页契约的内存 stub，得到 `{total: 0, artifacts: []}`；实际存在 1 条匹配。未使用真实数据库。

**最小修复方向：**优先把过滤放在权威查询的分页之前，并同步三个 Adapter 契约。若先做低成本过渡，就使用已有 `before` 游标有界遍历，并返回 `hasMore/searchTruncated/scannedCount`，不能把未扫完说成没有结果。不要无限拉取全部历史。

## 3. 代码与逻辑层优化建议（不是已确认故障）

### 3.1 收缩 UI 中的执行编排，不按文件行数机械拆分

`AgentWorkspace.tsx` 当前 3,897 行，`runInstruction` 从 `1918` 到约 `2928`，仍组合消息保存、意图入口、模型回合、澄清、局部编辑、计划创建和自动提交。

已有 `agentInstructionRouting.ts`、`useAgentMessageDelivery.ts`、恢复与 Action hooks；优先继续沿这些边界把一个可测试的行为移到拥有它的模块，UI 只保留编排所需的端口。目标是同一行为只有一份实现，不是增加一层通用 Controller/Engine。`architectureBoundaries.mjs:21–37` 对超大文件已有冻结预算，检查通过不意味着文件已足够内聚。

### 3.2 统一“意图建议”和“执行资格”的术语与来源

`agentInstructionRouting.ts:115–121` 已把新消息统一交给 durable Turn；本地 regex 仍用于自动提交资格。`agentChatContract.ts:302–304` 的注释却仍写成“是否走生成 Turn”，`307–329` 的输入提示也可能比实际模型判断更绝对。

不要以为当前所有请求都被正则拦在服务端之前，更不要直接删除确认边界。先把本地结果定义为 UX 提示/保守资格信号，最终计划以服务端结构化输出与确定性校验为准。分类模型替换建议源，不替换“是否已经授权”。

### 3.3 增强语义投影的一致性，不新建图数据库

当前 Ontology 摘要的边在 `botanicAgentOntology.mjs:43–46` 只是 `asset -> generate` 这种端点类型，丢了边的业务 role。`canvasAgentQuery.mjs:72–81,138–146` 已能保留 role/system/handle；节点投影 `104–134` 已含 Frame/Stage 与执行引用。

建议统一使用现有安全读模型表达：参考角色、输出归属、Run/Job/Artifact 血缘、Frame/Stage 和规则绑定。这些事实从权威实体导出，不让分类器从一句自然语言反推“某张图已批准”或“这个节点就是用户选中的版本”。不引入 RDF/OWL/图数据库，除非之后的跨项目查询确实证明现有数据模型不能满足。

### 3.4 优化语义检索预算，先测再决定索引

`canvasAgentSemanticSearch.mjs:5–8,54–77` 已有可选 embedding 搜索、最多 500 候选、每批 50、进程内 LRU；`34–45,99–103` 有显式 keyword 降级和截断标志。这比重建检索服务更值得复用。

冷路径最多为 500 个候选加 1 个 query 分 11 批串行请求，现有超时按每批计算；会影响首轮耗时，但本轮没有实际延迟测量，不能声称线上已慢。先增加/核对总耗时预算、取消传播、cold/warm p95 与截断比例，再按证据决定是否做增量索引或受限并发。分类模型不是 embedding 模型的直接替代品。

### 3.5 评估必须覆盖语义链路

当前 `scripts/evalGate.mjs:26–33` 的固定回归集有 9 个样本，全部未跑视觉层。它验证确定性结论，不是中文意图分类 benchmark；本轮全量测试通过也没挡住 F1–F3。

先补治理实体 → 投影 → 工具 → 决策的少量关键回归，再建立分类模型独立的离线数据集。不要把更多 mock 测试数量当成模型准确率。

## 4. 分类模型的接入边界

外部模型的一手源码、模型卡与限制另见 [this-that-model 研究](THIS_THAT_MODEL_RESEARCH_2026-09-22.md)。以下为 Botanic 侧架构建议，不代表已实现接口。

### 4.0 模型事实与选型判断

**Jev 是 TypeSafe 的模型产品名，this-that-model 是 FLock 的独立实现，两者不是同一模型或可直接互换的 SDK。** 本轮固定 FLock 源码 SHA `f00d3abf8e1783737f9858cfd5f7972047a14967`，权重 revision `3d927195c4f9845efe66c5715883a7a0f42b1239`；Jev 官方文档当前列出 `jev-1.13.0`。

| 维度 | FLock this-that-model | TypeSafe Jev |
| --- | --- | --- |
| 交付与接入 | 约 1.88B 参数、公开权重、Python 推理包、可自托管 FastAPI 包装 | 托管 System One API，协议为 `/v1/systemone` |
| 核心能力 | 每题从动态 2–255 选项中单选；Python 可一次前向回答多题 | Choice / Score / Noul 三类问题；Choice 仍为单选 |
| 输入 | 文本；没有图像编码入口 | 官方同样只支持文本 / 文字 JSON |
| 中文 | 模型卡标 en，未找到中文领域效果报告 | 官方称英文最好，CJK 可以处理但效果不等同英文 |
| 分数 | `confidence` 就是当前候选集内的最大 softmax 概率 | confidence 是分布派生统计量，不可与 FLock 直接复用阈值 |
| 弃权 | 无内置自动 unknown；需包装层显式添加选项、拒答或回退 | 仍需按业务定义候选和风险阈值，不产生执行授权 |

一手来源：[FLock 推理与评分](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/model.py#L114-L172)、[FLock Decision](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/types.py#L10-L53)、[FLock 模型卡](https://huggingface.co/flock-io/this-that-model-1.0/blob/3d927195c4f9845efe66c5715883a7a0f42b1239/README.md)、[Jev 官方模型说明](https://docs.typesafe.ai/models)、[Jev confidence](https://docs.typesafe.ai/confidence)。

FLock 当前 HTTP 包装还有几个接入陷阱，已按固定源码复核：

- 最后一条 user message 被当作“分类问题”，其余消息拼成 state；不能把现有聊天历史原样丢过去就期待等价语义。
- HTTP 只处理第一个 enum 问题，不是完整 JSON Schema / tool-calling 实现；Python 的多问题能力没有全部暴露到 HTTP。
- 默认 state 预算约 1,536 token，只保留前部，超出部分无告警丢弃。Botanic 必须自己形成有界任务上下文，不能直接发送整份 Ontology 或线程摘要。
- 要读概率需使用非流式响应；`usage` 全部写 0，不代表计算免费；请求中的 model 字段不负责选择实际已加载权重。
- 示例服务没有鉴权/配额/限流，async handler 直接执行同步推理。若自托管，应作为内网受控推理服务，不向公网裸露，也不把 Python/Torch 加进现有 Node Worker 主进程；是否需要独立部署要以试验收益为前提。

源码：[HTTP server](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/server.py#L49-L117)、[协议解析](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/openai_protocol.py#L15-L68)、[截断行为](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/prompt.py#L99-L130)。

**选型建议：两个都可做文本决策实验，现阶段不替换主 Planner。** FLock 适合有自托管/数据驻留需求且能承担模型运维的试验；Jev 可减少自托管工作，但多了外部数据目的地和服务依赖，不能默认取得私有数据授权。两者都没有本轮已验证的中文品牌场景优势。

上游空间/迷宫 benchmark 不能当成 Botanic 效果：FLock 当前模型训练过对照评测中的题型；README、论文与重现脚本还存在准确率和延迟统计口径差异。约 30ms 的官方数字不是本机或 HTTP p95。本轮没有运行权重，不能宣布“超过 Jev”“更便宜”或“能减少确认”。详见外部报告第 7–8 节。

### 4.1 拆开四类问题

| 问题 | 应由谁回答 | 分类模型的角色 |
| --- | --- | --- |
| 用户想做什么：检索、改 Prompt、生成、调整场景等 | 语义解析 + 上下文 | 可给候选意图与维度建议 |
| “这张/上一张”对应哪个实际对象与版本 | mentions、TargetBinding、Artifact/Run 权威关系 | 最多提候选，不能自行建立身份或忽略绑定漂移 |
| 能不能执行、是否已批准、会花多少额度 | 权限、确认策略、预算、确定性编译 | 不可替代；分数再高也不能授予权限 |
| 结果是否合格、是否品牌批准 | 硬规格 → 视觉评审 → 人工决定 | 文本分类仅能辅助分派判据/问题类别，不能代替看图或批准 |

### 4.2 用现有受控词表，不堆成一个大标签集合

- 顶层：conversation / prompt / research / generation / action_proposal，再加 Botanic 包装层自己的 unknown/abstain。
- 生成子意图：沿用 `botanicAgentTurn.mjs:45–48` 的 9 类；局部框选继续遵守现有交互入口，不能分类后绕过选区。
- 改动维度：沿用现有 `person/garment/product/scene/style/pose/composition/lighting/aspect_ratio/copy_space`，每个维度区分 preserve/change。单条指令可能同时“保留商品、换背景、改比例”，单标签不能完整表达。
- Memory：`scope` 和 `subject` 是独立轴；subject 沿用 project/brand/product/channel/user。模型可提议字段，但 active 状态仍由人工/可信证据产生。
- 素材角色与创作阶段：只做建议标签。图片中实际对象、风格、构图需要视觉输入或已验证 caption，不能假装文本分类器看过原图。

初期只试一种路由任务；不要一次调用五个分类器、增加串行耗时，也不要为了模型的固定标签重做领域模型。

### 4.3 最小接法：现有 durable Turn 内的可选建议步骤

```text
已持久化的用户消息 + 经授权且有界的上下文
  → 现有 Turn claim / 身份绑定
  → 可选分类建议（超时 / unknown / 不一致均回退）
  → 现有 Planner / 多模态理解与工具循环
  → 结构化计划校验 + 权限 / 确认策略
  → Resolve / Compile / 冻结 Run / 执行
```

建议挂接在服务端语义解析边界 `botanicAgentTurn.mjs`，不要另开浏览器预分类的第二条历史/恢复链。影子实验阶段不阻塞正式请求；当实验建议真正参与下游规划时，按现有 Checkpoint 规则持久化安全输出与模型版本/词表版本，恢复复用同一建议，不在旧 Run 重试时重新解释意图。

拟议内部结果只需要：`task`、`candidateLabels`、原始 score（若模型有）、`abstained`、`modelRevision`、`taxonomyVersion`。不要输出或接受 `authorized=true`、`approved=true` 这类权限结论。分数经领域校准之前不命名为真实成功概率。

送往分类器的数据只包含已获授权的最小文本/元数据，不包含凭据、私有媒体 URL、完整项目历史。新的模型服务是新的数据目的地；现有 FLock 主模型授权不自动等于任意新端点授权。

### 4.4 先验证收益，再进入正式请求

下面是拟议验收，不是已测结果或对某个模型的承诺：

1. 修复 F1–F3，固定上下文与检索语义，建立稳定基线。
2. 以合成或已批准脱敏样本建立离线集，覆盖中文/英文、否定、引用省略、多轮承接、多意图、能力询问与实际执行的区别、相似标签、无关输入和缺上下文；建议先 200–300 条有人工标签样本作试验，不能据此宣称生产可靠。
3. 同集比较现有 regex 辅助信号、现有 Planner，以及候选分类器；记录每类 precision/recall、macro-F1、弃权率、分歧率、p50/p95、冷启动与总费用。
4. 确认型/计费型误分单独统计，不能被整体准确率掩盖。候选分类器即使高分，也不能直接放行 costly/external 动作；测试中出现自动授权越界即不准入。
5. 只有低风险路由在目标语言、部署环境与足量留出集上确有质量/时延/费用收益，才逐步使用建议。仅多调用一次分类器、仍完整执行主模型，通常不能直接宣称省 token 或降延迟。
6. 分类不可用、模型 revision 不匹配、输出不在受控词表或上下文不足时，保留现有流程；不把异常映射成默认生成。

初期不做自动审批、不自动激活 Memory、不迁移全部 Ontology、不增加新 Agent Runtime，也不基于上游宣传数字承诺收益。

## 5. 实施顺序与本轮验证

| 顺序 | 工作 | 完成标准 |
| --- | --- | --- |
| 1 | Memory 治理字段/选择顺序 | 跨入口一致排除 proposed、范围不匹配与冲突规则；记录真正选中的版本 |
| 2 | 显式引用与检索完整性 | 第 241 个引用可解析；历史命中可查；截断/未加载不伪装成不存在 |
| 3 | 意图、关系与 UI 编排一致性 | 复用现有读模型与领域词表；不改变幂等、批准、取消及恢复语义 |
| 4 | 分类器离线对比 / shadow | 中文领域效果、弃权行为、部署成本有数据；不影响正式执行 |
| 5 | 可选有限接入 | 仅建议层；失败回退、版本冻结、权限与真实 Provider 验证均明确 |

本轮验证：

- `npm test`：退出码 0，通过本仓配置的服务端/API/scripts 与前端纯逻辑测试；不将其解读为真实数据库、生产或浏览器全链路认证。
- `npm run check:architecture`：通过。
- `node scripts/evalGate.mjs`：9 个样本符合声明期待，其中 4 个预期确定性失败；9 个均未跑视觉评审，视觉质量仍未验证。
- 三个只读、纯内存复现：均确认了上述问题；Memory 数据通过真实实体校验，Artifact 使用遵循现有分页契约的 Store stub。
- 没有调用真实生成/视觉/分类 Provider，没有新依赖、业务代码修改、提交或部署。

仍未验证：线上实际配置/流量、数据库迁移和多实例负载、真实浏览器交互、真实中文分类效果、视觉质量，以及新模型服务的生产资源与数据处理边界。

## 6. F1–F3 本地修复完成（2026-09-22）

- **F1 Memory**：`server/agent/semantic/botanicAgentOntology.mjs:119` 保留选择器需要的治理字段，取消选择前的 30 条裁剪；`server/agent/tools/botanicAgentContextTools.mjs:98` 传递主体与节点上下文并返回有界排除原因。Turn 与兼容 Chat 均使用服务端文档品牌、Runtime 当前用户身份，不接受模型提供的主体身份。未新增记忆写入或自动激活入口。
- **恢复边界**：`server/agent/turn/botanicAgentTurn.mjs:991` 保留完整可检索目录的版本绑定，不将其冒充实际使用项。空查询时冲突落选的规则仍可能被另一关键词命中，不能把一次选择结果当作整个目录快照；回归已验证此类候选版本漂移会在调用 Provider 前拒绝恢复。实际检索选择保存在对应工具结果中。
- **F2 Ontology**：`server/agent/semantic/botanicAgentOntology.mjs:28` 从完整安全集合解析引用，优先展示显式引用；`server/agent/tools/botanicAgentContextTools.mjs:50` 和 `:113` 在过滤后分页，返回完整/匹配计数与后续页。第 241 个节点、第 401 条边、第 81 个素材组不再被进程内提前截断。没有扩大媒体读取权限或改变关系角色语义。
- **F3 Artifact**：`server/observability/agentOperationalReaders.mjs:77` 复用三种 Adapter 已有的 `before` 分页协议，每次最多扫描 1,000 条；`server/agent/tools/botanicAgentOperationalTools.mjs:305` 提供续查游标以及 `hasMore/searchTruncated/scannedCount`。零命中但尚未扫完时明确标记可继续，不宣称全历史无结果；无权限/不可读、非法时间与停滞游标不伪装为空结果。没有改 Store 接口、数据库结构或历史 Artifact。

回归采用项目已有测试体系、只替换 Provider HTTP 边界，未增加依赖。新增两个测试文件、6 个测试，覆盖真实 Turn/Chat 调用链、恢复目录漂移、大画布分页，以及真实本地 ProductStore 的第 81/241/1001 条历史检索、同时间戳游标和异常边界。两个既有 mock 同步了内部读取器的分页返回结构。

当前验证：

- `npm test`：服务端/API/scripts 2,023 通过、2 跳过；前端逻辑 862 通过；合计 **2,885 通过、0 失败、2 跳过**。两条既有 PostgreSQL 集成用例因未配置 `AGENT_TEST_PG_SOCKET` 跳过，不作为数据库实测通过。
- `npm run check:architecture`：通过。
- `npm run build`：协议生成校验、TypeScript 和 Vite 构建通过；仍有部分 chunk 超过 500 kB 的构建告警，本轮未做打包重构。
- `node scripts/evalGate.mjs`：9 条符合预期，仍未运行视觉层。
- `git diff --check`：通过。

边界与后续：未提交、推送或部署，未调用真实生成/视觉/分类 Provider，未运行真实数据库或浏览器验证。工具 schema 已变化，旧 checkpoint 继续执行既有能力快照不匹配时拒绝恢复的策略，没有绕过或改写历史 checkpoint；部署前应检查在途 Turn。已有报告和无关改动保留。

下一阶段按第 3 节推进：先收缩 UI 执行编排，再明确意图建议与执行资格，随后统一 Ontology 安全读模型；FLock/JeV 仅在此后进行离线或影子评估。本轮没有开始上述重构或接入模型。
