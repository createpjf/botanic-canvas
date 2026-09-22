# Botanic 代码与逻辑层优化方案

日期：2026-09-22。状态：**O0–O4 已在本地实施，验收记录见第 9 节；O5 未实施、未发布**。

基线：`c7de68ef114970eefcb80cdd7ca4388973a01944`，叠加工作区已完成、尚未提交的 F1–F3 修复。实施没有退回裸 HEAD 或覆盖既有改动。第 1–8 节保留最初方案及其只读调研判断，第 9 节记录后续实施；没有提交、推送、部署、生产迁移或真实 Provider 调用。

## 1. 总体决定

保留现有 durable Turn、Resolve/Compile、Run/Job、审批、恢复与 Artifact 主干。先保证模型收到的数据完整且可解释，再收缩重复编排、统一领域语义、控制检索预算。分类模型是独立的可选试验，不是核心优化的前置依赖。

推荐范围：O0–O4；O5 只保留设计，真实评估、私有数据传输和上线需分别获得对应授权。

不做：第二套 Runtime、通用工作流引擎、新图数据库、全量 Store 重写、UI 重设计、自动扩大审批豁免、全局机械改名、为了行数拆透传模块。默认不新增依赖、不改数据库表、不改公开业务实体。

## 2. 当前证据与判断

以下为实施前工作区的证据，行号与行数对应当时快照；重构后的实现位置见第 9 节。不把已修复现象或历史审查故障直接当成现存故障。

| 证据 | 当前事实 | 方案判断 |
| --- | --- | --- |
| E1：[AgentWorkspace](/Users/leo/Documents/botanic-canvas/src/features/agent/AgentWorkspace.tsx:1918) | 文件 3,897 行，`runInstruction` 到 2928 行；包含提交、结果投影、生成续接、局部重绘和计划确认 | 按行为所有权逐段收缩；行数只是线索，不是缺陷证据或唯一验收指标 |
| E2：[正常结果投影](/Users/leo/Documents/botanic-canvas/src/features/agent/AgentWorkspace.tsx:2315)、[恢复结果投影](/Users/leo/Documents/botanic-canvas/src/features/agent/AgentWorkspace.tsx:3109) | chat、clarification、composition 与 generation handoff 在两处处理 | 先共享纯结果投影，再处理生命周期；不要把一千行整体搬到新 Hook |
| E3：[实际入口](/Users/leo/Documents/botanic-canvas/src/domain/agentInstructionRouting.ts:115)、[旧命名与提示](/Users/leo/Documents/botanic-canvas/src/domain/agentChatContract.ts:302) | 新消息统一进入 durable Turn；`botanicAgentRequestUsesGenerationTurn` 实际参与自动提交资格，注释仍描述是否进入 Turn | 区分意图提示、计划建议、提交资格与服务端执行授权；保留本地预览、追问续接等明确兼容用途 |
| E4：[唯一执行资格函数](/Users/leo/Documents/botanic-canvas/src/domain/agent.ts:731)、[多处调用](/Users/leo/Documents/botanic-canvas/src/features/agent/AgentWorkspace.tsx:2017) | 手动/自动、待批准行动、张数和 waiver 已有纯规则；多个入口分别组装参数 | 复用现有规则，统一组装事实；不引入新的审批策略引擎 |
| E5：[Ontology 投影](/Users/leo/Documents/botanic-canvas/server/agent/semantic/botanicAgentOntology.mjs:12)、[实时读模型](/Users/leo/Documents/botanic-canvas/server/canvas/canvasAgentQuery.mjs:104) | 两套节点/边投影：Ontology 的边仍是端点类型字符串，实时查询包含 role/system/handles；节点名称与状态取值也各有实现 | 共享低层安全语义提取，保持两个工具不同的信息权限和时间语义 |
| E6：[输出预算整形](/Users/leo/Documents/botanic-canvas/server/agent/tools/agentToolOutput.mjs:27)、[Runtime 调用位置](/Users/leo/Documents/botanic-canvas/server/agent/tools/agentToolRuntime.mjs:376) | 大工具结果会变成 `_botanicTruncation + preview`，原结构不保留 | 优先补齐“工具结果 → 模型最终消息”的分页契约，不能只验证工具 `execute()` |
| E7：[语义检索](/Users/leo/Documents/botanic-canvas/server/canvas/canvasAgentSemanticSearch.mjs:50)、[工具入口](/Users/leo/Documents/botanic-canvas/server/agent/tools/botanicAgentOperationalTools.mjs:258) | 最多 500 候选、每批 50、串行请求，只有逐批 timeout；当前签名没有父 signal/deadline 透传 | 补总预算与取消传播，再测冷暖路径；不能由源码推断线上已经慢 |
| E8：[Artifact reader](/Users/leo/Documents/botanic-canvas/server/observability/agentOperationalReaders.mjs:77) | 已复用游标有界扫描，每次最多 1,000 条，显式可续查 | 保留正确性修复；只有扫描成本的测量证明必要时，才下推数据库过滤 |

