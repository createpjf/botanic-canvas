# ADR 0004：可恢复 Agent Turn Runtime

## 状态

已接受并实现。2026-08-28 修订：补齐上下文预算、安全业务引用、原子评审重试、稳定恢复扫描与 durable 取消退出确认（见文末修订记录）。

## 背景

Botanic 已有 Session、Message、Run、GenerationJob 和 Artifact 等独立实体，但聊天、意图解析和计划规划仍通过不同 HTTP 入口编排。浏览器断线时，流事件无法从稳定游标恢复，UI 也容易把临时状态误认为执行事实。

原文只写了「Runtime 提供 execute、cancel 与事件补读」，没有定义**恢复到底恢复什么**。实现因此停在「重新执行整个解析器」：步骤循环在 `runAgentToolLoop` 内，位于 Runtime 下面三层，对话上下文是纯内存累积，持久化的工具事件只有 `{step, toolName, toolCallId, status}` —— 有身份、没有结果。恢复时 Runtime 重新 await 解析器，模型和工具都会被再调一次。本次修订定义 checkpoint 的边界与可重放性。

## 决策

增加项目级 Agent Turn 与追加式 Turn Event。Turn 只拥有一次控制权循环和事件顺序，不复制 Session、Message、Run、Job 或 Artifact 的业务权威。每个 Item 只保存对现有实体的类型化引用。

Runtime 通过一个小 Interface 提供 `execute`、`cancel` 与事件补读；新的 `/api/agent-turns` HTTP/SSE 入口只做 Adapter。旧的 chat、intent、plan 路径在兼容期内保留旧响应形状，但通过 `agentRuntimeRequest.mjs` 的 operation envelope 进入同一 durable Runtime；它们不再直接调用 Provider，也不再把 HTTP close 当取消。Planner/Chat 使用与主 Turn 相同的冻结快照、步骤 Checkpoint、Worker 恢复、accepted/observer 与深取消语义；待客户端迁移完成后移除兼容入口。

浏览器只提交 `sessionId` 与本轮稳定 `inputMessage`；历史消息由服务端从独立 Session/Message 实体重建。迁移期即使请求仍带 `messages`，新路径也必须用服务端投影覆盖，不能把客户端自报的 assistant 历史送进模型或 Turn 快照。相同 Message ID 已持久化时服务端版本胜出。

`threadSummary` 是权威消息的确定性派生检查点，不是系统规则：它按 `user` 角色放在最近窗口之前。客户端设置接口不得写入摘要；普通 Session 更新省略摘要时，各 ProductStore Adapter 必须保留现值。摘要只能保存结构化决策、状态 revision 与 Artifact 的 `id/kind/label` 目录，不保存 Prompt、结果内容、媒体地址或 Provider 推理。

Summary 与最近 Message 共享确定性的 8k token 预算，其中 Summary 最多 2k、最近窗口最多 16 条；当前输入自身超过总预算返回 413。工具输出另设单条 2k、单轮 6k 上限。只有 Provider 明确返回 context overflow 时，同一 model step 才能在任何工具尚未执行前做一次严格裁剪重试；system、当前用户输入和 assistant tool-call/tool message 配对不可破坏。

业务引用不能从任意工具 JSON 递归扫描。只有明确登记的「工具名 + 固定结果路径」可产生引用，每个工具最多 8 条、每个 Turn 最多 24 条；引用随 fenced Checkpoint/Turn 进入稳定助手 Message 投影，再由带逐 Message revision provenance 的 Summary 消费。Message 合并对同 Turn 引用执行省略保留、首次补齐、冲突拒绝；legacy Summary 缺 provenance 时只有完整有界历史才能重建，因此修订/撤回不会留下幽灵事实。

可恢复的工具事件必须先持久化再推送，使用 `(turnId, sequence)` 作为稳定游标；原始 reasoning/answer 只随当前实时响应传输，不写入事件表。

### Checkpoint 边界与可重放性

**Checkpoint 的粒度是步骤边界。** 工具循环有上界（当前 `maximumSteps = 4`），每一步是一次「模型调用 + 该步的全部工具调用」。恢复从最后一个已完成步骤之后继续，不从头重放整轮。

