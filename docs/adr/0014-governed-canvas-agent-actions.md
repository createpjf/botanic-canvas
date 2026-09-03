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

### 3. 查询实时读取当前项目权威文档

canvas_query 每次经 ProductStore 的当前用户和项目授权读取项目，不信任客户端上传全图。它只返回安全有界投影，不含媒体 URL、字节、完整 Prompt、凭据或 Provider 原始响应。查询使用稳定 ID cursor；hasMore 或 edgesTruncated 必须显式返回，模型不得把截断页描述为全量结果。

### 4. Action Set 先预演、后冻结、再原子提交

后续 Canvas Action Set 在确认前完成规范化、权限/风险判定、结构化 diff 和触达实体前置条件计算。批准 token、intent hash 与 Action Receipt 覆盖完整冻结操作；确认后模型无权追加或改变动作。

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