### 本轮新增的只读复现

以 241 个节点、401 条边构造合成画布，执行当前 `ontology_read`，再调用真实 `createToolOutputBudget([]).prepare(...)`：

```text
原工具结果：page = { index: 0, hasMore: true, nextPage: 1 }
模型消息键：['_botanicTruncation', 'preview']
结构化 page：不存在
截断原因：per_output_budget
```

预览采用头尾保留，本次尾部仍包含 page 的文字；因此不能说游标必然完全消失。但中间项目被省略、结构化结果不再成立，不能依靠预览证明已完整消费本页。这是上一轮修复之后更下游的契约缺口，并不否定完整集合查找和 Artifact 游标已修好。没有调用模型，因此尚未测量其实际误读率。

## 3. 保留的权威关系

| 概念 | 所有者 | 明确不意味着 |
| --- | --- | --- |
| 意图建议 | 服务端结构化语义解析；前端仅做提示与保守资格信号 | 已得到执行授权 |
| 浏览器提交资格 | 现有 `resolveBotanicAgentExecutionDecision`，消费模式、完整设置、张数、行动与 waiver | 可以替代服务端权限、预算或批准校验 |
| 执行许可 | 现有服务端权限、审批、配额与确定性执行入口 | 可以由分类分数产生 |
| 本轮 Ontology | 本轮已授权项目快照的安全读模型 | 当前时刻的实时图谱 |
| 实时 Canvas 查询 | 当前用户/项目权限下重新读取的权威图谱 | 模型可以伪造 Result 或系统血缘 |
| Memory 目录绑定 | 冻结可检索目录的版本，用于恢复漂移校验 | 每一条目录项都已用于生成 |
| 实际 Memory 使用 | 权威选择器结果及 Plan/编译绑定 | 模型可以自行激活候选规则 |
| Stage、生成成功、品牌批准 | 分别由组织信息、Run/Job、Review/Human Decision 拥有 | 任意一项可以替代另两项 |

依据：[产品权威表](/Users/leo/Documents/botanic-canvas/docs/PRODUCT_ARCHITECTURE.md:65)、[ADR 0005](/Users/leo/Documents/botanic-canvas/docs/adr/0005-executable-creative-plan.md:35)、[ADR 0006](/Users/leo/Documents/botanic-canvas/docs/adr/0006-agent-quality-memory-governance.md:15)、[ADR 0014](/Users/leo/Documents/botanic-canvas/docs/adr/0014-governed-canvas-agent-actions.md:15)。编译快照仍按现有实现于首次执行、Provider 前形成，不借重构提前到画布尚未持久化的时点。

## 4. 分阶段实施

### O0：固定行为基线与可回退范围

- 保存本轮相关文件的状态清单，区分既有 F1–F3 修复、新优化与无关改动；提交需另获授权。
- 列出正常发送、刷新恢复、accepted 前断线、Stop、会话切换、追问续接、局部重绘、成套生成与计划确认的行为表。
- 优先沿用现有回归；只补本次改动缺失的调用链场景，不另起测试框架。
- 记录本地基线：正常/恢复结果、工具可见分页、工具请求次数、检索冷暖耗时；真实模型质量和生产 p95 保留为未知。

完成标准：每个后续任务均能指向被保护的行为、拥有它的模块和可运行检查。O0 不要求先搭 issue tracker 或新基础设施。

### O1：先闭合分页与模型输出预算的契约

范围：`botanicAgentContextTools.mjs`、`botanicAgentOperationalTools.mjs`、`agentToolOutput.mjs` 及其实际 Runtime 调用链测试；仅必要时调整 reader 的输出预算接口。

设计要求：

1. 在业务读工具内形成可放入现有预算的结构化页，优先减少当前页项目数/可选描述，不先扩大 2k/6k token 上限。
2. 保留工具专属白名单元数据：计数、已返回数、扫描数、完整性、下一游标/页、截断原因。不得从任意工具对象递归提取 ID、URL 或数据字段。
3. **游标只能越过实际已交付的项目。** 不能先算出下一页，再因 token 预算丢掉中间项目；调整页大小时保持固定分页规则，或使用明确的续查 cursor，不让旧的页码计算静默漏项。
4. 区分数据分页尚有后续、单工具输出裁剪、累计上下文预算不足、权威不存在与无权读取。已达到整轮预算时明确停止/要求缩小查询，不以空结果表示不存在，也不无限循环翻页。
5. 不保证历史所有工具输出永远保留：既有累计压缩仍可生效，但当前页的消费/续读必须有明确语义。Checkpoint 与模型 history 使用同一个最终安全 envelope，不绕过恢复清洗规则。