**能否跳过一个已完成的工具，由该工具声明的能力决定**，而不是由是否记下了它的输出决定。这样才能同时满足「恢复不重复调用已完成 Tool」和「不把媒体字节、思维链或 Provider 原始回包写进持久化实体」：

- `read`：恢复时**重新执行**。只读工具幂等且不计费，重跑比持久化输出更安全 —— 输出可能含媒体或私有地址，存下来等于把它们写进了事件表。
- `write` / `costly` / `external`：**不得重新执行**。这类工具已经要求用户确认，而确认本身（绑定参数哈希的短期审批 Token）是已持久化的事实。因此确认边界就是天然的 checkpoint 边界：恢复时按已持久化的审批与其执行回执判断该动作是否已发生，已发生则跳过并沿用回执中的业务引用（Run ID、Job ID、Artifact ID），不重放动作本身。

Action Receipt 不是“动作完成后的缓存”，而是“动作开始前的执行权威”。执行器必须先用提交键和 `intentHash` 原子 claim，
胜出者持租约执行并以同一 Token 条件 settle；其他实例只能读取完成结果、报告执行中或报告参数冲突。超时、租约过期与
不可重放动作的未确认结果进入 `uncertain`，不能自动重试。只有已声明 `safe` 且明确落为 `failed` 的动作可重新 claim。
同一租约的重复 claim/settle 视为传输重试并幂等收敛；首次 claim 后身份、意图、工具与重放策略不可变。数据库 Adapter
以数据库时钟裁决租约并在 claim 事务内校验权限；claim 后撤权不能阻止原持有者 settle。Supabase 的成功 settle 与
Artifact Index、Audit 同事务提交；Local Adapter 仅用于单进程开发，不宣称跨进程互斥。

运行时必须区分 `running` 与 `uncertain`：前者表示另一个持租约执行者仍可能完成，后者表示副作用结果已经无法安全判断。
两者都不能由客户端直接重放，`uncertain` 只能经人工核对或专门的补偿流程解除。MCP 的 AbortSignal 传播只负责停止仍可停止的
网络工作，不把“请求已取消”误当作“外部系统一定没有执行”。

无法按上述规则判定的步骤，Turn 收敛为不可恢复：向用户明确报告「该回合已中断，请重新发起」，并保留到已创建业务实体的导航。**明确的不可恢复优于静默重跑** —— 重跑一个 `costly` 工具会重复计费，而这正是恢复机制要避免的事。

### 取消与传播

Turn 取消只停止尚未提交的模型或工具回合。**已经创建的 Run 必须由 Turn 取消显式传播**，而不是各自独立取消：Turn 进入 `cancelling`，向 `linkedRunIds` 的每个 Run 发出取消，全部传播动作持久化后才进入 `cancelled`。Run 再向其活动 Job 传播。任一层只写自己的状态而不向下传播，等于取消只是打了个标记。

**取消信号不得只存在于进程内。** 多实例部署下取消请求可能落在非执行实例，因此取消必须经持久状态或跨实例总线抵达实际执行实例；仅靠进程内的 AbortController 表只能中断本实例，其余实例会跑到结束后才发现已取消，那是事后丢弃而非中止。

### 生命周期与孤儿回收

Turn 有 `queued` 与 `waiting_user` 两个持久态：前者表示已接受但未开始，后者表示等待用户确认。**Turn 不得一出生就是 `running`** —— 那样进程在首个工具前退出，该 Turn 会永久停留 `running` 且没有任何东西回收它。

非终态 Turn 由派生任务队列按租约回收：超过租约未推进的 Turn 依上述可重放性规则恢复或收敛为失败。Turn 的终态采用「可靠委托」语义：同步 Item 全部终态、长时 Run 已持久化并关联到 Turn 后即可 `succeeded`，不等待 Generation、Review 或 Delivery 完成。

### 读模型

Turn 读模型必须暴露 `lastSequence` 与 `linkedRunIds`。缺少 `lastSequence` 时客户端无法知道从哪里续读，只能重新拉取全部事件；SSE 必须把 `sequence` 作为事件 `id` 下发，客户端凭 `Last-Event-ID` 续接。

### 当前实现与发布顺序

