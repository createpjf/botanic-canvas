# ADR 0014：受治理的 Canvas Agent 查询与行动集

- 状态：采纳
- 日期：2026-09-02

## 背景

Botanic 已有 Durable Turn、行动确认、Action Receipt、GenerationJob、Artifact Index 和 durable Canvas Graph commit。Agent 也能创建已确认生成计划，并执行改文字、调参数、删节点三种动作；但它只能读取当前选择的窄上下文，复杂画布请求容易停留在口头建议，或被拆成多次非原子修改。

TapNow 公开工作流中的“明确上下文→确认→计划→执行→定向修订→交付”和保留批准版本值得采用，但其内部存储与并发实现未公开，不构成本项目的架构依据。

## 决策

### 1. 模型表达领域意图，不拥有内部图谱格式

模型只能使用受限查询和领域操作；可以引用查询所得的稳定 Artifact ID，但不能提交完整 CanvasDocument、React Flow node/edge、媒体地址、Artifact 内容或 Job/Run/output 权威身份。服务端将领域操作解析为内部图谱变更。

### 2. 权威实体与系统血缘不可伪造

- Result 只能由 GenerationJob 输出或 Artifact Index 投影产生。
- Job、Run、submission key、candidate/version 身份只能由拥有它们的领域模块产生。
- system、output、prompt、parent 等系统血缘边只能由对应生成/投影模块产生。
- 删除画布投影不删除历史 Artifact。
- 历史 Artifact 复用只投影生成图片/视频；服务端在提案和执行时有界解析并校验 Artifact hash，模型不能提供 Result 内部字段。
- preserve/change 使用固定创意维度，编译进新 Generate 的执行契约；复用不创建 Job 或 system/output 血缘边。
- organize_nodes 只用于精确位置、可选名称与 Frame 归属；声明式 layout_nodes 接收 row/column/grid/workflow/align/distribute 意图，由服务端纯布局 kernel 按稳定顺序和节点视觉尺寸计算绝对坐标。create_frame / update_frame 管理可命名 Stage 泳道；成员坐标始终是画布绝对坐标，不持久化 React Flow parentId/extent/runtime width/height，不允许 Frame 嵌套，删除 Frame 只解除归属。全部操作都受 touched hash、活动节点规则、冻结 Preview 和单次提交约束；工作流提升复用现有 workflow_create/workflow_publish 审批链。

### 3. 查询实时读取当前项目权威文档

canvas_query 每次经 ProductStore 的当前用户和项目授权读取项目，不信任客户端上传全图。nodes 模式返回安全有界投影；aggregate 对完整过滤集按 type/status/stage 确定性计数且不返回节点正文；keyword 只索引 ID、类型、短名称、Text/Prompt 有界正文、状态与 Stage，以全部词命中、score 后稳定 ID 排序并用同一 cursor 分页。媒体 URL、字节、Generate Prompt、凭据或 Provider 原始响应永不进入投影或检索语料。semantic/hybrid 由默认关闭的 OpenAI-compatible /embeddings Adapter 按稳定 ID 内部分页、对最多 500 个安全候选分批（每批 50 个）派生向量；相同 Provider 模型与安全文本的向量在进程内有界 LRU 复用，正文变化自然失效，不持久化索引。Provider 禁用、未配置或失败时显式降级 keyword，并保留当前节点 cursor，避免分页返回重复首屏；派生分数不成为 Canvas authority。hasMore 或 edgesTruncated 必须显式返回，模型不得把截断页描述为全量结果。

### 4. Action Set 先预演、后冻结、再原子提交

后续 Canvas Action Set 在确认前完成规范化、权限/风险判定、结构化 diff 和触达实体前置条件计算。Preview 同时冻结变更节点、连线和未变化端点的安全 context 投影；确认卡的 display-only SVG 只由该 DTO 确定性生成，并保留语义列表，不读取实时 Canvas。批准 token、intent hash 与 Action Receipt 覆盖完整冻结操作；Preview/SVG 不是授权凭据，确认后模型无权追加或改变动作。

执行时重新读取权威项目并验证触达实体。无关协作变更不阻塞；触达节点或边变化返回明确冲突，要求重新查询和提案。全部操作一次性通过 commitCanvasProjectMutation 提交，任一操作失败则整组零写入。

### 5. 兼容入口只做翻译

现有 canvas_read 暂时保留，但有权威 reader 时附加与 canvas_query 相同的安全投影。现有单动作编辑入口在 Action Set 落地后翻译成单操作 Action Set，不保留第二套领域规则。

## 结果

### 正面

- Agent 能在大画布上分页检索并证明结果是否完整。
- 复杂修改可以一次确认、一次提交，重试不重复、冲突不半写。
- 模型工具接口不随 React Flow 或 CanvasDocument schema 演化。
- 现有权限、恢复、Artifact 和协作语义继续作为权威。

### 代价

- 查询和预演输出必须有严格大小上限。
- 领域操作需要显式白名单；新增能力不能直接透传任意 patch。
- 触达实体并发变化会要求用户重新确认，而不是猜测合并。

## 非决策

- 本 ADR 不引入新数据库表、第二套同步协议或通用工作流引擎。
- 不裁定协作安全的整组 Undo；使用数据证明必要后另立 ADR。
- 不把评审状态复制成节点上的第二份 approved 权威。
- 不为 crop、relight、outpaint 等 Provider 功能建立独立顶层 Agent 工具。
