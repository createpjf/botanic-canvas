# ADR 0006：Agent 质量、记忆与 Skill 治理

## 状态

已接受。2026-08-24 修订：补齐评审分层与覆盖策略、三类状态的边界、Memory 激活与冲突规则、Skill 生命周期（见文末修订记录）。

## 决策

### 评审是持久化的派生任务

Agent 结果评审是可恢复的派生任务，必须持久化自动评审、人工决定和修订建议；自动评审不能直接把结果标记为品牌批准，也不能自动写入长期 Memory。

评审由派生任务队列执行，不依赖打开页面。Run 进入执行终态即创建 ReviewTask；**Run 的执行终态不等待评审完成**。

### 三类状态相互独立

`executionStatus`、`reviewStatus`、`candidateStatus` 是三个独立状态，不得合并：

- `executionStatus` 只表达 Run / Job / Media / Canvas / Artifact 的执行终态；
- `reviewStatus` 只表达派生评审是否排队、进行、完成或失败；
- `candidateStatus` 只表达单个 Artifact 候选是否待评审、待人工、接受、拒绝、替代或已提升。

**评审失败或等待人工不得把已成功持久化的 Run 改回失败**，它只阻止候选进入「可交付」。把三者压进一个字段会让一次评审模型超时看起来像生成失败。

### 评审分层：先确定性，后模型，最后人工

评审必须分层，且**硬规格不得交给模型判断**：

1. **确定性规则**（不调用模型）：格式、尺寸、比例、时长、文件完整性、数量。这些能被证明，用模型判断既贵又不可靠。
2. **视觉模型评审**：主体与身份保持、构图、光线、质感、风格符合度、品牌规则。
3. **人工判断**：审美、传播力、最终品牌批准。

第 1 层失败应直接给出 `fail`，不进入第 2 层 —— 一张比例错误的图不需要再问模型好不好看。输出记录必须携带第 1 层所需的实际规格；缺字段时该项判为「无法验证」而不是默认通过。

### 评审 rubric 来自不可变计划快照

Review 的判据必须来自 `CompiledCreativePlan.qualityPolicy`，并记录该策略的 fingerprint。**Review 不得自带一套硬编码 rubric** —— 否则「结果符合用户确认的约束」无法被证明，编译期声明的质量策略与评审期实际使用的判据会各自漂移。

### 覆盖策略必须显式且可见

**每个最终候选都要有评审覆盖，不只评每个分支的第一张。** 批量任务允许分层抽样，但抽样策略必须随 ReviewTask 持久化并对用户可见；**不允许静默截断**。存在上限时，被跳过的候选数必须出现在读模型里。

评审覆盖不得按媒体类型隐式排除。视频的硬规格（时长、容器）恰恰属于第 1 层能确定性验证的部分。

### 人工决定是逐候选的幂等命令

`HumanDecision` 以 `(artifactId, idempotencyKey)` 幂等。批量接受或拒绝可以共享一个 commandId，但**必须逐候选落库**，不能给多个 Artifact 共用一个模糊状态。

`retry_requested` 必须基于对应 ReviewResult 生成新的 Revision Proposal 与新 Run，并关联原 Run / Review / Artifact；接受与拒绝都不覆盖原 Artifact。

### 持久化边界

ReviewTask / ReviewResult / HumanDecision 只保存业务引用与安全摘要：Artifact ID、criteria 结果、策略 fingerprint、决定者与时间。**不得保存 Prompt、媒体字节、私有媒体地址或 Provider 原始回包。** 评审失败必须是可诊断、可重试的失败，而不是静默的空结果 —— 「未配置」「模型输出不可解析」「模型不可用」要能区分。

### Memory

Memory 使用带范围、维度、证据、版本、验证来源和墓碑的结构化实体。只有人工确认或历史用户明确保存的内容才能成为 active 规则；模型建议保持建议态。

**激活态与置信度是两个概念，不能互相顶替。** 生效与否是 `status`（`proposed` / `active` / `superseded` / `deleted`），可信程度是 `confidence`；用置信度枚举兼作激活开关会让「未确认但很可信」无法表达。

**检索排序不得让已确认的人工记忆落选。** 排序可以综合语义相关性、范围、置信度、时效与冲突状态，但 active 且人工来源的记忆不得因为「本轮查询词没有字面命中」而被丢弃 —— 用户存下的规则本来就不会和每次查询用同样的措辞。

