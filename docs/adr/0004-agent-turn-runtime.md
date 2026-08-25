# ADR 0004：可恢复 Agent Turn Runtime

## 状态

已接受。2026-08-24 修订：补齐 checkpoint 语义、取消传播与孤儿回收（见文末修订记录）。

## 背景

Botanic 已有 Session、Message、Run、GenerationJob 和 Artifact 等独立实体，但聊天、意图解析和计划规划仍通过不同 HTTP 入口编排。浏览器断线时，流事件无法从稳定游标恢复，UI 也容易把临时状态误认为执行事实。

原文只写了「Runtime 提供 execute、cancel 与事件补读」，没有定义**恢复到底恢复什么**。实现因此停在「重新执行整个解析器」：步骤循环在 `runAgentToolLoop` 内，位于 Runtime 下面三层，对话上下文是纯内存累积，持久化的工具事件只有 `{step, toolName, toolCallId, status}` —— 有身份、没有结果。恢复时 Runtime 重新 await 解析器，模型和工具都会被再调一次。本次修订定义 checkpoint 的边界与可重放性。

## 决策

增加项目级 Agent Turn 与追加式 Turn Event。Turn 只拥有一次控制权循环和事件顺序，不复制 Session、Message、Run、Job 或 Artifact 的业务权威。每个 Item 只保存对现有实体的类型化引用。

Runtime 通过一个小 Interface 提供 `execute`、`cancel` 与事件补读；新的 `/api/agent-turns` HTTP/SSE 入口只做 Adapter。旧的 chat、intent、plan 路径在兼容期内保留旧响应形状，但复用同一回合解析器；待客户端迁移完成后移除兼容入口。

可恢复的工具事件必须先持久化再推送，使用 `(turnId, sequence)` 作为稳定游标；原始 reasoning/answer 只随当前实时响应传输，不写入事件表。

### Checkpoint 边界与可重放性

**Checkpoint 的粒度是步骤边界。** 工具循环有上界（当前 `maximumSteps = 4`），每一步是一次「模型调用 + 该步的全部工具调用」。恢复从最后一个已完成步骤之后继续，不从头重放整轮。

**能否跳过一个已完成的工具，由该工具声明的能力决定**，而不是由是否记下了它的输出决定。这样才能同时满足「恢复不重复调用已完成 Tool」和「不把媒体字节、思维链或 Provider 原始回包写进持久化实体」：

- `read`：恢复时**重新执行**。只读工具幂等且不计费，重跑比持久化输出更安全 —— 输出可能含媒体或私有地址，存下来等于把它们写进了事件表。
- `write` / `costly` / `external`：**不得重新执行**。这类工具已经要求用户确认，而确认本身（绑定参数哈希的短期审批 Token）是已持久化的事实。因此确认边界就是天然的 checkpoint 边界：恢复时按已持久化的审批与其执行回执判断该动作是否已发生，已发生则跳过并沿用回执中的业务引用（Run ID、Job ID、Artifact ID），不重放动作本身。

无法按上述规则判定的步骤，Turn 收敛为不可恢复：向用户明确报告「该回合已中断，请重新发起」，并保留到已创建业务实体的导航。**明确的不可恢复优于静默重跑** —— 重跑一个 `costly` 工具会重复计费，而这正是恢复机制要避免的事。

### 取消与传播

Turn 取消只停止尚未提交的模型或工具回合。**已经创建的 Run 必须由 Turn 取消显式传播**，而不是各自独立取消：Turn 进入 `cancelling`，向 `linkedRunIds` 的每个 Run 发出取消，全部传播动作持久化后才进入 `cancelled`。Run 再向其活动 Job 传播。任一层只写自己的状态而不向下传播，等于取消只是打了个标记。

**取消信号不得只存在于进程内。** 多实例部署下取消请求可能落在非执行实例，因此取消必须经持久状态或跨实例总线抵达实际执行实例；仅靠进程内的 AbortController 表只能中断本实例，其余实例会跑到结束后才发现已取消，那是事后丢弃而非中止。

### 生命周期与孤儿回收

Turn 有 `queued` 与 `waiting_user` 两个持久态：前者表示已接受但未开始，后者表示等待用户确认。**Turn 不得一出生就是 `running`** —— 那样进程在首个工具前退出，该 Turn 会永久停留 `running` 且没有任何东西回收它。

非终态 Turn 由派生任务队列按租约回收：超过租约未推进的 Turn 依上述可重放性规则恢复或收敛为失败。Turn 的终态采用「可靠委托」语义：同步 Item 全部终态、长时 Run 已持久化并关联到 Turn 后即可 `succeeded`，不等待 Generation、Review 或 Delivery 完成。

### 读模型

Turn 读模型必须暴露 `lastSequence` 与 `linkedRunIds`。缺少 `lastSequence` 时客户端无法知道从哪里续读，只能重新拉取全部事件；SSE 必须把 `sequence` 作为事件 `id` 下发，客户端凭 `Last-Event-ID` 续接。

## 后果

- 浏览器刷新和 SSE 断线可以从服务端恢复。
- UI 只能消费 Runtime 读模型，不能伪造工具成功或任务状态。
- Local、PostgreSQL、Supabase Adapter 需要同步实现 Turn 读写与**事件分页**；按游标分页是必需的，恢复不能为了取一个最大序号而全量读取事件。
- 工具定义必须声明能力，且能力决定可重放性。未声明能力的工具按最高风险处理，即不可重放。
- 旧消息、Run 和 Artifact 数据无需重写；Turn 只建立导航和可回放索引。
- 需要故障注入测试覆盖：事件写入成功但 SSE 推送失败、重连重复收到最后事件、实例 A 创建 Turn 实例 B 取消、Run 已创建但 Job 未创建时进程退出、`costly` 工具执行后中断。

## 修订记录

### 2026-08-24

原文要求 Runtime 提供「事件补读」并声明「Turn 中断只停止尚未提交的模型或工具回合」，但没有定义 checkpoint，因此实现无从落地：

- `botanicAgentTurnRuntime.mjs` 返回的接口只有 `execute` / `cancel` / `publicTurn`，没有补读；`listAgentTurnEvents` 无游标参数，恢复时为算一个最大序号而全量读取。
- 非终态 Turn 恢复走的是重新 await 解析器，已完成的工具会被再次调用。
- `cancel()` 只写 Turn 状态，不向 Run 传播，也没有 `cancelling` 中间态；`activeTurns` / `cancelledTurns` 与路由层的 AbortController 表都是进程内结构，跨实例取消只能事后丢弃结果。
- `createAgentTurnRecord` 初始状态是 `running`，没有 `queued`，进程退出会留下永久 `running` 的孤儿 Turn 且无回收者。
- `publicTurn` 不暴露 `lastSequence` 或 `linkedRunIds`；流事件契约无 `sequence` 字段，SSE reader 显式丢弃 `id:`。

本次修订不改变目标，只把「恢复什么、按什么规则跳过、取消如何传播、孤儿由谁回收」写清。核心判断是：**可重放性应由工具能力决定，而不是由是否持久化了工具输出决定** —— 后者会迫使系统把媒体与 Provider 原始回包写进事件表，与本 ADR 既有的安全边界冲突。
