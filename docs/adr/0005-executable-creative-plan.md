# ADR 0005：可执行 Creative Plan 与不可变配方

## 状态

已接受。2026-08-24 修订：拆分 Resolve 与 Compile 两个阶段，消除原文自相矛盾的条款（见文末修订记录）。

## 背景

Agent Plan 已经能够描述 `preserve` / `vary`、变体轴和交付参数，但这些字段不能只停留在计划卡。确认后必须把它们编译成确定性的 GenerationRecipe，保证用户确认的创作语义与实际 Provider 输入一致。

原文同时要求"编译器重新读取项目、参考图、预算和权限"与"编译器是纯领域 Module"。这两条无法同时成立：读取项目权威状态需要 I/O，纯模块拿不到 ProductStore。实现选择了纯模块，因此"引用失效在提交前失败"一直没有落点。本次修订把它拆成两个各自单一职责的阶段。

## 决策

确认后的执行准备分为 **Resolve** 与 **Compile** 两个阶段，失败必须能定位到具体阶段。

### Resolve 阶段（有状态，服务端）

`CreativePlanResolver` 是唯一读取权威状态的一侧。它按项目权威文档与运行时配置校验：

- 引用素材、结果节点与画布节点仍然存在，且能解析出稳定媒体标识；
- 选定模型的能力覆盖请求的媒体类型、比例、分辨率与视频时长；
- 工作区、项目与成员三个维度的预算足以承担本次提交；
- 调用者具备对应项目权限，付费生成与外部行动持有有效短期审批；
- 实际选中的 Memory / Skill 版本与内容 hash。

任一项不成立在此阻断并返回具名的阶段化错误，不进入 Compile。产出是自洽的 `ResolvedCreativePlanInput`，其中包含 `referenceBindings`、`modelBinding`、`budgetSnapshot`、`permissionSnapshot` 与版本绑定。

### Compile 阶段（纯领域 Module）

`CreativePlanCompiler` 只消费 `ResolvedCreativePlanInput`，不做任何 I/O，因此可以离线重放与单元测试。它确定性地展开：锁定维度、变化维度、**每个分支**的 Prompt、交付规格、质量策略、Memory / Skill 绑定，以及稳定 fingerprint。

编译产出 **plan 级** `CompiledCreativePlan` 快照，覆盖本次确认的全部分支；每个分支的 fingerprint 由 plan fingerprint 与分支身份派生，因此任一分支都能归回同一次用户确认。

### 不变量

- 确认后的 Run 保存完整的不可变 `CompiledCreativePlan` 快照与 plan 级 fingerprint；Run 不得只保存计划草案。
- GenerationJob 与结果节点保存派生的分支 fingerprint，可反查所属 plan 快照。
- 重试与恢复只读取快照，不重新 Resolve、不重新咨询模型、不重新推断约束。
- 引用失效必须在 Resolve 阶段阻断。任何路径都不得把带引用的请求静默替换成其他引用，或降级成空引用配方。
- 旧 Run 按 V1 兼容读取，新 Run 使用 V2；历史 Run 缺少快照时标记为 legacy，不伪造完整快照。

## 后果

- 计划确认内容与实际生成输入可以审计和重放。
- Provider Prompt 必须明确区分"必须保持""允许变化"和"当前分支变化"。
- 模型能力不足、预算不足、引用失效、权限缺失都在提交前失败，而不是生成后才暴露，且错误能定位到 Resolve 的具体检查项。
- Compiler 保持纯领域 Module：测试通过它的 Interface，不调用真实 Provider，也不需要数据库夹具。
- Resolver 需要各自的集成测试覆盖引用删除、模型降级、预算不足与越权四类拒绝路径。
- HTTP、Agent 与 Workflow 三个提交入口共用同一对 Resolve / Compile 实现，不各自实现一份校验。

## 修订记录

### 2026-08-24

原文「决策」段要求编译器重新读取项目、参考图、预算和权限，「后果」段要求编译器是纯领域 Module。实现（`server/botanicCreativePlanCompiler.mjs`）选择了后者：它是纯函数，只接受 `models` 目录作为入参，无法校验引用有效性、预算与权限，`safeReferenceIds` 仅拷贝引用 ID 而不验证存在性。因此原文承诺的"引用失效在提交前失败"没有实现落点。

本次修订不改变目标，只把职责拆成 Resolve（有状态）与 Compile（纯）两个阶段，使"提交前失败"与"纯模块可测"同时成立。同时明确两条原文未写清、实现也未满足的要求：Run 必须保存 plan 级编译快照（当前只保存计划草案且完全没有 fingerprint 字段），以及分支 fingerprint 必须可归回同一次确认（当前按分支各自编译，分支间 fingerprint 互不相关）。