**冲突必须显式。** 相互矛盾的 active 记忆不得同时静默进入同一个 Plan；冲突关系要可查询，且 Plan 只记录真正选中并使用的 Memory 版本与选择依据。

**项目内只允许一条 Memory 读取路径。** 任何构造 Prompt、Plan 或不可变工作流定义的位置都必须经同一个选择器；绕过选择器直接读原始集合会让过滤规则（未确认项、范围、墓碑）在部分路径失效。

### Skill

Skill 使用不可变 Manifest 版本。已发布版本不能原位修改，Run 必须固定 Skill 版本与内容 hash。能力只允许声明 `read`、`write`、`costly`、`external`；`read` 规则可在规划阶段生效，其余能力一律生成待确认行动，未知能力按最高风险拒绝静默放行。现有绑定参数哈希的短期审批 Token 继续作为执行凭据。

**版本与内容 hash 在 Run 绑定中是必填，不是可选。** 允许缺省等于允许出现无法重放的 Run。

**历史版本必须可经接口取回。** 一个持有 `version: N` 的历史 Run，如果没有任何接口能取回该版本的指令内容，「历史 Run 仍引用旧版本」只是一句无法验证的声明。

Skill 有 `draft` → `review` → `publish` → `deprecate` 生命周期，**治理状态由流程产生，不得在创建时硬编码为已批准**。

## 后果

- 「生成成功」与「品牌可交付」成为两个独立状态。
- 记忆和 Skill 能够解释为什么被使用，并能追溯到具体 Artifact、Review 或人工操作。
- ProductStore 的三个 Adapter 需要共同维护 Review、Memory V2 和 Skill Version 的一致语义。
- 评审需要派生任务队列；它与 Turn 回收、Workflow 推进共用同一条队列。
- 第 1 层确定性检查要求输出记录携带实际规格；当前缺失的字段需要随本轮补齐。
- 需要故障注入测试覆盖：评审 Worker 崩溃后恢复、`retry_requested` 重复点击、批量决定的逐候选幂等、评审模型不可用与输出不可解析的区分。

## 修订记录

### 2026-08-24

原文方向正确但只写了意图，没有给出实现所需的设计决策，而实测该 ADR 的持久化部分**完成度为 0**：

- `botanicAgentReview.mjs` 的模块注释自陈「不写入 Run、计划或 Artifact，重评只会改变展示」。ReviewTask / ReviewResult / HumanDecision 三个实体都不存在，没有队列、没有重试，7 处静默 `return undefined` 让「未配置」「不可解析」「模型不可用」无法区分。
- 覆盖率实测约 25%：每分支只取第一张结果、候选硬上限 4 且静默 `break`、非图片媒体直接跳过（视频完全不评审）。
- 编译器产出的 `qualityPolicy.requiredCriteria` 从未被评审消费；评审 rubric 是硬编码的中文 prompt，只读 `instruction` 与 `prompt`。
- 全部评审都是一次视觉模型调用，没有确定性层。
- Memory 用 `confidence: 'confirmed' | 'provisional'` 兼作激活开关，没有 `status`；没有 `conflictsWith`；检索是 `String.includes` 加固定阈值，导致一条 confirmed + human + project 的记忆在得分 7 分（阈值 8）时被丢弃 —— 措辞不字面命中就检索不到。另有两条读取路径：选择器会过滤未确认项，而生产工作流草稿直接读原始集合、把未确认记忆写进了不可变定义。
- Skill 的 capability 白名单校验严于原 ADR（未知能力直接拒绝），但 `status: 'active'` 与 `governance: 'project-approved'` 在创建时硬编码，没有生命周期；`publicAgentSkill` 不暴露 `versions`，历史 Run 无法取回其绑定版本的指令；Run 绑定中 `version` 与 `contentHash` 都是可选。

本次修订补齐这些决策，其中三条是新增的明确判断：**硬规格不得交给模型判断**（确定性的东西用模型既贵又不可靠）、**激活态与置信度必须分开**（否则「未确认但可信」无法表达）、**项目内只允许一条 Memory 读取路径**（绕过选择器会让过滤规则在部分路径失效，已经实际发生）。
