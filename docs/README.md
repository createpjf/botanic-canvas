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

## 功能规格

- [Prompt Pack MVP](BOTANIC_PROMPT_PACK_MVP.md)
- [服务端迁移说明](product-server-migration.md)

## 进行中的设计

以下规格正在本轮实现，完成后以代码与测试为准：

- [批量变体：共享提示词、按支回填、尺寸与自定义像素](superpowers/specs/2026-08-19-variation-prompt-writeback-size-design.md)
- [Agent 深度思考时间线与联网检索](superpowers/specs/2026-08-19-agent-thinking-web-search-design.md)

## 评审与历史记录

以下文档记录特定时点的评审、验收或迁移阶段，不代表当前通用开发规范：

- [产品与代码深度评审（2026-08-16）](PRODUCT_CODE_REVIEW_2026-08-16.md)
- `P0-6_MIGRATION_ACCEPTANCE.md`
- `PR15_REVIEW.md`
- `RELEASE_ACCEPTANCE_2026-08-04.md`
- `RELEASE_ACCEPTANCE_2026-08-05.md`
- `RELEASE_CHECKLIST_AGENT_ONTOLOGY_ARTIFACT_INDEX.md`
- `ROLE_MATRIX_ACCEPTANCE_PLAN.md`
- `.agents/plans/` 中已完成的专项计划
