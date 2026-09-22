# O5 表现改进研究：评测审计与改进方案（2026-09-22）

结论：下一轮优先改任务定义、输入边界和选型口径，不继续堆状态或只调阈值。当前结果不足以支持接入生产；更值得单独验证的产品落点是现有检索后的候选相关性判断。以下第 1–5 节是已有实验的静态复核，第 6–9 节是官方资料、改进提议和验收条件，尚无新的提分实测。

## 1. 意图与可用性在标注中已拆开，但四选一与评分仍有混合边界

本部分仅复核现有源码与已保存结果，不构成实施或重新实验授权。已读取实际全局 `/Users/leo/.codex/AGENTS.md`、仓库 `AGENTS.md`；检查的相关子目录未发现额外规则。未改代码、旧样本或旧结果，未运行旧模型实验、调用外部服务、读取凭据、`.env`、会话或缓存。公开来源与总方案由主研究另行整合。

**观测：** fixture 分开保存 `label`、`semanticIntent`、`prerequisite`。例如来源不可用的 `yesterday-logo-0-1` 仍标 `artifacts`；有图/无图的编辑请求都标 `defer`，语义仍是 generation。这一层没有继续把缺条件直接改成未知意图。模型输入白名单不发送 gold 与前置条件标注。依据：[fixture:21](../../scripts/fixtures/agentRetrievalO5.mjs#L21)、[fixture:53](../../scripts/fixtures/agentRetrievalO5.mjs#L53)、[fixture:63](../../scripts/fixtures/agentRetrievalO5.mjs#L63)、[fixture:70](../../scripts/fixtures/agentRetrievalO5.mjs#L70)。

但仍需区分三处边界：

- 四选一同时承担“是否属于单一检索”与“哪个来源”两个判断；`defer` 合并多来源、非检索和不能归入支持范围的情况。它不是完整业务意图分类，也不能证明确认/执行资格识别成功。
- 描述选项写 `defer: no single supported lookup fits`，题目却要求 `Identify the intended source even if unavailable; code checks availability`。`supported` 可能被理解成当前可用性，是**待检验的措辞歧义，尚未证实为根因**。[fixture:10](../../scripts/fixtures/agentRetrievalO5.mjs#L10)、[fixture:12](../../scripts/fixtures/agentRetrievalO5.mjs#L12)。尤其 `bare-json` 根本没有发送描述性选项，却也把两个不可用的 yesterday-logo 样本判成高分 `defer`，因此不能用这一个单词解释全部失败。[fixture:84](../../scripts/fixtures/agentRetrievalO5.mjs#L84)、[结果:1361](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1361)、[结果:1402](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1402)。
- 包装层先处理 `model_defer`，再检查来源可用性和 confidence；但 `macroF1` 仍与原始来源 gold 比较，因此**正确识别不可用来源后被代码拦截，也计作来源 FN**。`routeOutcomeAccuracy` 单独认可这种 `abstain`，却不把 `model_defer` 当作同一原因的正确回退。这是两个目标，不能互相替代。[评测脚本:110](../../scripts/evalAgentDecisionO5.mjs#L110)、[评测脚本:119](../../scripts/evalAgentDecisionO5.mjs#L119)、[评测脚本:139](../../scripts/evalAgentDecisionO5.mjs#L139)。

按现有可用性检查，即使模型逐条正确识别来源，包装后语义 accuracy 的理论上限也是 dev **22/24**、holdout **20/24**；四类 macro-F1 上限分别为 **0.9500、0.8667**。这是按既定 gold 与 guard 计算的指标上限，不是模型成绩。因此不能把包装后语义分数直接解释成系统流程正确率。

## 2. dev 选型可复核；短标签版获得更好的边界控制，牺牲了检索与指代识别

本地以逐条结果独立重算，120 条记录的样本元数据、已存分类指标、数据 SHA-256 与四个版本请求哈希一致。只用 dev 复核阈值搜索，重现既有选择 **`bare-json + 0.44`**；没有用 holdout 调阈值或改选版本。选择过程与先锁定再测 holdout 的代码见[评测脚本:152](../../scripts/evalAgentDecisionO5.mjs#L152)、[评测脚本:162](../../scripts/evalAgentDecisionO5.mjs#L162)、[评测脚本:249](../../scripts/evalAgentDecisionO5.mjs#L249)，保存的选择见[结果:444](O5_RETRIEVAL_RESULTS_2026-09-22.json#L444)。

以下“有效检索”仅指 **gold 是单一来源且该来源可用**，不是实际检索工具已成功执行。dev 有 18 条有效检索、2 条来源不可用的检索、4 条多来源请求；没有非检索编辑或裸确认样本。

| dev 指标 | described-json | bare-json | described-prose |
| --- | ---: | ---: | ---: |
| 原始语义答对 | 16/24 | 15/24 | 15/24 |
| 原始四类 macro-F1 | 0.5476 | 0.6196 | 0.5030 |
| 既有 dev 阈值 | 0.92 | 0.44 | 0.96 |
| 包装后四类 macro-F1 | 0.5571 | **0.6321** | 0.5143 |
| 有效检索正确，原始/包装后均相同 | **14/18（77.8%）** | 12/18（66.7%） | 13/18（72.2%） |
| 有效检索被模型错误 defer | 0/18 | **5/18** | 0/18 |
| 多来源语义正确 defer | 0/4 | **3/4** | 0/4 |
| 多来源经包装后仍错误给单一来源 | 3/4 | **0/4** | 3/4 |
| 指代切换逐条正确 | 6/8 | 4/8 | 6/8 |
| 指代切换两状态都对 | **2/4 对** | **0/4 对** | **2/4 对** |
| 可用性变化逐条语义正确 | 4/4 | 2/4 | 4/4 |
| 可用性变化两状态都对（语义） | 2/2 对 | 0/2 对 | 2/2 对 |
| 可用性变化流程结果正确 | 4/4 | 2/4 | 4/4 |
| 包装后输出具体来源/全体 | 18/24 | 13/24 | 18/24 |
| 包装后具体来源中正确 | 14/18（77.8%） | **12/13（92.3%）** | 13/18（72.2%） |
| 包装后错误来源建议数 | 4 | **1** | 5 |
| 包装后流程结果正确 | 16/24 | 15/24 | 15/24 |

摘要依据：[结果:39](O5_RETRIEVAL_RESULTS_2026-09-22.json#L39)、[结果:140](O5_RETRIEVAL_RESULTS_2026-09-22.json#L140)、[结果:241](O5_RETRIEVAL_RESULTS_2026-09-22.json#L241)。分层统计由三版各 24 条记录重算，起点为[结果:754](O5_RETRIEVAL_RESULTS_2026-09-22.json#L754)、[结果:1256](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1256)、[结果:1758](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1758)。

**选型取舍：** 相比 described-json，bare-json 原始结果只新增答对 3 条，全部来自 `compare-two-sources`；同时丢失 4 条来源判断：两个不可用的 `yesterday-logo-*-1` 和两个历史版本 `layout-reference-*-1`。三来源的原始 F1 均值由 **0.7302 降到 0.6833**，但 defer F1 从 **0 升到 0.4286**，使四类 macro-F1 胜出。这个选择符合预先规定的目标，不能解释成“检索能力更强”，也不能仅凭 12/13 宣称系统更好。样本依据：[结果:1340](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1340)、[结果:1422](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1422)、[结果:1590](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1590)。

阈值 0.44 的收益来自拦下 `compare-two-sources-1-0` 的错误 canvas 建议（score **0.43155**）；下一条可路由建议的 score 是 **0.53013**，所以 dev 上 0.44–0.53 的网格点会给出相同决策。0.44 是并列时选择较低阈值的结果，不是经校准的概率安全线。[结果:1632](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1632)、[结果:1277](O5_RETRIEVAL_RESULTS_2026-09-22.json#L1277)。

## 3. 固定胜出版在 holdout 的主要问题是检索漏判，而非仅仅分数过低

holdout 只有 bare-json 一版，其他两版的 holdout 表现**未知**。固定 0.44 后，整体语义正确 **10/24**、macro-F1 **0.3423**；最终 6 条输出具体来源，其中正确 **3/6**。18 条回退由 **16 条 model_defer、1 条 unavailable_source、1 条 low_confidence** 构成。原始语义正确为 **11/24**、macro-F1 **0.3839**。依据：[结果:449](O5_RETRIEVAL_RESULTS_2026-09-22.json#L449)、[结果:499](O5_RETRIEVAL_RESULTS_2026-09-22.json#L499)。

| holdout 分层 | 原始语义正确 | 包装后语义正确 | 按现有定义的流程结果正确 |
| --- | ---: | ---: | ---: |
| 指代切换 | 0/4 | 0/4 | 0/4 |
| 可用性变化 | 3/8 | 2/8 | 3/8 |
| 否定当前选区、查历史 | 1/4 | 1/4 | 1/4 |
| 编辑类非检索 | 4/4 | 4/4 | 4/4 |
| 裸确认 | 3/4 | 3/4 | 3/4 |

逐条依据及关键解释：

- **有效检索只有 3/12 正确（25%）**：6/12 被错误 defer；其余错误为 3 条选错来源，包装层拦下其中 1 条。所有 16 条单一来源 gold 中，原始模型仅对 4 条；其中 1 条 rules 来源不可用，被正确拦截后可用的正确路由剩 3 条。因此最终来源覆盖率 6/24 与有效检索召回率 3/12 是不同指标。
- `origin-reference` 四条全部 defer，指代切换两条全对为 **0/2 对**；其中 `origin-reference-1-1` score **0.97280**。高分拒答已经出现，单纯提高当前阈值不能使它识别来源。[结果:2762](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2762)、[结果:2825](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2825)。
- `selected-nodes` 四条全部 defer，包含两条读取器可用的直接请求。中文 `selected-nodes-0-0` score **0.88461**；这里不能用“读取器不可用”解释漏判。[结果:2846](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2846)、[结果:2887](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2887)。
- 四条来源不可用样本最终都没有输出具体来源，但只有 `font-rules-0-1` 正确识别 rules 并留下 `unavailable_source` 原因，另外三条为 model_defer。前者原始语义对、包装后语义 FN、流程对，正好说明三种口径不能混用。[结果:2949](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2949)。这不构成实际执行或权限安全已验证。
- `not-current` 只有 **1/4** 正确；`confirm-not-lookup-0-0` 在有待确认计划时错误判 rules（score **0.53526**），包装后仍放行。编辑类 4/4 defer 只证明未进入检索路径，没有测出正确生成规划或缺图处理。[结果:3010](O5_RETRIEVAL_RESULTS_2026-09-22.json#L3010)、[结果:3094](O5_RETRIEVAL_RESULTS_2026-09-22.json#L3094)、[结果:3178](O5_RETRIEVAL_RESULTS_2026-09-22.json#L3178)。

这里的“放行/回退”均为离线包装层结果，没有运行 Planner 或任何查询工具；回退是否能完成用户任务**未知**。报告也明确记录 Planner 未运行。[结果:23](O5_RETRIEVAL_RESULTS_2026-09-22.json#L23)。

## 4. split 没有同族泄漏，但独立性和语言/场景覆盖不足以支持泛化排名

**观测：** 48 条样本来自 **12 个场景族 × 两种请求语言 × 两种状态**，dev/holdout 各 6 族、24 条；同族中英与状态对不跨 split。这一隔离正确。但同一请求的状态对和翻译高度相关，120 次请求也包含 dev 的重复版本对比，不能视为 120 个独立测试案例。gold 是 agent 编写，尚无独立人工裁决。[fixture:16](../../scripts/fixtures/agentRetrievalO5.mjs#L16)、[fixture:63](../../scripts/fixtures/agentRetrievalO5.mjs#L63)、[结果:9](O5_RETRIEVAL_RESULTS_2026-09-22.json#L9)。

| 样本构成 | dev | holdout |
| --- | ---: | ---: |
| canvas / artifacts / rules / defer | 8 / 6 / 6 / 4 | 6 / 6 / 4 / 8 |
| 指代切换 | 8 条、2 族 | 4 条、1 族 |
| 可用性变化 | 4 条、1 族 | 8 条、2 族 |
| 否定 | 4 条、1 族 | 4 条、1 族 |
| 多来源 | 4 条、1 族 | 0 |
| 注入式备注 | 4 条、1 族 | 0 |
| 编辑类非检索 / 裸确认 | 0 / 0 | 4 / 4 |
| 非空上下文 | 20 条，全部英文 | 12 条，全部英文 |
| 中文请求搭配英文上下文 | 10/12 | 6/12 |

构成依据：[fixture:17](../../scripts/fixtures/agentRetrievalO5.mjs#L17)、[fixture:38](../../scripts/fixtures/agentRetrievalO5.mjs#L38)。dev 的 defer 全来自多来源，holdout 则全来自编辑/确认；因此 dev→holdout 同时改变了措辞、任务子类和标签比例，无法把下降归因于单一因素。多来源与注入场景没有 holdout 证据；三种版本的非检索能力也没有同集对比。

语言成绩只能描述当前样本：三版 dev 的中文/英文原始正确依次为 **7/12 与 9/12、7/12 与 8/12、7/12 与 8/12**；胜出版 holdout 为 **5/12 与 6/12**。中文样本大多仍使用英文上下文，不能推出全中文链路或模型整体中英文能力差距。

无状态对照的 24 次 dev 请求实际只有 **12 个不同输入**；12 个状态对的预测与 score 均完全相同。described-json 比无状态多答对 **6 条**，没有反向丢分，但增益只分布在 **color-reference、yesterday-logo、layout-reference 三族，各 +2**。这支持“当前 dev 中状态有帮助”，不证明更多状态字段普遍有效，也不能当成六个独立泛化成功。[fixture:78](../../scripts/fixtures/agentRetrievalO5.mjs#L78)、[结果:2260](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2260)。

还有两项识别限制：`selected-nodes` 的可用性对同时改了 availableSources 和上下文里的 unavailable 描述，不能隔离哪个字段产生影响；三版按固定顺序串行、每个输入单次调用，未测运行间波动或选项顺序影响。[fixture:42](../../scripts/fixtures/agentRetrievalO5.mjs#L42)、[评测脚本:213](../../scripts/evalAgentDecisionO5.mjs#L213)、[评测脚本:248](../../scripts/evalAgentDecisionO5.mjs#L248)。

## 5. top score 足够有限拒答分析，不足以完成多类校准或系统收益证明

**已确认完整概率没有保留。** `classifyResponse` 检查了上游分布的合法性、和为 1、confidence 等于最大概率，但只返回 `{ label, score }`；随后逐条只记录 prediction/score/ms，`candidateRows` 没有 probabilities 或 logits。[评测脚本:45](../../scripts/evalAgentDecisionO5.mjs#L45)、[评测脚本:57](../../scripts/evalAgentDecisionO5.mjs#L57)、[评测脚本:273](../../scripts/evalAgentDecisionO5.mjs#L273)、[评测脚本:198](../../scripts/evalAgentDecisionO5.mjs#L198)、[结果:754](O5_RETRIEVAL_RESULTS_2026-09-22.json#L754)。

| 当前数据能做什么 | 不能恢复什么 |
| --- | --- |
| 给定预测的正确率与 top score 分箱；top-label reliability/ECE；把“预测是否正确”当二元结果的 Brier；固定预测下 coverage–risk/阈值分析 | 全类别可靠性曲线、多类 Brier、完整 log loss、margin、entropy；需要完整概率或 logits 的多类重校准/温度缩放；新候选集合下的概率 |

前一列是数据结构允许的描述性分析，不等于这批小样本足够训练或验证校准器。本次没有拟合校准器，也没有依据 holdout 重选阈值。全分布无法从 top score 唯一反推，不能补造。

现有证据已经显示分数不能直接当正确概率：

- holdout 原始平均 score **0.8065**，实际语义正确 **11/24＝45.83%**；13 条错误里 **9 条为错误 defer**。
- score ≥0.95 的 holdout 有 **7 条，错 2 条**：`origin-reference-1-1`（0.97280）和 `selected-nodes-1-1`（0.95953）。三版 dev 的同一高分段分别为 **19 条错 4、11 条错 3、21 条错 6**。这些是回看分数的描述性分组，0.95 不构成新增选型阈值。[结果:2825](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2825)、[结果:2908](O5_RETRIEVAL_RESULTS_2026-09-22.json#L2908)。
- 当前包装层对 `defer` 先返回，阈值根本不筛选它。即使改高阈值，也不能恢复这些误拒的检索；能否通过新题目或模型改善，当前证据未知。[评测脚本:112](../../scripts/evalAgentDecisionO5.mjs#L112)。

统计与指标还有以下限制：

- dev 同时比较 3 个可选版本及每版 102 个阈值网格点，只基于 6 个相关场景族；许多阈值给相同预测，不是独立试验，但选择偏差仍存在。未做嵌套/跨族稳定性验证，不能把最佳 dev F1 当泛化估计。
- 即使暂时错误地把逐条样本视作独立二项观察，11/24 的 95% Wilson 区间也为 **27.9%–64.9%**，3/12 为 **8.9%–53.2%**，3/6 为 **18.8%–81.2%**。这里只展示小分母的不确定性；实际样本按族相关、且为合成定向样本，这些区间**不是有效的生产总体置信区间**。总体性能、显著性和可靠提升幅度未知。
- `stateInvariantPairs` 实际统计“两条都正确”，混合可用性、否定、注入、非检索等不同场景，并不单独测“不受无关状态影响”。稳定地两条都判错也可能表现为答案不变；正确来源被 guard 拦截又会使包装后两条全对数下降。[评测脚本:130](../../scripts/evalAgentDecisionO5.mjs#L130)、[评测脚本:145](../../scripts/evalAgentDecisionO5.mjs#L145)。
- `unavailableSuggestions` 是检查前的来源建议数，而题目本来就要求识别不可用来源，不能把它直接称作越权率；`wrongSourceSuggestions` 也包含将非检索错误路由的情况。没有真实工具执行、回退成功率、完整 Planner 同集对照或用户任务完成率证据。
- 本轮 holdout 客户端 p50/p95 为 **246.93/294.65 ms**；模型权重 revision、实际账单与完整系统总延迟收益未知。[结果:4](O5_RETRIEVAL_RESULTS_2026-09-22.json#L4)、[结果:12](O5_RETRIEVAL_RESULTS_2026-09-22.json#L12)、[结果:496](O5_RETRIEVAL_RESULTS_2026-09-22.json#L496)。本轮没有新模型对照，不能据此假设某个新模型更强；与前轮六分类的任务和样本也不同，不能直接用两轮 F1 作提升排名。

复核数据锚点：dataset SHA-256 `d5e23029186846f041d63e344d43899a02aa6e1c13a9601c8607835d431bb681`；原结果文件内容 SHA-256 `ff2514d3b3c9f0ef3352c168fc2a73b4ddd2e8b5ba25f986c619177ee5326aff`。本次仅新增本文；上述结果是静态重算与源码审计，没有产生新的模型成绩。


## 6. 官方材料补充：哪些方法有依据，哪些不能直接照搬

本节由主研究补充。2026-09-22 通过 AgentKey 查找官方文档，用浏览器核对 FLock README、TypeSafe 的构建指南和 Jev 1.13 失效模式；FLock 源码复用前轮固定 SHA 的公开源码副本，本轮确认网页 HEAD 仍为 `f00d3ab`。没有发起模型评测、训练、付费生图，也未向 FLock/Jev 或检索服务传输项目私有内容；没有修改原评测代码、gold 或结果。

| 官方证据 | 可用于 Botanic 的方法 | 适用限制 |
| --- | --- | --- |
| TypeSafe 构建指南要求 atomic question，只送相关状态，Choice 用同结构的“范围、排除项、例子”澄清边界。[W1] | 先缩小所问的判断，再加少量对照例子；不是追加越来越长的总体指令 | 是设计指导，不是 FLock 在本领域的提分承诺 |
| Jev 1.13 已知问题列出字面理解、间接推理、无关上下文、题目与 criteria 冲突。[W2] | 把“即使不可用也识别意图”这种组合要求拆掉；不要让模型在一题里兼顾语义、能力、执行建议 | 是 Jev 的官方披露，不能直接当作 FLock 的已确认根因；我们的错题需独立验证 |
| TypeSafe State 允许命名字段、上下文和例子；英文为主，CJK 可用但准确率更低。[W3] | 比较语言一致的中文/英文 rubric；只保留当前请求和必要指代证据 | 不代表我们的 5/12 对 6/12 已证明语言因果，也不意味着增加翻译模型必定划算 |
| FLock README 显示 JSON 空间题训练前 0.373、定向训练后 0.936；同时明示 checkpoint 训练过全部 15 类题型。[W4] | 领域数据和题型适配可能比继续堆通用提示更重要 | 空间题的厂商数据，不是中文品牌任务的预期成绩；不能拿训练内成绩与我们的未适配任务直接相比 |
| TypeSafe 重排示例先做 BM25，再对“query + candidate”问具体匹配问题；Skill 建议示例把“选哪个”与“是否确实适用”分开。[W5][W6] | 从猜抽象入口，转为判断已检索到的具体候选；允许没有候选适用 | 官方教程，不是 Botanic 已验证方案；重排无法找回初筛漏掉的目标 |
| FLock 推理是 logits/temperature → softmax → argmax；HTTP 只构建一个 Question。[W7][W8] | 采用此模型真正支持的单题文本/枚举接口；校准与提高分类能力分开 | Jev 的结构化 criteria、多题并行、Noul/Score 不能直接复制到 FLock 托管接口 |

### 不值得优先尝试的办法

1. **只调低 temperature。** 固定 logits 下除以正数不改变最大值位置，所以开源实现里的 top-1 不会因此变正确，只改变分布的尖锐程度。托管服务内部 revision 未公开，不把源码结论冒充所有服务实现的实测。
2. **增加 max_tokens，要求“多想几步”。** 该源码读取隐藏状态选择类别，不运行自回归解码。增加生成预算或索取思维链不是给这个决策头加推理步骤。[W7][W8]
3. **堆所有 Ontology、权限、历史消息进 state。** 先筛事实再提问；把代码能直接判断的数值、归属和状态留在代码。更多字段既增加干扰，又扩大隐私传输范围。[W1][W2]
4. **把高分直接当准确率，或只提高阈值。** 高分错题仍可能通过；降低覆盖率不等于模型理解力提高。旧报告只保留 top-1 分数，不能事后重建完整概率分布进行 margin、Brier 或 NLL 分析。
5. **反复使用已看过的 holdout 调题。** 当前所有已分析错题只能作为开发/回归材料；下一轮必须有新的封存场景族。不能把“研究旧结果”说成新留出集验证。

## 7. 建议的改进顺序

### P0：先修正问题和选型标准，不接生产

把一个混合任务分成两个验收对象：

- **语义识别**：已确认是单来源检索时，它指向画布、历史作品还是已保存规则？来源暂不可用不改变语义 gold。
- **工作流分配**：这次是否属于该小题的适用范围，以及是否可查询？现有控制流程/明确模式提供适用范围，服务端代码检查能力和权限；多来源、裸确认、复杂指代留给现有 Planner。

不要用更长的正则列表重新实现一个总 Planner；也不要求每轮增加一次“是否该分类”的模型调用。只有上游已经明确适用时才试这个小模型。去掉 `defer` 的三选一实验只能在这个闭集上评估；在任意请求上强制三选一会隐藏域外误接收，不算提升。

选型分开报告核心语义正确率、域外误接收率、可用性防线、非回退正确率与覆盖率。优先比较相同覆盖率下的错误率，再看相同质量下的成本；不再仅凭混合四类 macro-F1 决定业务去向。改选标准前重新封存方案，不能拿旧 holdout 挑一个“赢家”。

### P1：短问题 + 干净状态 + 少量对照例子

下一轮先分别比较，不把所有修改同时叠起来：

1. **净化输入**：语义题只给请求及必要的指代依据；移除 `availableSources`、`pendingPlanCount` 等对该题无关的状态。程序依旧保留并使用这些事实，不是删掉安全校验。
2. **写清边界**：例子成对出现——“查看当前这张的布局”与“找以前生成的那张”；“读取已保存规则”与“保存一条新规则”；“生成图片”与“找已有图片”。few-shot 只用开发材料，不混入留出样本。
3. **语言一致**：分别测中文问题/中文选项/中文上下文与英文版本，不把“用户中文 + 英文状态”的混合方案当唯一设定。自动翻译仅是候选，必须把额外费用、否定词丢失与延迟一起算。
4. **顺序与稳定性**：在开发集轮换选项顺序，检查是否只是偏好位置或某个词；不会因输出合法就假定语义稳定。

FLock 当前 HTTP 读取的是文本和 enum，不识别 Jev 的任意 criteria 结构。示例和边界若要给 FLock，应显式放入题目/选项文本或命名后的合成 state，不能只往 JSON Schema 增加 description 并假定服务已经消费。[W8][W9] 所有 prompt 变更先核对长度；源码会截断 state，不能不断追加示例到尾部。[W10]

### P2：更推荐的落点——候选相关性，而不是抽象来源总路由

对 Botanic 的首个产品落点，进一步收窄为：

> 程序从已授权的现有检索入口取少量候选，小模型只判断“这个候选是否满足用户明确提出的要求”，结果仅调整排序或建议；不足以判断时保留原排序/交回 Planner。

例如用户找“上次那套绿色包装”，程序先把项目/媒体类型/明确日期等硬条件处理好，再给模型某个候选的安全描述，问“这个描述是否对应用户要找的包装方案？”只看文字能支持的事实；不能靠名字证明图片视觉上真的为绿色，更不能靠模型虚构历史来源。

这一方式把“解析意图 → 解析指代 → 选工具 → 推测工具能做什么”的多步推理，缩短为 query 与具体候选的匹配。可复用现有 keyword/hybrid 查询和安全投影，不新增图数据库或状态机。与旧来源题是不同任务，需要独立基线；不能把新题更高的数字说成旧题被修好了。

实验从少量候选开始，比较原排序与新排序的 top-1/Recall@k，以及低分候选被错误提升的次数。检索未召回正确对象时，重排不背“凭空找回”的指标，也不能掩盖召回缺陷。FLock 托管 API 当前未验证多题一调用，多候选可能意味着多次请求；必须测整个请求的延迟与成本，而不是引用本地 GPU 的 30ms。

### P3：输入设计达到瓶颈后，再评估领域适配或换模型

- 整理经独立复核的中文品牌场景：正例、近邻反例、否定、无合适候选、多意图、指代歧义；按场景/会话族划分，不把同一个模板的不同措辞当大量独立样本。
- 强模型可以辅助拟标，但不作唯一金标准；争议样本由人工复核，不靠“两个模型一致”替代事实证据。
- 提示内示例、真正参数训练是两件事。FLock 发布仓库主要是推理与复现脚本，未核实当前托管 API 提供此模型的微调入口；定向训练需要服务方支持或单独的自托管训练工作，不是加一个参数。
- 只有对比显示明确收益，才考虑数据收集、训练、版本锁定与校准。否则继续使用现有 Planner，或在授权的数据/目的地范围内比较另一模型；Jev 不能因已授权 FLock 而自动被调用。

## 8. 下一轮最小实验与停止条件（提议，尚未执行）

1. 冻结新任务的 gold 定义，先复核少量边界题；明确是在测来源分类还是候选匹配，不混在一张榜单。
2. 用新的开发场景对照“精简状态”“边界例子”“语言一致”三项，每次只改变一个因素；保留错误类型和完整的安全类别概率。探索和阈值校准需区分，至少按场景族做分组验证。
3. **语义质量先过关，再校准回退。** 在校准数据上查看分数与实际正确率、同覆盖率的错误率；margin/概率校准也是待检验方法，不是天然更可靠。
4. 固定题目、模型标识、词表、阈值和新留出集，只跑一次验收。对来源题分别看闭集和域外；对重排题和现有检索基线比较，不用不匹配的粗意图启发式凑基线。
5. 相同覆盖率下不能降低错判，或达到目标质量时几乎全部回退、总延迟/费用没有收益，就停止把它放进这条路径。少量样本的高分仅是继续验证的信号，不是上线证明。

本轮交付是研究报告与改进优先级，**没有实施上述变更、没有重跑或调优现有留出集、没有追加 FLock/Jev 推理、没有变更权限与发布状态**。

## 9. 公开来源

- [W1 — TypeSafe: How to build with System One](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)：本轮浏览器核对；原子问题、相关上下文、对照式 criteria、分数与准确率验证。
- [W2 — Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)：本轮浏览器核对，页面标注 reviewed 2026-09-17；包括 literal reading、indirection、context rot、instruction/criteria conflicts 和非保证的概率恒等式。
- [W3 — TypeSafe State](https://docs.typesafe.ai/concepts/state)：官方文档检索内容；文本/JSON、必要上下文、语言限制。
- [W4 — FLock README（固定 SHA）](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/README.md)：本轮浏览器核对 HEAD 与正文；训练分布及前后结果。
- [W5 — TypeSafe Re-ranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)：官方教程，BM25 shortlist 后逐候选匹配；这里引用设计方法，不外推其法律数据集成绩。
- [W6 — TypeSafe Skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion)：官方教程，shortlist 与适用性复核；示例使用 Jev 1.12，不冒充当前 FLock 能力。
- [W7 — FLock model.py](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/model.py#L163)：softmax 与 argmax；本轮复核固定源码。
- [W8 — FLock server.py](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/server.py#L75)：单个 Question、温度处理及响应分布；本轮复核固定源码。
- [W9 — FLock openai_protocol.py](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/openai_protocol.py#L37)：enum 提取和 messages/state/question 划分，不完整消费 JSON Schema；本轮复核固定源码。
- [W10 — FLock prompt.py](https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/prompt.py#L99)：状态 token 截断；本轮复核固定源码。
