# Botanic Agent 开发入口

本仓库是 Botanic 品牌视觉生产工作台。开始改动前依次阅读：

1. [产品架构与 Ontology](docs/PRODUCT_ARCHITECTURE.md)
2. [代码地图](docs/CODEMAP.md)
3. [模块接口与依赖方向](docs/ARCHITECTURE.md)
4. 涉及持久化、图谱或 Artifact 时阅读对应 [ADR](docs/README.md#架构决策)

## 开发约束

- 先确认行为归属，再修改拥有该行为的模块；不要把领域规则放回 UI。
- `src/components/` 保持纯 UI，不直接访问 Store、网络或服务端。
- 生成任务与持久化记录是状态权威；UI 占位、Toast 和本地选择态不是。
- Agent 运行记录可以承载摘要级说明：模型通过工具 `why` 参数自述的一句话调用目的，可展示也可随计划持久化。
  提供方回传的原始推理（`reasoning_content` 等）是完整思维链，不是摘要：默认不下发，只有 `AGENT_RAW_REASONING=true` 时
  才随当轮响应下发供面板实时展示，且不得写入消息、计划、Run 或 Artifact Index。
- 不改变幂等键、任务恢复、项目版本冲突和媒体授权语义，除非需求明确要求。
- Agent Session、Message、Memory、Run 的独立实体是权威；`CanvasDocument` 中同名字段仍是迁移兼容视图。
- Artifact Index 是历史血缘目录；删除画布节点或素材引用不得级联删除历史 Artifact。
- ProductStore 有本地、PostgreSQL、Supabase 三个 Adapter；变更接口时同步维护全部 Adapter 和契约测试。
- 优先形成拥有明确行为的深模块；不要只为缩短文件而增加透传层。
- 模块大小硬规则：新模块目标 <500 行；任何非测试文件达到 800 行后，新功能必须开新模块而不是继续扩展（`check:architecture` 强制）。存量超限文件冻结在 `scripts/architectureBoundaries.mjs` 的 `legacyOversizeBudgets`，只准降不准升；触达它们时优先按既有 seam 拆分。
- Agent 命名裁决：`botanicAgent*` 只用于产品语义解析层（Prompt/意图/计划/画布语义，如 botanicAgentTurn/Chat/Planner/Tools）；`agent*` 用于通用控制面（Turn 生命周期/Tool Loop/Context/恢复/协议/指标）。新文件必须按此选择前缀；存量不做机械全局改名，触达时再对齐。
- `server/` 的类型检查按文件 opt-in：模块顶部写 `// @ts-check` 即纳入 `tsconfig.server.json`，由 `npm run build` 一并把关。**新增跨 Adapter 契约的模块必须 opt-in**，存量模块按接触到再补，不做一次性大改。`noImplicitAny` 关闭，因此不需要给内部工具函数的参数加标注。唯一需要处理的是 `({ a, b = 1 } = {})` 这种解构带默认值的参数 —— TS 只从有默认值的属性合成参数类型，`a` 会被判为不存在。优先改成具名参数在函数体内解构（`function f(input) { const { a, b = 1 } = input ?? {} }`）；不便改签名时再对默认值做 `/** @type {...} */ ({})` 断言。
- 历史验收和已完成计划不是当前规范；当前入口见 [文档索引](docs/README.md)。
- 未经维护者明确要求，不要自动创建 Pull Request；改动只提交并推送到已有工作分支。

## 修改路线

- 画布工作区交互：从 `src/features/canvas/CanvasWorkspace.tsx` 开始；节点、连线、布局规则从 `src/domain/canvas*.ts` 开始。
- 生成、恢复、批量任务：从 `src/domain/generation*.ts`、`src/store/canvasStore.ts` 和 `server/generation*.mjs` 开始。
- Agent 面板交互：从 `src/features/agent/AgentWorkspace.tsx` 开始；结果/记忆面板见 `AgentUtilityPanels.tsx`，离线消息与运行轨迹见对应 `useAgent*.ts`；对话、计划、执行、Artifact 语义从 `src/domain/agent*.ts` 和 `server/botanicAgent*.mjs` 开始。
- Store 命令或状态形状：先核对 `src/store/canvasStore.types.ts`；Agent 实体命令从 `src/store/canvasAgentActions.ts` 开始，其余命令再进入 `src/store/canvasStore.ts`。
- 浏览器会话、远端项目、协作：从 `src/lib/` 开始。
- 画布同步协议（CRDT mutation log、Outbox、epoch）：服务端权威从 `server/canvasCollaborationRoom.mjs` 开始，浏览器侧从 `src/lib/canvasSyncOutbox.ts` 与 `src/domain/collaborativeGraph.ts` 开始；两侧清洗器由 `scripts/canvasCollaborationSanitizerContract.test.mjs` 锁一致，改一侧必须同步另一侧。
- HTTP、鉴权、队列和存储 Adapter：从 `server/` 开始；项目资源见 `projectRoutes.mjs`，生成任务资源见 `generationRoutes.mjs`。
- 会话 HTTP 语义从 `server/sessionRoutes.mjs` 开始；动态路径目录仍在 `server/httpRouteTable.mjs`。
- 更完整的文件和测试对应关系见 [CODEMAP](docs/CODEMAP.md)。

## 最小验证

```bash
npm test
npm run check:architecture
npm run build
git diff --check
```

先运行被修改模块的聚焦测试，再运行全量验证。不得用真实生成 Provider 作为普通开发测试。

## Purpose

Finish the current task with the minimum sufficient approach.
No overengineering.
Planning can lean strong. Execution must lean light.
If you can't prove a design is necessary, don't ship it.
If you can't prove a test is necessary, don't add it.

## Workflow

1. Understand the requirement before touching code. Don't change code then guess intent.
2. Planning phase may use higher reasoning. Execution phase defaults to medium-low reasoning or a lighter model.
3. Don't run max reasoning for the entire session.
4. Don't spawn multiple agents by default. Finish one task single-threaded first, then decide if splitting helps.
5. Only enable skills that the task actually needs. Don't install heavy-process skills.
6. Produce a minimal plan before executing. The plan must include:
   - Goal
   - Non-goals
   - Acceptance criteria
   - What's untouched

## Failure Modes

1. Didn't truly understand intent. Only fixed the surface.
2. Could have done one clean root-cause fix but instead piled on patches, compat layers, dual implementations, and copied options.
3. Over-designed for rare cases, making everyday maintenance expensive.
4. Wrong premise. No amount of correct reasoning fixes a wrong starting point.
5. Should have read the code directly but used search or guessing instead.
6. Used "add tests" as cover to expand scope, add abstractions, or look thorough.

## Action Boundaries

1. Before starting, restate:
   - What the user actually wants
   - Scope for this task
   - What's explicitly out of scope
   - Definition of done
2. Any irreversible operation requires user confirmation before executing.
3. These are NOT irreversible (fine to execute without asking):
   - Git revert, restore, branch switch
   - Moving files to a backup directory in the repo
   - Running tests, viewing diffs, generating plans, read-only analysis
4. When you catch yourself doing any of these, stop and switch to a smaller plan:
   - Adding abstractions/frameworks/config layers the task doesn't need
   - Designing ahead for possible future use
   - Stacking more constraints to satisfy existing constraints
   - Touching many unrelated files
   - Creating a second implementation to keep old logic alive
   - Using test additions as a reason to keep building

## Testing

Tests serve the current change's acceptance. Nothing else.

1. Prefer running existing tests related to the change.
2. If existing tests prove the change works, don't add new ones.
3. New tests allowed only when:
   - This change altered behavior that existing tests can't cover
   - User explicitly asked for tests
4. New tests at most: 1 main path + 1 critical failure path.
5. Don't expand test scope for completeness.
6. Don't backfill unrelated modules.
7. Don't introduce new test frameworks or infrastructure.
8. Don't write snapshot matrices, parameterized grids, or e2e suites.
9. Don't test boundaries the current requirement didn't ask for.
10. Don't let green tests justify more abstraction.

Before adding any test, answer:

- Which accepted requirement does this test verify?
- Without it, would existing tests miss this regression?
- Is it simpler than the implementation?

If test code is longer or more complex than the implementation, treat it as overengineering.

## Model Allocation

- Requirement clarification and plan review: stronger model
- Writing/changing code, running tests: medium-low model or lighter execution model
- If the execution model starts stacking architecture or expanding scope: stop, rewrite a minimal plan

## Pre-Completion Checklist

- Restated intent and acceptance criteria
- Solution is the minimum approach, not the maximum
- Non-goals are marked
- Read relevant code directly instead of guessing
- Only changed the minimum files needed
- Ran related existing tests
- Didn't add tests for scenarios that weren't requested
- Any new tests only lock current behavior, count is low
- Tests didn't introduce new dependencies or directory structures
- Diff is small, no extra files, no leftover debug code
- Didn't do extra work just to look complete