验收：从真实 Tool Loop 捕获发给 fake Provider 的下一次请求；短/长名称、单页/累计超限时仍可解释哪些项目已交付、哪些尚未交付；跨页不漏不重；大页不泄露私有媒体；F1–F3 回归继续通过。仅工具单元测试通过不算完成。

### O2：收缩前端编排并澄清意图与提交资格

采用三个小批次，避免一轮重写整个面板。

**O2a：纯结果投影先合并。**

- 复用 `agentTurnObservation.ts` 中的稳定消息 ID、generation continuation 与已有 Timeline 规则。
- 正常返回与恢复返回共享 chat/clarification/composition/失败结果的纯投影；输入为既有 Turn 结果、稳定身份与 locale，输出为既有 Message 或 generation continuation。
- 明确非法 composition 的处理与界面阶段，先记录现有差异，再决定统一结果；不能在抽取时暗改用户可见行为。
- 优先扩展已有所有者；需要独立文件时，拟用 `src/features/agent/agentTurnResultProjection.ts`，它必须拥有真正的投影规则，而非透传包装。

**O2b：生命周期与 UI 分开。**

- 在 `features/agent` 内集中提交/重挂 observer/Stop 的异步协调，复用 `useAgentMessageDelivery`、`agentTurnRecovery`、`useAgentInstructionTarget`、`agentApi`，不复制它们的职责。
- 一个稳定的协调接口负责开始、重挂与停止，统一异步 scope 校验；内部拥有 pending/active Turn 引用，避免把几十个 setter 作为接口传来传去。
- 普通卸载/切会话只终止观察，显式 Stop 才保存取消意图并请求 durable cancellation。旧会话迟到事件不得更新新会话。
- `AgentWorkspace` 保留渲染、焦点、面板、Composer 与用户事件接线；不要求它本轮立即降到 500 行。

**O2c：意图与计划入口归一。**

- 调整 `botanicAgentRequestUsesGenerationTurn` 的内部名称/注释为其真实用途，例如“本地明确生成信号”；不是全局重命名任务。
- `decideBotanicAgentRequest` 继续服务本地预览、裸确认语、显式局部编辑等现有用途；不粗暴删除全部 regex。
- Composer 只表达操作倾向，不再以本地启发式保证“不会出图”等超出其权威的结论；确认提示仍需说明计费与行动后果。
- 成套生成、局部重绘、首图/视频、服务端 Planner 四条路径沿现有 draft/plan 类型形成结果，再进入同一“显示待确认计划 → 计算提交资格 → 已获授权时提交”的行为模块。各自特殊语义仍留在现有 plan builder。
- 统一使用本次已冻结的模式、目标、覆盖参数和来源身份；不在 await 后改用用户刚切换的设置。
- 现有 manual/auto、batch waiver、pending action 与 inferred intent 的确认规则保持不变。分类建议不能设置 waiver 或绕过 `allowAutoSubmit=false`。

验收：相同结果在正常/恢复路径产生相同稳定消息与 continuation；Stop 前后不重复提交；刷新不重复 Provider/Run；切会话无串写；选区、原目标、引用与模型设置不丢失；模式/张数/行动确认与基线相同。减少重复实现而不是把复杂度搬家。

### O3：统一 Ontology 安全读语义，而非扩大所有工具响应

范围：`botanicAgentOntology.mjs`、`canvasAgentQuery.mjs`、上下文与查询工具；需要提取共享逻辑时放入拥有 Canvas 读语义的模块。

- 共用最小基础投影：稳定 ID、类型、名称、状态、Frame/Stage；边使用来源明确的 role、system、handles，而非只拼 `asset -> generate`。
- 权威血缘读取既有字段及实体关系；不根据名称、模型标签或 Frame Stage 推断批准状态。Artifact 索引存在也不保证媒体仍可用。
- 使用明确的窄投影：Ontology 仍以元数据为主；实时查询才包含它原本允许的有界 Text/Prompt 正文、坐标等。共享底层取值规则不等于把实时查询全量 DTO 复制进 Ontology。
- 显式标明“本轮快照”和“实时读取”；相同文档版本应字段一致，不要求不同时间的两次读取看起来相同。
- Memory 沿用单一选择器，保留目录绑定/本次选择/Plan 实际使用的区别；不增加第二套 scorer 或新的 Memory 状态。
- 先不扩公共实体、HTTP 协议、图数据库和三 Adapter 接口。需要实际新增公开字段或版本时单独列出兼容决策。

