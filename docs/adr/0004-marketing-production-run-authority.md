# ADR 0004：营销生产运行拥有整链状态

## Context

营销 Plan 只描述策略与节点意图。若由 Agent 面板的本地 `demoExecutions`、计时动画或画布推演承担执行真相，刷新后无法恢复，审批记录不能只追加，失败节点也无法按幂等键重试。

## Decision

营销 Plan 发布后，由固定版本的 `ProductionWorkflowRun` / `NodeRun` 拥有文案审批、海报、预检、渠道变体和交付状态。`ApprovalDecision` 与 `ValidationReport` 只追加。`GenerationJob` 继续只拥有单个模型任务。

Agent 面板与画布只投影服务端实体。`publishMarketingPlanWorkflow` 与 `startProductionWorkflowRun` 是「发布并执行」的唯一入口；文案批准与驳回都调用 `approve-node`。刷新从 `readProductionWorkflowRun` 恢复。重置对称取消服务端 Run。审批或 QA 未通过时，交付节点不得运行。

Fixture 与 Provider 是执行模式，不是第二套状态机：Fixture 可以绑定项目内已有概念样张，但进度仍来自服务端 Run，而不是 `setTimeout` 动画。

## Consequences

- 工作流目录仍暂存在项目文档兼容视图；后续可迁到独立存储而不改变浏览器接口。
- 本地 React 状态、Toast 和教学动画不是权威；不得在刷新后用 `demoExecutions` 重建进度。
- 品牌规则不写入 Agent Memory；工作流版本快照保存当时的规则引用。