2026-08-28 已按本 ADR 落地：Turn 以 `queued` 创建，通过 lease + fencing token 原子取得执行权；heartbeat、Checkpoint、
Turn Event 与终态都由持有者条件提交。模型返回工具调用后先写 prepared Checkpoint，再允许执行副作用；只读调用保存可重放参数，
写入/计费/外部调用只保存 Action Receipt 身份。回收器 checkpoint-first，不能证明安全时明确失败，不从头静默重跑。

HTTP 请求接受后，Runtime 与连接生命周期分离；断线只 detach。浏览器先 durable 写入带完整 `turnRequestSnapshot` 的 pending 用户
Message；服务端从独立实体重建权威线程上下文，再原子 claim 并持久化同一 request binding，把 Message 关联到 `turnId`，之后才发
SSE `accepted` 或返回普通 HTTP `202 + observer`；持久事件用 `sequence`
作事件 ID。GET observer 以 `after` 分页，客户端刷新后从 Message 重挂，只交付严格递增事件，并用 Turn 派生的稳定助手 Message ID
幂等投影终态；Message 已绑定而 Turn 缺失时 fail closed，不用刷新后的 UI 上下文重建意图。accepted 前的 pending 提交按同一稳定键
退避恢复；Stop 意图先持久化到 Message，拿到 Turn 后再深取消，404/断网不等于已取消。显式 Stop 先写 `cancelling` fence，再跨实例 abort，
按 Turn → Run → Job 深度传播。Redis publish 与
本地 `abort()` 不是完成证据；Worker 在 Provider/heartbeat 退出并释放本地 registry 后以 `signalId + executionGeneration` durable ack，
Worker 崩溃只能等待数据库时钟确认旧 lease 过期。Ack 完成后才原子写 `cancelled` 事件和终态；Run 创建及 Job 提交前后均有
delegation fence 与补偿取消。

兼容 Plan/Chat 的显式幂等键按 operation 命名空间隔离；无键旧调用按 requestId 保留每次 POST 独立执行。SSE 客户端在
`accepted` 后按 Turn 游标续读，不用非流 fallback 重跑模型；`Prefer: respond-async` 的非流客户端直接取得
`202 + runtimeTurn + observer`。Planner continuation 以来源根 Turn 派生稳定子 Turn key。API 与 Worker 恢复共用同一运维只读工具
实现；Worker 的联网检索必须重新消费共享配额，配额能力缺失时 fail closed。

Action `uncertain` 通过服务端权威 Proposal 定位。状态查询不执行工具；确认生效不伪造结果；确认未生效前，客户端先持久化
非敏感 retry key，服务端 v2 授权把该 key 对应的 retry Receipt 原子预留，响应不下发 raw token。新尝试必须使用同一 key 和
fresh approval。授权消费原子绑定 `consumedByReceiptId`；若消费后、retry claim 前进程退出，客户端只能在用户再次明确点击后恢复
同一个 retry key。该 retry 再次未知时只允许人工收口并标记机会耗尽；v1 raw token 仅保留兼容且不得持久化。

ReviewTask 同样使用 execution generation、lease token、heartbeat、prepared checkpoint 与 result/terminal fenced commit。prepared 后失去租约且无法证明 Provider 是否执行时进入 `outcome_unknown`，不得自动重跑。人工接受/拒绝使用 `review_decide`；重新生成是独立、需确认且要求生成权限的 costly `review_retry`。Human Decision、结果上的 `retryMaterialization` 和稳定 queued Run 在一个 ProductStore 原子操作内提交；批量任一冲突整体零写，事务内不调用 Provider。提交后由 `run.submit` sweep 创建 Job；历史 retry 决定缺少可证明物化身份时 fail closed，避免重复计费。

稳定助手 Message 的 `entityReferences` 只允许权威 Message 写路径首次绑定；`CanvasDocument` 迁移兼容写入口在同步独立实体前剥离该字段，不能伪造引用或占用 sticky first-writer。

Generation Job 租约接管若发现本机旧执行 handle 尚未释放，会先请求中止旧 handle，再 fail-safe 退出且不调用 Provider；当前租约留待后续恢复，避免同进程双调用。