验收：同一输入在两种投影中的共同字段一致；关系角色不丢失；Generate Prompt、URL、媒体字节不越权流入概览；节点删除不删除历史 Artifact；历史空字段按明确兼容规则处理，不伪造血缘或批准。

### O4：检索总预算、取消传播与可测性能

范围：`botanicAgentOperationalTools.mjs` → `agentOperationalReaders.mjs` → `canvasAgentSemanticSearch.mjs`，沿已有工具上下文透传，不另建执行控制面。

- 父 `signal/deadlineAt` 与每次 Provider timeout 组合；进入候选扫描、每批 embedding 前及返回前检查。
- 采用整次语义检索预算，单批最多使用剩余额度；默认预算在 O0 合成基准后确定，不能把 11 批分别 5 秒误当成整次 5 秒。
- 用户取消/Turn deadline 保留取消语义，不被 catch 成 keyword 降级继续做工作；普通 Provider 不可用或检索子预算耗尽才在父请求仍有效时显式降级。
- 先保持当前顺序请求和有界 LRU，测候选数、请求批次、cold/warm p50/p95、缓存命中和降级比例；仅在测量证明有收益时增加小规模有界并发。
- Artifact 暂保留 1,000 条扫描上限和续查。先测每页扫描/命中比、总查询次数与耗时；若真实数据证明瓶颈，再设计三 Adapter 同步的过滤下推/索引任务，不顺手迁移数据库。
- 复用 `agentSemanticEvent` / 现有查询指标，新增字段走现有白名单；不记录 query、Prompt、私有 URL，项目 ID 不作为高基数 metrics label。

验收：可控延迟的 fake embedding Provider 能证明总耗时有界；取消后不再启动下一批请求，不伪报已停止远端计费；降级仍明确，cursor 重置可见；冷暖性能报告带样本规模与环境，不把本地结果写成生产 p95。

### O5：可选的 FLock this-that-model / Jev 决策分类试验

前提：O1–O4 基线稳定，另行确定模型目的地、硬件/费用与可发送数据范围。当前主 Planner、模型路由与用户预算不变。

已有 [模型研究](/Users/leo/Documents/botanic-canvas/docs/research/THIS_THAT_MODEL_RESEARCH_2026-09-22.md:24) 固定了 FLock 源码/权重 revision；Jev 是不同产品与 API，不是同一 SDK 的替换名。本方案沿用 2026-09-22 研究快照，未再次查询上游版本，实施时重新核对。

第一项实验只做**粗粒度下一步语义建议**：conversation / prompt / research / generation / action_proposal，并有包装层的 unknown/abstain。不把多意图硬塞成单标签：这类样本标为 multi-intent 或弃权，由现有 Planner 处理；首次试验不加多级分类链。

步骤：

1. 使用合成或明确批准的脱敏样本，起步约 200–300 条；覆盖中文/英文、否定、能力询问、裸确认、上轮承接、引用缺失、多意图、模糊/对抗输入。
2. 按意图模板/会话族分开发集与留出集，避免同一句的改写落到两边。人工标签含“可接受多个答案/应弃权”，不把主 Planner 自己的输出当金标准。
3. 同集比较现有本地提示信号、现有 Planner 和候选分类器。分别报告 macro-F1、各类 precision/recall、selective coverage、弃权率、分歧、否定与能力询问误判、p50/p95、冷启动、总费用。
4. 阈值在开发集校准并固定到模型/词表版本；不照搬 README 的 0.8 或把两家的 confidence 当同一种概率。
5. 先离线，收益成立后才可授权 shadow；shadow 不影响正式路径、不阻塞正式请求、不自动发送私有历史。比较总链路耗时/费用，不能仅用分类 API 耗时宣称降本。
6. 最后才考虑一个低风险用途的在线建议。输出只含受控 label、可选 score、abstained、modelRevision、taxonomyVersion 及必要输入摘要 hash；不得输出 authorized/approved，不允许造业务 ID。参与下游决策前必须按现有恢复协议冻结可重放的安全建议，不能仅存 hash 便声称能重放。

不准入条件：中文/目标业务无明确收益；未校准阈值；无法弃权；延迟/总成本变差；模型输出越过授权；版本或数据边界不清。几百条样本无错误不证明生产安全；安全边界仍由确定性规则保障。视觉质量、品牌批准、Memory 激活、取消和幂等都不交给文本分类器。

## 5. 工作包、依赖和所有权

这些是本方案的工作包，不是已经创建的任务、分支或 PR。默认单 agent 顺序推进；若后续并行，UI 与服务端读模型可隔离，重叠工具输出契约必须先完成。

