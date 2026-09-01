# ADR 0009：Agent 分布式追踪与安全语义事件

## 状态

已采纳，2026-08-28;2026-09-01 修订(CS3:同开关低基数 metrics 与 content-free diagnostics)。W3C 传播与安全 semantic schema 已实现；OTLP traces 默认关闭，GenAI
development semantic conventions 默认关闭。

## 背景

既有 `agent-trace:*` 能把 Run、Job 与 Artifact 组合成产品只读视图，但它不是 W3C Trace ID，也不能跨
API、Redis 与 Worker 建立父子关系。日志事件由不同模块自由拼接，还可能把 URL、Provider 原文或 Prompt
放进任意 detail。Context V2 灰度也只有 active/off，无法先以无副作用 shadow 验证预算与压缩决策。

## 决策

### 1. 产品聚合 ID 与分布式 Trace 分离

- `executionTraceId()` 与 `/trace` API 保持原语义，不改历史 ID、幂等键或公开 DTO。
- W3C `traceparent` 是一次实际执行的网络身份。HTTP 入站提取后建立 server span；Generation、Derived、
  Subagent 队列附带 carrier，Worker 提取并在调用业务 Handler 前删除传播字段。
- 没有 carrier 的历史任务照常执行并建立新的根上下文；可观测性不是业务权威，也不进入 Durable 实体。
- Turn、模型请求和工具调用建立内部/client spans；受控 Provider 与 MCP 出站只传播当前 `traceparent`。

### 2. 隐私边界先于完整传播

- 首版显式使用 `W3CTraceContextPropagator`，不注册 composite baggage propagator。
- 不传播 user/project/session、Prompt、system instruction、tool args/result、Authorization、Cookie、媒体 URL、
  lease token、幂等键或内容 hash；`tracestate` 只在内部 HTTP/队列边界保留，出站第三方时剥离。
- Span 属性只有固定 allowlist。错误只写 `error.type`/code，不调用可能记录 message/stack 的
  `recordException`。Exporter、logger、schema 与 ContextManager 故障不得改变业务执行且不得二次执行操作。

### 3. Vendor-neutral、traces-only

- 领域与 runtime 使用稳定 `@opentelemetry/api`；Node composition root 可选注册 Node trace SDK、
  W3C propagator 与 OTLP/HTTP exporter，目标建议是 OpenTelemetry Collector，不引入厂商 SDK。
- Resource 只含低基数的 namespace/name/version/instance/deployment environment，不放项目或用户。
- `AGENT_TELEMETRY_ENABLED=false` 是默认；标准 `OTEL_EXPORTER_OTLP_*` 变量由 exporter 读取，密钥不进入
  runtime config 或健康接口。
- GenAI conventions 尚未稳定，集中在单一 adapter 并由 `AGENT_GENAI_TELEMETRY_ENABLED=false` 独立控制；
  即使开启也只允许 operation/provider/model 与 token 数，不采集 input/output messages。

### 4. 固定 semantic schema 与迁移双写

`agentSemanticEvent.mjs` 拒绝动态事件名、动态状态和任意 attributes bag。事件仅包含固定版本、W3C 关联、
受控实体 ID、非负计数/耗时、rollout cohort 与 `{code,retryable}`。Run lifecycle 暂时与 legacy
`agent.run.*` 双写，旧日志消费者保持兼容；Context 指标由独立聚合器消费，零分母返回 `null`。

### 5. Context kill、shadow 与 active

决策优先级固定为 kill → active → shadow → control：

- `AGENT_CONTEXT_COMPACTION_V2_ENABLED=false` 是需重启生效的事故总闸门；
- `AGENT_CONTEXT_COMPACTION_V2` 可全局或按 project/user 提供 V2；
- `AGENT_CONTEXT_COMPACTION_V2_SHADOW` 仍返回 legacy，只在权威消息已读后运行纯 compaction/token 算法；
- shadow 不写 Context State/ledger、不调用 Provider、不改变请求返回，只输出 control/candidate token 数与
  would-compact 结果；active 与 shadow 同时命中时只执行 active。

健康接口只回规则形态 `off/scoped/all`、invalid selector 数量与 kill 状态，不返回 selector 或项目/用户 ID。
已经冻结的 Snapshot V2 不能静默降级成 V1；总闸门关闭期间新请求和手动压缩停止，恢复开关后按原快照继续。

## 后果

- 跨实例执行可以在任意 OTel backend 关联，且无需改业务实体或绑定厂商。
- Shadow 能先验证预算、错误率和压缩率，但不能证明模型回答质量等价；质量仍需固定 eval/人工评审。
- 进程崩溃后只靠数据库恢复、且原队列 carrier 已丢失的 attempt 会形成新 trace；后续若需连续视图，应增加
  只含 W3C SpanContext 的私有 durable attempt link，不能把产品 `agent-trace:*` 冒充 W3C parent。
- 当前承诺 traces 与低基数 metrics(2026-09-01 修订):`writeAgentSemanticEvent` 成功投影后旁路
  `agentTelemetryMetrics.mjs`,与日志共用同一安全事件;标签只允许固定枚举(kind/outcome/reason 等),
  所有 `*Id` 丢弃;`agentRuntimeDiagnostics.mjs` 提供 content-free gauges(active turns/pending cancel
  acks/进程内存)。exporter/初始化失败一律 fail-open。OTel Logs 仍非稳定路径,semantic JSON 继续由
  现有日志管道承载。
