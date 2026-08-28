# ADR 0008：Agent Context Compaction V2

## 状态

已采纳，2026-08-28。实现默认关闭；只有 staging 数据库迁移与门禁通过后才能灰度开启。

## 背景

旧线程上下文用固定 8k 输入预算、结构化 Thread Summary 与最近消息窗口控制长度。这条路径能防止
单次请求无限增长，但没有统一表示一次 Provider 真正看到的 messages、tools、媒体估算与输出预留，
也没有可跨实例重放的压缩 head。不同实例若在恢复时各自裁剪，会对同一 Durable Turn 构造出不同
模型输入；只依赖字符估算，又无法利用 Provider 已回传的 usage 校准后续压力。

Compaction V2 解决的是「如何安全派生下一次模型输入」，不是消息保留策略。独立
`agent_messages` 仍是对话权威，不能因为模型窗口变小而删除、覆盖或改写原始 Message。

## 决策

### 1. 权威消息与 Model Context Surface 分层

- Session/Message 独立实体保存完整对话历史，Compaction 只产生可重放的模型输入投影。删除画布节点、
  关闭灰度或推进 compaction head，都不得删除原始 Message。
- `agentModelContextSurface.mjs` 是 Provider messages/tools 的单一边界。完整 payload 只保存在进程内
  `WeakMap`；公开 Surface V1 只有模型、策略、计数和哈希，序列化它不会得到 Prompt、工具结果或媒体。
- `system` / `developer` 前缀不可被压缩；assistant tool call 与其全部 tool result 是一个原子 unit，
  不能裁成无结果调用或孤立 tool 消息；当前用户消息及其后的内容不能被本次压缩替换。
- 长 tool result 可在 ephemeral Surface 上做确定性的 head/tail prune。它不回写 Message，操作记录只含
  哈希与长度。历史压缩用一个 `role: user` 的受限 checkpoint 替换连续旧前缀，并保留近期完整 unit；
  结果不比来源更小时不得提交。

### 2. 模型策略不猜测 Provider 规格

上下文策略按以下顺序解析：

1. `AGENT_MODEL_CONTEXT_POLICIES_JSON` 中精确匹配的 model；
2. 经审核的 `default`；
3. 内置 `legacy-v1` 安全回退。

不做模糊模型名匹配，也不根据产品名猜窗口。`legacy-v1` 使用 12k context window、3k output reserve、
1k safety margin，即最多 8k input，与旧路径边界一致。每次执行冻结包含 `id/source/model/hash` 的策略；
压缩记录绑定 policy id/hash/model，策略变化后不得把旧 checkpoint 当作当前模型的有效 head。

### 3. Surface 与 Token Meter 共同裁决压力

Token Meter 对同一 Surface 确定性计算 system/developer、普通消息、工具定义、媒体与结构开销，并把
output reserve 和 safety margin 一并计入压力。`surfaceHash` 标识完整投影，`staticHash` 标识模型、
策略、指令前缀、工具集与输出预留。

Provider 返回可验证 usage 时，只持久化数值与上述哈希形成 Usage Anchor：

- Surface 未变化时使用 Provider 的 input token 观测；
- static surface 相同但历史有变化时，在锚点上追加确定性的 heuristic delta；
- 锚点不匹配或 usage 缺失时回到保守 heuristic；
- 最终估算不低于 heuristic，避免较小的历史锚点掩盖当前超限。

Meter 先于每个 model step 执行。达到策略阈值时先 prune、再 compact；Provider 明确返回 context
overflow 时，只允许在同一步、任何工具执行前强制压缩后重试一次。第二次失败直接上抛，不继续调用
Provider。

### 4. State + append-only transition ledger

Local、PostgreSQL 与 Supabase Adapter 共同实现：

- `agent_context_states`：每个 Session 一条当前 V2 state，含单调 `revision`、可选
  `headCompactionId + headCompactionSequence`、可选 Usage Anchor 与数据库更新时间；
- `agent_context_compactions`：成功 CAS 的 append-only transition ledger，`sequence = revision`。
  只更新 Usage Anchor 的 transition 也入账，以便旧幂等键在 head 推进后仍可 replay；这类行的
  `compaction_id` 为空，不出现在 `listAgentContextCompactions`，所以公开 sequence 允许有间隔。

提交真正 compaction 时，head ID 与 head sequence 同时更新到本次 revision；usage-only transition
保留原 head。State 的 owner 由首次建立者确定，后续 Editor 更新不得改写。Ledger 不提供 update/delete
路径；原始 Message 表也不在任何 Context CAS 事务中被修改。

### 5. CAS 与幂等绑定

成员可以读取 Context state/ledger，只有 Editor 或 Owner 可以写。数据库 Adapter 在事务内锁住所属
Session，用数据库时钟校验权限并推进 revision；Supabase 写入只允许 service-role 调用原子 RPC，缺表、
缺函数或权限不完整时 fail closed，不能回退为应用进程内比较再分步写。

`expectedRevision` 只表示调用者观察到的 head，用于 CAS，不属于语义请求哈希。请求哈希绑定规范化后的
`projectId + sessionId + usageAnchor/compaction`：

