# Bob Agent Core 外层平台收口 — 最终交付报告

日期:2026-09-01(第二阶段)。分支 `harness-reliability-20260901`,基线 rebase 到 `origin/main@f9aaa6b`。
计划来源:已批准的「Botanic Agent Platform 外层收口与升级计划」;对照源码 Codex `rust-v0.152.0@316795b3`。

## 交付 change set(每项一个中文提交)

| # | 提交 | 内容 |
| --- | --- | --- |
| 0A | `ada25b1` | 根 Turn 与 Subagent 删除 `recovery: never` 覆盖,canonical journal 成为唯一事实;两个锁旧语义的测试改写 |
| 0B | `5ff093d` | `cancel_observed`(durable requestedAt→本地 abort 延迟,每执行一次)与 `duplicate_dispatch` guard(先 emit 再 `AGENT_TOOL_DUPLICATE_DISPATCH`,绝不二次外呼);CLI 输出 producerCoverage |
| 1A | `159a75c` | `botanicAgentModelProvider.mjs` 深模块:`sample()` 唯一采样接口,统一错误分类,SSE 归一化,无 transport retry |
| 1B | `320f2a8` | Turn/Chat/Planner/Subagent 迁移到 `provider.sample`;删除四份私有 transport 与死代码;architecture ownership 契约 |
| 1C | `1d713a1` | Vision/ReviewVision/Evaluator/Summarizer/Refinement/Review 六个辅助 caller 迁移;各自 fail-open/具名错误策略保留;生产 `/chat/completions` 仅剩 Provider 与媒体生成 |
| CS2 | `e73160a` | Agent Protocol v1:`agentProtocol.mjs` catalog + 生成器 + 前端生成类型 + JSON Schema;build 前 --check;版本协商 fail closed |
| CS3 | `2f667cb` | OTel metrics(语义事件旁路,低基数标签)+ content-free diagnostics gauges;exporter fail-open;ADR 0009 修订 |
| CS4 | `bd1876d` | ADR 0011 Connector/Credential Gate(仅文档,未采纳) |
| FI 修复 | `4174602` | 故障注入发现:根 Turn 把 `AGENT_TOOL_OUTCOME_UNKNOWN` 吞成 INVALID_PROVIDER_RESPONSE;三个 caller 补 `AGENT_TOOL_*` 透传 |
| UAT | `342d45d` | spec 适配上游会话恢复(f9aaa6b);复跑证据 |

## 证据层

1. **聚焦测试**:每 change set 先跑 touched tests;新增测试遵守 ≤1 主路径 + ≤1 失败路径(Provider 3 个、0B 2 个、Protocol 2 个、CS3 2 个)。
2. **全量门禁**:`npm test` 760 pass / `check:architecture` OK(含新 transport ownership 契约)/ `build`(含 protocol --check)/ `git diff --check` 全绿。
3. **双实例故障注入(复跑)**:真实 Postgres,双 runtime 实例,挂起式崩溃模拟 —— **4/4**:
   - B prepared journal 恢复重执行一次并完成(fetch=1, completed)
   - C dispatched 恢复收口 outcome-unknown 且不重放(fetch=0)
   - E 跨实例深取消传递 abort 且权威状态取消(并观测到 cancel_observed 事件)
   - F 旧代际 commit 被 fence 拒绝(genB>genA, commitKind=stale)
   探针按 H0 规范用后删除;过程中发现并修复一个真实透传缺口(`4174602`)。
4. **浏览器 UAT**:chromium/webkit/mobile-webkit **6/6**(刷新恢复 Provider 调用数不增长;执行中 Stop 不产出最终回答)。firefox 2 例因 Firefox 进程沙箱在本执行环境无法 `sandbox_init`(Operation not permitted)未运行,属环境限制,非产品缺陷。
   栈:smokeLocalStack(Postgres/MinIO/Redis)→ fake Provider(4799,OpenAI-compatible SSE + 计数器)→ PORT=8787 API/Worker → `VITE_PERSISTENCE_MODE=server` Vite(4173,playwright reuse)。已全部拆除。
5. **真实 Provider 小流量**:未执行——需维护者授权。
6. **生产 cohort/灰度**:未执行——需部署。发布顺序约束:V2 reader 全量 → journal writer(0A)放量 → Provider shadow → Protocol additive → metrics exporter。

## 剩余条件项(全部有明确 Gate)

- H3C transport retry:仅当真实 cohort 7 天窗口 ≥20 个 transport/429/5xx 样本且失败率 ≥0.5% 时启用(设计约束见计划)。
- H8 只读工具并发:等 H7 生产指标证明串行是瓶颈。
- Connector/Credential:ADR 0011 的四个 Gate(具名首个 Connector/凭据 schema 批准/Protocol 稳定/仅声明式)。
- SDK / inbound MCP / Thread archive-search-fork:依赖 Protocol v1 稳定与产品需求。
- `providerCallTimeoutCount` 已有 producer(Provider 模块);`providerRetryCount` 保持 retry_policy_disabled 标注。

## 未做(有意)

shell/exec、apply-patch、文件系统、Code Mode、OS sandbox/Guardian、plugin marketplace、本地模型、raw rollout、无界重连——理由与演进路线见 `docs/handoffs/2026-09-01-codex-full-layer-gap-analysis.md` 与 ADR 0011。