| 包 | 阶段 | 主要所有者 | 依赖 | 单独验收产物 |
| --- | --- | --- | --- | --- |
| T01 | O0 | 现有测试与行为契约 | F1–F3 工作区 | 基线、行为表、文件范围 |
| T02 | O1 | 读工具与输出预算 | T01 | 模型可见的有界分页契约及回归 |
| T03 | O2a | Agent 结果投影 | T01 | 正常/恢复共用投影与行为对照 |
| T04 | O2b | Agent 生命周期协调 | T03 | 提交/观察/Stop 单一所有者 |
| T05 | O2c | 入口与 Plan 交付 | T04 | 统一提交资格输入、保守提示与续接 |
| T06 | O3 | Canvas 安全读语义 | T02 | 共同字段契约、窄投影与关系语义 |
| T07 | O4 | 检索与工具执行上下文 | T02、T06 | 总预算、取消、降级与冷暖报告 |
| T08 | 核心验收 | 上述模块与隔离 UAT | T02–T07 | 验证矩阵、残留风险、发布/回退说明 |
| T09 | O5 可选 | 语义建议实验 | T08 + 额外授权 | 离线对比与 go/no-go；不是直接上线 |

推荐串行顺序：T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08。先正确性，再可维护性，再性能，最后模型实验。

## 6. 测试与完成标准

优先复用项目已有测试体系，测试穿过拥有行为的 Interface，不为每个私有 helper 增加一套测试。只在替代覆盖已建立后删除重复测试，不能借“精简”删掉安全不变量。

| 验证面 | 优先复用 | 核心验收 |
| --- | --- | --- |
| 输入与资格 | `agentChatContract*.test.ts`、`agentInstructionRouting.test.ts`、`agent.test.ts` | 咨询不自动计费；模式/waiver/张数/行动规则不放宽；追问不重新猜意图 |
| 正常与恢复 | `agentTurnObservation.test.ts`、`agentTurnRecovery.test.ts`、`agentApi.test.ts` | 同输入身份、同 Turn、同结果消息；Stop sticky；原目标不漂移 |
| 工具最终输出 | `agentToolRuntime.test.mjs`、`botanicAgentContextTools.test.mjs`、`agentOperationalReaders.test.mjs` | 检查实际模型消息，不只检查原始工具返回值；分页不漏不重、不假报完整 |
| 安全读模型 | `canvasAgentQuery.test.mjs`、`scripts/agentOntologyContract.test.mjs` | 共同字段一致；正文、媒体与血缘边界不扩张 |
| 检索与取消 | `canvasAgentSemanticSearch.test.mjs`、运维工具/reader 测试 | 子预算/父取消分开，失败降级、cursor 与批次数正确 |
| UI 真实交互 | `e2e/canvas-workspace.spec.ts`、隔离 `uat-turn-recovery.spec.ts` / `uat-agent-results.spec.ts` | 正常发送、刷新恢复、Stop、切会话、计划确认、键盘可用性；不重设计 UI |

每个涉及跨模块行为的完整工作包：聚焦检查后执行 `npm test`、`npm run check:architecture`、`npm run build`、`git diff --check`；涉及语义契约执行确定性 Eval。UI 变更必须检查真实浏览器，纯类型通过不代表交互通过。

真实数据库与 UAT 的环境条件必须满足；缺失则记录未验证，不把跳过写成通过。现有 UAT 会清理其浏览器状态，因此仅在专用隔离 context/测试项目运行，绝不复用用户工作浏览器或生产数据。真实生成、视觉、分类 Provider 均需单独授权。

量化完成标准：

- 安全回归集中重复付费派发、跨会话串写、授权放宽、已删除结果复活为 0；这不是“生产错误率为 0”的承诺。
- 正常与恢复结果由同一实现投影；同类计划交付规则不再散落四条分支。
- 新非测试模块目标小于 500 行、硬门禁 800；旧超限文件不涨预算，删除的重复规则不能在新文件重新复制。
- O1 的大页/长字段与累计预算场景都有明确完整性和恢复语义；覆盖已知边界，不靠多跑测试数量验收。
- 记录性能基线及变化；建议同环境重复测量后以 p95 不劣化超过 10% 为调查阈值，计时噪声需排除。这是拟议本地指标，不是当前生产 SLO。
- 新增检索预算与阈值基于 O0 测量确定并记录；分类准入指标在实验前冻结，不事后挑选有利样本。

## 7. 兼容、发布与回退

