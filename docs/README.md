# Botanic 文档索引

## 当前规范

- [产品架构与 Ontology](PRODUCT_ARCHITECTURE.md)
- [代码地图](CODEMAP.md)
- [模块接口与依赖方向](ARCHITECTURE.md)
- [版本与 PR 流程](DEVELOPMENT_WORKFLOW.md)
- [安全运营与恢复](SECURITY_OPERATIONS.md)

## 架构决策

- [ADR 0001：语义化生成图谱](adr/0001-semantic-node-graph.md)
- [ADR 0002：Agent 独立实体持久化](adr/0002-agent-entity-persistence.md)
- [ADR 0003：项目级 Artifact Index](adr/0003-project-scoped-artifact-index.md)
- [ADR 0004：可恢复 Agent Turn Runtime](adr/0004-agent-turn-runtime.md)
- [ADR 0005：可执行 Creative Plan 与不可变配方](adr/0005-executable-creative-plan.md)
- [ADR 0006：Agent 质量、记忆与 Skill 治理](adr/0006-agent-quality-memory-governance.md)
- [ADR 0007：Durable Subagent Runtime](adr/0007-durable-subagent-runtime.md)
- [ADR 0008：Agent Context Compaction V2](adr/0008-agent-context-compaction-v2.md)
- [ADR 0009：Agent 分布式追踪与安全语义事件](adr/0009-agent-distributed-tracing.md)
- [ADR 0010：MCP Runtime V2 与 Skill Manifest 快照](adr/0010-mcp-runtime-skill-manifests.md)
- [ADR 0011：Agent Connector 与凭据边界(Gate,未采纳)](adr/0011-agent-connector-credential-gate.md)
- [ADR 0012：Agent Turn 运行中输出预览持久化](adr/0012-agent-turn-output-preview.md)

## 功能规格

- [Prompt Pack MVP](BOTANIC_PROMPT_PACK_MVP.md)
- [服务端迁移说明](product-server-migration.md)

## 进行中的设计

以下规格正在本轮实现，完成后以代码与测试为准：

- [画布同步协议 V2：研究与重设计](CANVAS_SYNC_PROTOCOL_RESEARCH_AND_REDESIGN_2026-08-31.md)——**发布状态见 [审查记录](agents/issue-tracker.md)**：代码已纳入 Release Candidate，但部分 Supabase migration（SYNC-02/19/20 对应项）尚未应用、`sync_protocol_epoch` 尚未切换；接手同步协议改动前必读。

## 历史归档

`docs/archive/` 保存特定时点的评审、验收、交接报告与已完成的设计规格（`reviews/`、`handoffs/`、`superpowers/`）。这些文档**不代表当前规范**，只作历史证据；当前入口永远是本索引的「当前规范」与「架构决策」。归档策略：一次性报告完成即入档，不在根目录堆积；引用历史文档时注明其时点。`.agents/plans/` 中已完成的专项计划同理。
