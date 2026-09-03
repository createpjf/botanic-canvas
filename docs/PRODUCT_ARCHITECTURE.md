# Botanic 产品架构与 Ontology

## 1. 产品目标

Botanic 是面向品牌视觉生产的无限画布工作台。用户把素材、文本和生成节点连接为可恢复、可复用、可追溯的创作流程；Agent 在相同项目语义上帮助检索上下文、形成计划并执行经确认的行动。

产品的核心不是单次生成页面，而是持续存在的“项目创作图谱 + 执行记录 + 历史产物”。

## 2. 核心对象

### 2.1 项目与画布

- **Project**：成员、权限、项目元数据和所有项目级实体的授权边界。
- **CanvasDocument**：项目画布的兼容文档视图，包含节点、连线、视角、项目私有素材、模板和历史摘要。
- **CanvasNode**：素材、文本、生成意图、输出媒体或 Frame 在画布上的语义对象。
- **Frame / Stage**：Frame 是可命名的画布组织区域，Stage 是它对应的生产阶段分类；成员最多归属一个 Frame，删除 Frame 只解除归属，不删除成员。
- **Edge**：生成节点的输入关系；生成节点入线是执行配方的唯一来源。

### 2.2 生成与媒体

- **GenerationRecipe**：模型、提示词、比例、分辨率、输入素材和执行参数的稳定快照。
- **GenerationJob**：一次可恢复、可幂等去重的执行记录，是生成状态的权威来源。
- **Output / Candidate**：任务返回的独立输出；每个输出拥有任务内稳定身份并形成独立画布节点。
- **MediaObject**：受授权控制的图片或视频对象；画布只保存稳定同源引用，不保存对象存储凭据。
- **AssetRecord / AssetGroup**：可复用素材及其可选分组。项目私有素材与全局品牌素材拥有不同生命周期。

### 2.3 历史与协作

- **History**：已执行输入和结果的不可变记录。
- **Template**：不含已执行任务和输出的可编辑工作流蓝图。
- **Artifact Index**：项目历史产物的持续目录，保存来源和血缘，不因画布整理而删除。
- **Canvas Graph Revision**：节点/连线协作版本；与项目元数据 `revision` 分开演进。

## 3. Botanic Agent Ontology

### 3.1 Agent 实体

- **Agent Session**：连续创作对话的容器，拥有标题、执行模式和上下文节点。
- **Agent Message**：独立追加或更新的交流记录。用户 Message 先保存不可变 `turnRequestSnapshot`，再用 `turnId` 关联 durable Turn；accepted 前 Stop 以 sticky `turnCancellationRequestedAt` 保留。助手结果用 Turn 派生的稳定 Message ID 投影，业务引用只接受受信工具的白名单路径；`CanvasDocument` 迁移兼容写入口会剥离 `entityReferences`，只有权威 Message 写路径可首次绑定 sticky 引用。结构化创意方案是 `kind: composition` 的消息，不是独立实体。
- **Memory**：成员确认后长期保留的项目创作规则；删除使用墓碑。
- **Skill**：项目内已审核、可复用的版本化执行契约；完整版本快照固定 instructions、capabilities、Manifest、依赖版本与内容摘要，历史版本不可覆盖。
- **Plan**：把用户意图、锁定约束、可变维度和分支组织成可确认的执行方案。
- **Agent Turn / Turn Event**：一次对话控制权循环及其追加式安全事件。Turn 通过租约与 fencing token 保证单执行者，事件序号是断线续读游标；它只引用而不复制 Message、Run、Job 或 Artifact 的业务事实。运行中可拥有 replace-style **TurnOutputPreview**（ADR 0012）：只含有界用户可见 answer，终态原子清除，不是 Message 或完成答案。
- **Subagent / Subagent Activation**：主 Planner 派发的只读调研执行单元。Descriptor 固定模型、指令版本、只读工具、Schema 与预算；Activation 按 sequence 无间隙 FIFO 追加，重放同一 Subtask ID 复用结果。根 Turn 取消按 `rootTurnId` 级联全部 Subagent。
- **Agent Context State / Context Compaction**：模型上下文的权威状态与追加式压缩账本（ADR 0008）。`agent_messages` 始终权威且不删除，公开 Surface 只含哈希与计数；压缩以 DB-clock CAS 推进，Provider body 与原始推理禁止持久化。
- **Agent Run**：计划确认后的可恢复执行记录，拥有分支、任务和最终状态。
- **Review Task / Result / Human Decision**：对 Run 产物的可恢复评审及人工终局。评审执行由租约与 generation fence 保护；重试决定与稳定新 Run 必须原子提交。
- **Action Proposal / Receipt**：调用 Skill 或 MCP 前的确认提议及执行回执。MCP 提案同时固定工具版本与 capability hash，执行时配置漂移会在出网前拒绝。派发后的未知结果只能人工核对；确认未生效后最多预留一次、绑定新回执身份的手动重试，默认不向浏览器下发 raw token。
- **Artifact**：Agent 行动或生成任务产出的媒体、文本、工作流、素材组或文件。

### 3.2 意图与创作维度

Agent 先区分请求路由：

1. 日常对话；
2. Prompt 生成或改写；
3. 项目内容检索；
4. 图片或视频生成计划；
5. 需要明确确认的 Skill / MCP 行动。

生成计划使用受控创作维度表达变化，例如场景、动作、风格、构图、光线和模型参数。素材组仍可驱动按图批量；无素材组时也可按用户确认的变体轴展开分支。张数由展开结果决定，不能由模型手写。Memory 提供项目长期偏好，Skill 描述已审核动作；三者不是同一种对象，不能互相替代。