Worker 的恢复任务不使用 offset 或固定首页。Supabase 为 Turn、失败 Run 分支、待 Review 与可恢复 Generation Job 持久化 `recovery_updated_at_ms`，由全量写 trigger 从 `updated_at` 回填重算；恢复 RPC 以首屏/续页双静态分支和复合行 cursor 与 `(recovery_updated_at_ms, id COLLATE "C")` partial index 使用同一 keyset，generic plan 下深页 after 条件仍直接进入 Index Cond。清扫器受有界页数、尾部回绕和停滞检测保护，并逐项隔离错误；各类扫描复用已有 Service，单个坏记录不能让更晚记录长期饥饿。

数据库迁移必须按以下顺序执行，不能跳过中间契约或让绕过 claim 的旧实例与新实例滚动混跑：

1. `20260827120000_agent_turn_runtime_statuses.sql`
2. `20260827130000_agent_action_execution_claim.sql`
3. `20260827140000_agent_turn_execution_claim.sql`
4. `20260827150000_agent_action_reconciliation.sql`
5. `20260827160000_agent_recovery_pagination.sql`
6. `20260827170000_generation_job_execution_fence.sql`
7. `20260827180000_agent_thread_summary_cas.sql`
8. `20260828120000_idempotency_request_binding.sql`
9. `20260828130000_agent_branch_retry_claim.sql`
10. `20260828140000_agent_review_execution.sql`
11. `20260828150000_agent_recovery_keyset.sql`
12. `20260828160000_agent_review_retry_atomic.sql`
13. `20260828170000_agent_cancellation_exit_ack.sql`
14. `20260828180000_agent_message_entity_references.sql`

仓库中的 Local/PG/Supabase 契约与 SQL 静态测试不等于生产数据库已迁移；发布前仍需在真实 PostgreSQL/Supabase 做并发 claim、
旧实例排空与回滚演练。

## 后果

- 浏览器刷新和 SSE 断线可以从服务端恢复。
- UI 只能消费 Runtime 读模型，不能伪造工具成功或任务状态。
- Local、PostgreSQL、Supabase Adapter 需要同步实现 Turn 读写与**事件分页**；按游标分页是必需的，恢复不能为了取一个最大序号而全量读取事件。
- 工具定义必须声明能力，且能力决定可重放性。未声明能力的工具按最高风险处理，即不可重放。
- 旧消息、Run 和 Artifact 数据无需重写；Turn 只建立导航和可回放索引。
- 需要故障注入测试覆盖：事件写入成功但 SSE 推送失败、重连重复收到最后事件、实例 A 创建 Turn 实例 B 取消、Run 已创建但 Job 未创建时进程退出、`costly` 工具执行后中断。

## 修订记录

### 2026-08-28

- chat、intent、plan 全部改为 durable operation dispatcher；兼容 URL 只负责响应 presenter，Plan/Chat 补齐 Checkpoint、Worker 恢复、accepted/observer、稳定键和深取消。
- 浏览器在创建 Turn 前先持久化完整 pending Message 请求快照；服务端按权威上下文 claim/binding 后才 link Message 并交付 accepted/202。
- Thread Context、Summary 与工具输出增加确定性 token 预算；当前输入超限 413，Provider overflow 只允许同一步骤、工具前的一次严格裁剪重试。
- 工具业务引用改为白名单路径提取并设置 8/工具、24/Turn 上限；只由稳定 Turn 结果 Message 向 Summary 传播，sticky merge 对漂移 fail closed。
- CanvasDocument 迁移兼容写入口剥离 Message `entityReferences`；只有权威 Message 写路径可首次绑定 sticky 引用。
- Summary 增加逐 Message revision fact provenance，修订和撤回会确定性重算；legacy 数据仅在完整有界历史下升级。
- Review 执行增加 claim/lease/generation/prepared/result fence；未知 Provider 结果不自动重试。
- `review_decide` 与 costly `review_retry` 分离；Human Decision、retry materialization 与稳定 queued Run 原子提交，`run.submit` 后续建 Job。
- Supabase 四类恢复扫描改用全量写 trigger 维护的 `recovery_updated_at_ms`；RPC 以首屏/续页双静态分支和复合行 cursor 与 `(recovery_updated_at_ms,id COLLATE "C")` partial index 同键，generic plan 深页从索引位置起跳，并保留有界页、回绕、停滞保护与毒任务隔离。
- Generation lease 接管遇本机旧执行 handle 时先 abort 并 fail-safe 退出，不触发第二次 Provider 调用，留待 lease 恢复。
- Turn/Run/GenerationJob 取消增加不可变 signal/generation exit ack；Worker 真正退出或数据库证明旧 lease 过期前不宣称 cancelled。
- Local、PostgreSQL、Supabase 契约与迁移链同步到 `20260828180000_agent_message_entity_references.sql`；生产数据库尚需独立迁移与并发门禁。

