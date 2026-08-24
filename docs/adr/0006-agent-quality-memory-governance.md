# ADR 0006：Agent 质量、记忆与 Skill 治理

## 状态

已接受。

## 决策

Agent 结果评审是可恢复的派生任务，必须持久化自动评审、人工决定和修订建议；自动评审不能直接把结果标记为品牌批准，也不能自动写入长期 Memory。

Memory 使用带范围、维度、证据、版本、验证来源和墓碑的结构化实体。只有人工确认或历史用户明确保存的内容才能成为 active 规则；模型建议保持建议态。

Skill 使用不可变 Manifest 版本。已发布版本不能原位修改，Run 必须固定 Skill 版本与内容 hash。能力只允许声明 `read`、`write`、`costly`、`external`；`read` 规则可在规划阶段生效，其余能力一律生成待确认行动，未知能力按最高风险拒绝静默放行。现有绑定参数哈希的短期审批 Token 继续作为执行凭据。

## 后果

- “生成成功”与“品牌可交付”成为两个独立状态。
- 记忆和 Skill 能够解释为什么被使用，并能追溯到具体 Artifact、Review 或人工操作。
- ProductStore 的三个 Adapter 需要共同维护 Review、Memory V2 和 Skill Version 的一致语义。