- 新幂等键且 expected revision 匹配：原子追加 ledger 并推进 state；
- 同一 key、同一语义 payload：即使当前 head 已继续推进，也 replay 第一次提交的原始结果；
- 同一 key、不同 payload：明确 conflict；
- 新 key 携带陈旧 revision：返回当前 state 的 conflict，不产生 ledger 行。

这种边界同时避免网络重试产生第二个 checkpoint，以及把 `expectedRevision` 放进哈希后导致成功请求永远
无法 replay 的错误。

### 6. Snapshot V1/V2 共存

| 版本 | 产生条件 | 持久化语义 |
| --- | --- | --- |
| Thread Context Snapshot V1 | `AGENT_CONTEXT_COMPACTION_V2` 未开启 | 保留旧的有界 messages、Thread Summary 与 `contextBudget`；不要求 V2 Store 接口 |
| Thread Context Snapshot V2 | 灰度命中且模型已冻结 | 保存冻结 policy、compaction head/checkpoint、带 revision 的近期消息、message cursor hash、meter、state revision 与可选 Usage Anchor |

Snapshot 是 Durable Turn 请求身份的一部分。已经持久化的 V1 Turn 按 V1 恢复，不在恢复时借当前 Session
重算成 V2；V2 同样按保存的 head、消息 revision 与策略恢复。部署 V2 不做历史 Turn 的原位 backfill，
因此开启或回滚 Flag 都不会改变已经接受的 Turn 语义。

### 7. 手动压缩端点

`POST /api/projects/:projectId/agent-sessions/:sessionId/context-compactions` 是运维/编辑动作：

- 必须命中 `AGENT_CONTEXT_COMPACTION_V2` 灰度、具备项目 Editor 权限并提供有效 `Idempotency-Key`；
- 服务端从权威 Session/Message、冻结模型策略和当前 state 构造请求，以
  `force: true, trigger: "manual"` 调用同一 Coordinator；
- 客户端不能上传 checkpoint、ledger、Usage Anchor 或历史消息来替代服务端权威；
- 端点不调用 Provider、不产生模型费用，也不删除 Message；没有可替换旧前缀时返回可解释的
  `no_change`，重复提交按相同 CAS/幂等规则 replay。

手动路径不是第二套压缩算法，只是显式触发同一个确定性投影与持久化边界。

### 8. Provider 数据禁止持久化

Provider 原始 response body、`reasoning_content`、analysis、完整工具结果、媒体字节、私有媒体地址与凭据
不得进入 Context state、ledger、checkpoint、Thread Context Snapshot、Message、Plan、Run 或 Artifact
Index。`AGENT_RAW_REASONING=true` 只允许当轮实时下发原始推理，仍不得落盘。Context 持久层递归拒绝
原始推理字段；checkpoint 还要脱敏凭据、data URL、媒体引用与外部链接，并受长度上限约束。

Provider body 只在进程内解析为标准 usage；可持久化的是经过验证的 Usage Anchor，不是原始回包。

## 发布与 staging migration gate

`AGENT_CONTEXT_COMPACTION_V2` 是 active rollout flag，默认 `false`，可按 project/user 灰度；
`AGENT_CONTEXT_COMPACTION_V2_SHADOW` 同样默认关闭，只运行纯投影并继续提供 V1；
`AGENT_CONTEXT_COMPACTION_V2_ENABLED` 是默认开启、需重启生效的事故总闸门。发布顺序固定为：

1. 保持 Flag 关闭，先在 staging 执行
   `supabase/migrations/20260828210000_agent_context_compaction_v2.sql`；
2. 验证两表、RLS、service-role-only CAS RPC、成员读/Editor 写和缺权限 fail-closed；
3. 用至少两个 API 实例验证 CAS 冲突、历史幂等 replay、usage-only sequence 间隔与 DB clock；
4. 对迁移前后 `agent_messages` 数量、revision 与内容哈希做对账，确认压缩没有删除或改写消息；
5. 先对 staging 测试项目开启 Shadow，确认 0 Store write、0 Provider call、无敏感字段，再开启 active，
   验证 V1/V2 Snapshot、自动/overflow/manual 三条触发路径与恢复；
6. 门禁通过后才允许生产按项目灰度，再逐步扩大。

Migration 未执行时，Supabase Adapter 必须返回 `AGENT_CONTEXT_PERSISTENCE_REQUIRED`；不得开启 active Flag，也不得
让单实例内存路径冒充多实例安全。回滚只关闭 Flag 并停止产生新的 V2 Snapshot，保留 state、ledger 与
原始 Message 供审计，不删除迁移数据。

## 后果

- 多实例可以从同一 compaction head 构造一致的模型输入，并安全 replay 网络重试。
- Provider usage 能校准估算，但缺失或不匹配时仍有确定性的保守回退。
- 历史消息、审计与 Artifact 血缘不因窗口治理丢失。
- 代价是增加两张表、一次 CAS/RPC 边界、版本共存与 staging 多实例迁移门禁；Feature Flag 关闭时旧路径保持不变。