### 2026-08-27

- 回合请求改为 `sessionId + inputMessage`，浏览器不再上传整段历史；服务端新增权威线程投影 Module。
- 权威投影按 Message ID 去重并限制最近 16 条；Turn 可恢复快照保存该有界投影，而不是客户端自报历史。
- 摘要从 system 提示移到低权限用户上下文；同 ID 的 `pending → answered/submitted` 通过安全 revision 触发增量刷新。
- Session 设置写入不能覆盖摘要；Artifact 检查点仅保留目录字段。
- Action Receipt 改为副作用前原子 claim、租约 Token 条件 settle；同一提交键绑定 intent hash，未知结果落 `uncertain`。
- 同租约重试幂等；数据库内完成授权与时钟裁决；成功 settle 与 Artifact/Audit 原子提交；旧回执写入口改为只插入。
- MCP 接收上层取消信号与受控 intent header；客户端明确区分执行中、未知结果与可安全重试失败。
- 行动状态双写本地兼容视图与独立 Message；离线队列在旧快照发送中仍保留并补送新终态，刷新不再丢失 `uncertain`。
- Turn 增加 queued/claim/lease/fencing、prepared/completed Checkpoint、checkpoint-first reclaim 与 Worker sweep；旧实例不能覆盖接管者。
- HTTP 断线改为 detach，SSE/GET 共享稳定 sequence 游标；客户端做单调去重并在事件排空后结算。
- 用户 Message 增加 Turn 关联；同请求 Turn durable 可读后才发 accepted，刷新按关联恢复并用稳定结果 Message ID 去重；Stop 不再把观察器 abort 当作 durable 取消。
- 取消改为 durable fence + 跨实例 abort + Turn/Run/Job 深传播；运行 Job 需 Worker release ack，崩溃仅在 DB lease 过期后收口；delegation 前后均设 fence 与补偿。
- Action 增加 status/resolve、人工核对、v2 durable retry reservation、retry exhaustion 与 consume→claim 崩溃恢复；默认不下发原始 token，v1 token 也不写 Message。
- 首次线程摘要分页回填到实体上限；同 ID revision 替换、目标先去重再限额，翻页失败不持久化残缺摘要。
- Thread Summary 写回改为独立 CAS，只 patch Session 的摘要子字段，不覆盖并发设置或改变 Session 排序时间。
- Generation Job 增加 execution generation/lease fence、终态先行与投影恢复；Run 写入按分支合并并以 activeJobId 阻断旧 Job 覆盖 retry。

### 2026-08-24

原文要求 Runtime 提供「事件补读」并声明「Turn 中断只停止尚未提交的模型或工具回合」，但没有定义 checkpoint，因此实现无从落地：

- `botanicAgentTurnRuntime.mjs` 返回的接口只有 `execute` / `cancel` / `publicTurn`，没有补读；`listAgentTurnEvents` 无游标参数，恢复时为算一个最大序号而全量读取。
- 非终态 Turn 恢复走的是重新 await 解析器，已完成的工具会被再次调用。
- `cancel()` 只写 Turn 状态，不向 Run 传播，也没有 `cancelling` 中间态；`activeTurns` / `cancelledTurns` 与路由层的 AbortController 表都是进程内结构，跨实例取消只能事后丢弃结果。
- `createAgentTurnRecord` 初始状态是 `running`，没有 `queued`，进程退出会留下永久 `running` 的孤儿 Turn 且无回收者。
- `publicTurn` 不暴露 `lastSequence` 或 `linkedRunIds`；流事件契约无 `sequence` 字段，SSE reader 显式丢弃 `id:`。

本次修订不改变目标，只把「恢复什么、按什么规则跳过、取消如何传播、孤儿由谁回收」写清。核心判断是：**可重放性应由工具能力决定，而不是由是否持久化了工具输出决定** —— 后者会迫使系统把媒体与 Provider 原始回包写进事件表，与本 ADR 既有的安全边界冲突。