Agent 只接收必要的结构化元数据。图片字节、对象存储地址和私有媒体 URL 不进入文本模型消息；真实行动必须经过服务端白名单和确认策略。

## 4. 权威来源

| 状态 | 权威来源 | 非权威表现 |
| --- | --- | --- |
| 生成进度与结果 | 持久化 GenerationJob | UI 占位、Toast、本地 loading |
| Agent 执行 | 独立 Agent Run 与分支任务 | 对话卡片的临时进度 |
| Agent 回合控制权与续读 | 持久化 Agent Turn、Checkpoint 与有序 Turn Event | HTTP 连接、进程内 Promise、客户端时间线 |
| Subagent 派发与结果 | 持久化 Subagent Descriptor 与有序 Activation | 进程内执行器、Planner 对话上下文 |
| 模型上下文压缩 | 权威 agent_messages + Context State/Compaction 账本 | Provider 请求体、进程内消息数组 |
| Agent 行动执行权与结果 | 持久化 Action Receipt（intent hash、租约、终态） | HTTP 请求、进程内 Promise、Toast |
| Agent 会话内容 | 独立 Session / Message / Memory 实体 | CanvasDocument 迁移兼容字段 |
| 历史产物 | Artifact Index | 当前画布节点和素材引用 |
| 节点与连线协作 | 服务端 Collaboration Room 的 durable mutation log 与 graph CAS（Sync V2；`sync_protocol_epoch` fencing） | 本机选择态和视角、传输中的 Yjs 增量、浏览器 Outbox |
| 媒体内容 | 授权 MediaObject | 浏览器临时 Object URL |

## 5. 关键执行流

```text
用户意图
  → UI 形成结构化命令
  → Store 组合领域规则与浏览器 Adapter
  → Node HTTP 鉴权、校验和幂等提交
  → Queue / Worker 执行 Provider
  → Media + ProductStore 持久化
  → Realtime 失效通知 / 任务恢复
  → 画布结果节点与 Artifact Index
```

Agent 生成流在“结构化命令”之前增加对话分流、上下文检索、计划和确认；确认之后复用同一生成任务基础设施，不建立第二套任务状态机。

浏览器与 Turn Runtime 的连接只是观察通道：浏览器先持久化带完整请求快照的 pending 用户 Message；服务端再原子持久化 Turn request binding、把权威 Message 关联到 `turnId`，之后才发 `accepted` 或返回 `202` observer。断线或刷新从
用户 Message 的 `turnId` 按 `sequence` 续读，并幂等投影同一助手结果。accepted 前断网用 pending Message 的同一键恢复，Stop 意图也不依赖进程内变量。显式 Stop 先持久化 Turn fence，再传播到关联 Run 与活动
GenerationJob，等待实际 Worker 的 durable release ack 后才完成取消；已经落库的下游任务不能靠丢弃前端状态来“取消”。
模型/工具恢复从持久化步骤 Checkpoint 继续；只读工具可重放，写入、计费或外部行动必须以 Action Receipt 判断，绝不静默再执行。

线程上下文与工具输出均有确定性预算：摘要与最近消息共享 8k token、摘要最多 2k、最近消息最多 16 条；当前输入本身超限直接返回 413。单个工具输出最多 2k、单轮累计最多 6k；只有 Provider 明确返回 context overflow，才允许在同一 model step、任何工具尚未执行前做一次严格裁剪重试。

## 6. 稳定原则

- 同一次提交的超时确认、恢复和网络重试复用同一幂等键；用户明确重新生成才创建新计费尝试。
- Generation Job 的 execution generation 与 lease 是 Worker 写入权威；终态先落 Job，再恢复 Canvas、Artifact 和 Run 投影。分支 retry 后，旧 Job 或旧 Run 快照不能覆盖新 `activeJobId`。租约接管时若本机旧执行 handle 仍占用，接管者 fail-safe 退出且不调用 Provider，保留运行租约交给后续恢复，避免同进程双调用。
- Action 结果未知时不自动重试；浏览器在人工确认未生效前先持久化新幂等键，服务端把一次性 v2 预留原子绑定到该回执，执行时再做 fresh approval。消费后即使进程在 claim 前退出也只能恢复同一回执身份，不能换键再试；v1 raw token 只作为旧服务兼容路径且绝不持久化。
- 评审 retry 是独立的 costly 行动：Human Decision、`retryMaterialization` 与稳定 queued Run 同事务提交，之后由 `run.submit` 恢复器创建 Job；事务内不调用 Provider。旧版只有 retry 决定而缺少物化身份的数据必须 fail closed。
- 恢复扫描使用毫秒时间与 ID 的同一 keyset、有界页数、尾部回绕、停滞保护与逐项毒任务隔离；Supabase 对 Turn、失败 Run 分支、待评审任务和可恢复 Generation Job 持久化 `recovery_updated_at_ms`，由全量写 trigger 从 `updated_at` 重算，并让 RPC 以首屏/续页双静态分支和复合行 cursor 直接匹配 `(recovery_updated_at_ms, id COLLATE "C")` partial index。单个坏项不能阻塞后续任务，generic plan 下的深页也不扫描已翻过的前缀。
- 每个输出独立持久化和展示，选择某个候选不隐藏或删除其他输出。
- 远端任务结果可以纠正本地空节点或旧失败状态，旧草稿不能覆盖新结果。
- 项目权限先在 HTTP 层校验，Adapter 保留第二层归属校验。
- UI、CRDT 和 Agent 对话都不能成为任务、媒体或历史血缘的权威来源。
- 迁移兼容层只用于安全过渡；停止双写必须先满足迁移和多设备验收门禁。

代码所有权和验证入口见 [CODEMAP.md](CODEMAP.md)，模块依赖见 [ARCHITECTURE.md](ARCHITECTURE.md)。
