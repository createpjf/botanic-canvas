# ADR 0005：可执行 Creative Plan 与不可变配方

## 状态

已接受。

## 背景

Agent Plan 已经能够描述 `preserve` / `vary`、变体轴和交付参数，但这些字段不能只停留在计划卡。确认后必须把它们编译成确定性的 GenerationRecipe，保证用户确认的创作语义与实际 Provider 输入一致。

## 决策

服务端增加 `CreativePlanCompiler`。模型只产生 Plan Draft；编译器重新读取项目、参考图、模型目录、预算和权限，验证并展开成 `CompiledCreativePlan`。编译结果包含锁定维度、变化维度、每个分支的 Prompt、交付规格、质量策略、Skill/Memory 绑定和稳定 fingerprint。

确认后的 Run 保存不可变的编译快照。GenerationJob 与结果节点保存同一配方快照，重试和恢复不得重新咨询模型或重新推断约束。旧 Run 按 V1 兼容读取，新 Run 使用 V2。

## 后果

- 计划确认内容与实际生成输入可以审计和重放。
- Provider Prompt 必须明确区分“必须保持”“允许变化”和“当前分支变化”。
- 模型能力不足、预算不足、引用失效会在提交前失败，而不是生成后才暴露。
- 编译器是纯领域 Module，测试通过它的 Interface，不调用真实 Provider。
