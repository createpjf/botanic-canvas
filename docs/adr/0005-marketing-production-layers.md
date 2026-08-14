# ADR 0005：营销生产链分层，外部产品不得成为核心依赖

## Context

竞品覆盖趋势信号、品牌治理、Agent 规划、节点生产运行时、Campaign 出包和效果回流。它们不是互相替代，而是同一条营销生产链的不同层。Botanic 已有语义画布、Agent 实体、GenerationJob 和版本化生产工作流。差距是把这些能力收敛成可解释的生产体验，而不是再加一个设计模型。

## Decision

1. 产品按层组合：趋势信号、品牌与产品治理、Agent 规划、DAG 生产运行时、Campaign Kit、审核 / 交付 / 效果回流。外部 SaaS 只作 Adapter，不得成为核心依赖。
2. Build / Buy：必须自建 DAG 运行时、审批权威和血缘审计。Brandwatch / Sprinklr、真实 OAuth、Vision OCR 本轮不接入。
3. UI 只投影服务端实体。`ProductionWorkflowRun` / `NodeRun` / `ApprovalDecision` / `ValidationReport` 拥有整链；Agent 面板不是权威。
4. 批量项运行保持兼容。节点式 DAG（approval / generation / validation / delivery）作为可选图定义叠加，不替换 GenerationJob 幂等与预算语义。
5. 审批或 QA 未通过时，交付节点不得运行。效果回流不得自动修改 Brand Rule Set。

## Consequences

- Agent「发布并执行」只走 `publishMarketingPlanWorkflow` + `startProductionWorkflowRun`。
- `marketingWorkflowRunProjection` 渲染 NodeRun、`approvals[]`、`validationReports[]`，而不只是阶段横幅。
- `demoExecutions` / `runDemoMarketingExecution` 不得作为刷新后的真相来源。
- 外部凭据缺失时 Adapter 保持未配置，不得伪造趋势、OCR 通过或发布成功。