- O0–O4 默认不改 DB schema、HTTP URL、幂等键或 persisted Message/Run 形状。若实现发现必须改，先明确迁移/兼容方案，再扩大任务范围。
- 公共协议由现有生成流程维护，不能手工维护第二份前后端枚举；新增跨 Adapter 契约必须 opt-in 类型检查，并同步三 Adapter 与契约验证。
- 内部职责抽取不默认增加 feature flag 或永久双实现。需要真正灰度的新语义服务/分类建议复用现有 featureFlags，默认关闭，不能把实验当作已上线 kill switch。
- 工具 schema、description 或能力 hash 改变会影响 checkpoint。发布前确认在途 Turn，采取完成/排空后部署或明确版本兼容，不关闭 snapshot mismatch 检查来“恢复成功”。
- 发布另需明确授权。获得授权后分小批次发布，核对实际部署 revision、前后端版本、关键 API 和浏览器流程；本地 build 不能替代生产验证。
- 回退以独立工作包恢复代码，不 reset 用户工作区、不删数据、不重置 Run。无 schema 变化不等于任意旧版本都兼容新 checkpoint；回退同样处理在途 Turn。
- 类别建议只有真正生效后才需要快速关闭能力；关闭新建议不能改写已冻结运行的语义。

## 8. 初始方案的交付边界（历史记录）

初始方案阶段只交付方案，尚未实施 T01–T09。既有 F1–F3 修复与两份审查/研究报告保留。当时本地验证为 2,885 通过、2 条数据库环境用例跳过；没有为纯方案重复跑全量测试，也未重新验证生产。后续实施结果不沿用该旧计数，见下节。

建议确认后先实施 **O0–O4**，按工作包完成和验证；不每拆一个内部函数就重新请求确认。只有实质改变产品行为、扩大数据访问、增加依赖/基础设施或超出已批准范围时再询问。

暂不要求用户决定具体函数名、拆文件数量、检索 timeout 数字或分类阈值：前两者由代码所有权决定，后两者由基准与校准决定。O5 的模型选择、自托管/托管、数据目的地、费用上限和准入范围在进入实验前再决定；不影响核心优化开始。

## 9. O0–O4 实施与本地验收记录

### 9.1 实际改动及边界

| 阶段 | 已实现 | 保留的约束 |
| --- | --- | --- |
| O0 | 保留既有 F1–F3 改动，固定下表行为回归；记录工具输出与检索冷暖基线 | 不清理工作区、不提交、不调用真实 Provider |
| O1 | `fitToolOutputPage` 选择预算内完整前缀；Ontology/素材组改用实际记录偏移 cursor；Artifact 游标跟随最后交付项；Canvas 连线可单独续页；真实 Tool Loop 检查最终模型消息 | 单工具 2k / 累计 6k token 不扩大；历史压缩保留；无法容纳时显式 blocked，不用头尾预览携带跳项游标 |
| O2a | `agentTurnResultProjection.ts` 统一正常/恢复的消息与生成续接，稳定 Message/Turn 身份 | 不写入原始 reasoning；保留原目标和设置。非法 composition 两路均为失败 notice、completed 阶段；统一保留原时间线，修正此前正常路径丢时间线的差异 |
| O2b | `agentTurnLifecycle.ts` 集中 observer、pending 身份、Stop 意图、去重取消和 lease 归属；UI 异步回调校验当前项目/会话/操作 | 普通切换只断开观察；只有显式 Stop 取消服务端。旧 finally 不清掉新操作；提交状态按会话清理 |
| O2c | `agentPlanDelivery.ts` 统一成套、局部重绘、首图/视频、Planner 四条计划交付；生成意图函数改为描述真实作用的名称；Composer 不再保证“不会出图” | 复用既有执行资格函数；冻结模式与 waiver；张数、外部行动、推断生成意图仍受原确认约束 |
| O3 | `canvasAgentReadSemantics.mjs` 共享名称、状态、窄节点元数据与边 role/system/handles；标记 turn_snapshot / live_project | Ontology 不取得实时查询的正文/坐标/媒体字段；Stage 不冒充批准；不新增实体、DB 表或 Adapter 接口 |
| O4 | Runtime signal/deadline → reader → embedding HTTP；已有 timeout 变为整次预算（默认 5s，最多 15s）；安全计数指标和合成基准 | 父取消/截止不降级成成功；子检索超时可降级 keyword，游标重置显式。维持串行请求、有界缓存、Artifact 1,000 条扫描上限 |

实现入口：

