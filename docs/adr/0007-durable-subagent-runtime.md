# ADR 0007：Durable Subagent Runtime

## 状态

已采纳，2026-08-28。

## 背景

旧 `subagent_research` 在根 Planner 进程内 `Promise.all` 执行。浏览器断线、API 重启或
根 Turn 被接管时，子任务没有独立身份、恢复游标与取消状态；同一次工具调用可能重复
消耗模型额度，也无法证明根 Turn 已取消后没有旧执行者继续派发。

## 决策

- `AgentSubagent` 是服务端固定能力的 Descriptor；模型、指令版本、只读工具白名单、
  输出 Schema 与预算在创建时冻结，客户端不得提交或覆盖。
- 每次输入形成 gapless `Activation`，并原子创建输入 Message 与独立 Durable Turn；
  同一 Descriptor 内严格 FIFO，前一 Activation settle 后才投递下一项。
- Planner 以稳定 Subtask ID 通过 `agentSubagentBroker` 创建或重放 Activation，并只从
  权威 assistant Message 读取严格 JSON 提案。正式 API/Worker 不回退旧进程内 Runner。
- running 根 Turn 派发必须在同一 Store 锁内匹配当前 `execution generation + leaseToken`；
  takeover 后旧执行者即使尚未退出，也不能产生新 Activation。completed/waiting_user
  根 Turn 只接受没有执行租约的外部派发。
- 子 Agent 只能使用服务端 Registry 中无需确认、不会写入或产生终态的工具。它只能
  返回 `proposal` / `artifact_candidate`，不能修改画布、提交生成、调用 MCP 或审批自己。
- Subagent 使用独立 BullMQ 队列、并发与恢复扫描。Descriptor/Activation lease、Turn
  lease 和 cancel generation 共同阻止重复执行者提交终态。
- 根 Turn 的深取消在 durable fence 后按 `rootTurnId + id` 稳定分页取消全部 Subagent；
  任一子项仍 pending 或读取失败时，根 Turn 继续保持 `cancelling`，由 Sweep 重试。
- 普通 Session/Message 列表默认排除 Subagent 会话；专用资源只返回公共 Descriptor、
  Activation 与安全提案，不返回 owner、幂等摘要、lease、signal 或原始推理。

## 持久化与迁移

Local、PostgreSQL、Supabase Adapter 实现相同 11 项契约。数据库实现使用数据库时钟、
行锁和事务；Supabase 的 SECURITY DEFINER RPC 仅授权 `service_role`，表启用 RLS 并显式
声明 Data API grants。迁移见 `20260828200000_agent_subagent_runtime.sql`。

## 后果

主 Planner 的并行调研可在断线、重启和多实例接管后安全续跑，取消树与成本边界可审计；
代价是增加两类实体、一条专用队列和一次数据库迁移。未运行迁移的生产实例必须 fail
closed，不允许退回进程内执行路径。