- [工具预算与安全页](/Users/leo/Documents/botanic-canvas/server/agent/tools/agentToolOutput.mjs:16)、[上下文分页](/Users/leo/Documents/botanic-canvas/server/agent/tools/botanicAgentContextTools.mjs:53)、[运维读工具](/Users/leo/Documents/botanic-canvas/server/agent/tools/botanicAgentOperationalTools.mjs:225)。
- [结果投影](/Users/leo/Documents/botanic-canvas/src/features/agent/agentTurnResultProjection.ts:12)、[生命周期](/Users/leo/Documents/botanic-canvas/src/features/agent/agentTurnLifecycle.ts:13)、[计划交付](/Users/leo/Documents/botanic-canvas/src/features/agent/agentPlanDelivery.ts:5)。AgentWorkspace 从 3,897 行降到 3,652 行；没有提高存量预算。三个新模块共 161 行，拥有共享行为，不是把旧组件整体搬家。
- [Canvas 共同读语义](/Users/leo/Documents/botanic-canvas/server/canvas/canvasAgentReadSemantics.mjs:16)、[检索预算和取消](/Users/leo/Documents/botanic-canvas/server/canvas/canvasAgentSemanticSearch.mjs:54)、[合成性能脚本](/Users/leo/Documents/botanic-canvas/scripts/benchmarkAgentSemanticSearch.mjs:1)。

既有 F1–F3 涉及 `agentOntologyContract`、Chat/Turn/Memory 绑定、Ontology、context/operational tools 与 operational reader；本次在这些改动之上完成 O1/O3/O4，未把它们重置。原有两份审查/模型研究报告保留，AGENTS、依赖、架构预算和正式环境配置未改。

### 9.2 行为基线与可运行证据

| 被保护行为 | 所有者及检查 |
| --- | --- |
| 正常发送、项目尚未保存、保存失败原位重试 | `useAgentMessageDelivery`；`e2e/uat-turn-recovery.spec.ts` 前两例，单条原消息恢复、无 404 |
| accepted 后进行中刷新、accepted 回包丢失 | durable Turn / `agentApi` / projection；同一 UAT 的刷新与丢包例，fake Provider 调用数均为 1 |
| Stop 在 accepted 前后、重复取消 | `agentTurnLifecycle.test.ts`、`agentTurnObservation.test.ts`、UAT Stop；保留取消意图、不产生最终回答 |
| 会话切换与迟到事件 | lifecycle lease、AgentWorkspace scope；UAT 读回旧 Turn completed、取消请求为 0、新会话可发送且不含旧结果 |
| 追问续接、原目标/选区/引用/模型设置 | `agentInstructionRouting.test.ts`、`agentTurnObservation.test.ts`、`agentTurnResultProjection.test.ts`，保留既有公开行为测试 |
| 成套、局部重绘、首图、Planner 与人工/自动资格 | `agentPlanDelivery.test.ts`、`agent.test.ts`、`agentCreativeComposition.test.ts`；覆盖 batch waiver、推断意图和不可豁免行动 |
| Run 已接受但回包未到时 Stop、计划确认回执丢失刷新 | `uat-turn-recovery.spec.ts` 的后两例：真实本地 API/Worker + 假图片 Provider；同一 Run、同一取消身份、只派发一次图片请求、历史图片不变 |
| 模型实际收到的分页、预算与权限 | context/operational tool、operational reader、tool runtime 测试；假模型读取真实 Tool Loop 下一轮序列化消息，长字段跨页无漏重且无媒体 URL |
| Ontology/实时查询共同字段、时效及窄投影 | `canvasAgentQuery.test.mjs`、`agentOntologyContract.test.mjs`；不复制 Generate Prompt/媒体信息 |
| 检索总预算、父取消、父截止、降级/游标 | `canvasAgentSemanticSearch.test.mjs`、`agentOperationalReaders.test.mjs`；包含 reader 到 HTTP 的实际取消信号 |

最终业务代码的本地门禁：

- `npm test`：服务端 2,031 通过，前端 868 通过，合计 **2,899 通过、0 失败、2 跳过**。跳过的是两条需要 `AGENT_TEST_PG_SOCKET` 的 PostgreSQL 确认用例，不计为通过。
- `npm run check:architecture`、`npm run build` 通过；Vite 仍有既有大 chunk 提醒，本次未扩展为打包重构。
- `check:security` 通过；`check:evals` 的 9 个确定性样本符合预期，9 个视觉检查未运行，不代表图像质量通过。
- Chromium 本地画布交互 **21/21 通过**；隔离 API + LocalProductStore + fake Provider 的发送/保存重试/进行中刷新/切会话/accepted 丢包/Stop **6/6 通过**。
- 生成 Run 的 Stop 交接、确认回包丢失浏览器检查 **2/2 通过**；合计 8 项服务端持久化 UAT。为适配现有 UI，只修正测试的重试定位、参数区展开和带勾选标记的张数选项，未修改产品控件。数据库、真实 Provider、生产及跨浏览器验证未运行。
- `git diff --check` 通过。本轮按共享行为接口归并实现，并复用项目既有测试/UAT，不新增依赖或测试框架。

日志保存在 `/tmp/botanic-optimization-tests-final.log`、`/tmp/botanic-optimization-build-final.log`、`/tmp/botanic-optimization-evals-final.log`、`/tmp/botanic-optimization-uat-verified.log`、`/tmp/botanic-optimization-uat-generation-ready.log`；截图保存在 `/tmp/botanic-optimization-uat-verified-e2e/` 和 `/tmp/botanic-optimization-uat-generation-ready-e2e/`。隔离栈目录为 `/tmp/botanic-optimization-uat.80DXb9`，不读取仓库 `.env`，假 Provider 仅监听本机、使用合成输入。生图能力仅在隔离进程开启，模型地址固定到本机假服务。此 UAT 的 Store 是 Local，不是 PostgreSQL。

### 9.3 性能结论与后续决策

同环境（Node 26.9.0，darwin arm64）、500 候选、10 对 cold/warm 样本，假 embedding 每批延迟 2ms：

| 指标 | O4 前 | O4 后 |
| --- | ---: | ---: |
| cold p50 / p95 | 28.76 / 36.74 ms | 28.88 / 36.92 ms |
| warm p50 / p95 | 3.09 / 3.86 ms | 2.73 / 3.30 ms |
| cold / warm 请求数 | 11 / 0 | 11 / 0 |

冷路径变化约为计时噪声量级，不能宣称生产提速；收益是总等待上限与取消语义明确。可重跑 `node scripts/benchmarkAgentSemanticSearch.mjs`。本次不加 embedding 并发或数据库下推：没有真实延迟/扫描成本证据支持它们。

Artifact 补测为合成内存 Store、3,000 条历史、3 个稀疏命中：前三页各扫描 1,000 条/命中 1 条/读取 Store 5 次，分别约 1.83、2.19、1.49ms；第四次读到终页，0 条/1 次读取/0.03ms，共 16 次 Store 读取。证明了有界扫描及稀疏命中的续查成本，**不是数据库 I/O 基准**；上线后若该扫描/命中比确实常见且延迟有影响，再评估三个 Adapter 的过滤下推。

发布前仍必须处理工具 schema/description 改变带来的在途 Turn checkpoint 兼容；不能关闭 snapshot mismatch 校验。O5 分类器没有接入、没有传输私有样本；下一阶段只在明确模型目的地、数据与费用边界后开展离线对比，分类输出不能变成批准/授权。

### 9.4 后续实施：在途 Turn 与 O5（2026-09-22）

上述 9.3 的待办已开展，更新如下；原有未提交改动全部保留，未提交/推送/部署。

- 发布策略采用 [在途 Turn 排空与回退流程](../AGENT_TURN_RELEASE_RUNBOOK.md)，不引入旧新 Runtime 双实现，也不弱化快照匹配。新增 `scripts/agentTurnReleaseGate.mjs`，对显式 PostgreSQL/Supabase 连接作全局只读清点，要求所有创建器静止的声明；活动、waiting_user、cancelling、未知状态与列/payload 不一致均阻断。RLS 不能静默过滤，查询失败退出 2，不把项目列表或 stale 列表的零值当排空。
- 新增工具 schema 改版回归，证明旧 prepared/completed Checkpoint 在模型、工具和落盘之前被拒绝；复用终态、receipt 和 fencing 测试。局部恢复测试 171/171；新增脚本门禁 2/2；O5 验证 2/2。
- 本轮全量 `npm test` 2,904 通过，0 失败，2 个 PostgreSQL 环境测试跳过；architecture、build、security、确定性 evals、diff check 通过。9 项视觉评测仍未运行；未因只增脚本/文档/回归而重复 UI UAT。生产数据库清点、RLS 实验、维护窗口、部署和回退演练均未执行，不能宣称可直接上线。
- O5 通过用户提供的 FLock API key，只用合成输入执行 245 次推理。240 条数据按族 120/120 分割，dev 阈值 0.49；本轮六选项设置在 holdout 的 macro-F1 0.168、coverage 13.33%，不准入 shadow/生产。详见 [完整评测报告](O5_CLASSIFIER_EVALUATION_2026-09-22.md) 与同目录机器结果。真实 Planner/Jev 对比、人工 gold 复核、托管权重 revision 与账单尚未验证，不把首轮结果当成完整 O5 选型结论。

本轮日志：`/tmp/botanic-release-turn-focused.log`、`/tmp/botanic-release-o5-test.log`、`/tmp/botanic-release-architecture.log`、`/tmp/botanic-release-o5-build.log`、`/tmp/botanic-release-o5-security.log`、`/tmp/botanic-release-o5-evals.log`。
