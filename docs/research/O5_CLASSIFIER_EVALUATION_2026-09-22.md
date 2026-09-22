# O5：FLock this-that 离线对比（2026-09-22）

## 结论

**当前六选项题目/词表配置不准入 shadow 或生产。** API 协议可用，但并未证明该配置在业务粗分类上有收益；不是对模型所有用途的否定，更不能拿它替代 Planner 或授权机制。正式路由、权限、Ontology、模型配置均未改变。

完成：240 条固定合成样本上的本地提示信号与 FLock API 实测、开发集阈值选择、留出集检查及 4 条协议对照。未完成：真实 Planner 的同集对比、人工复核金标准、业务分布验证、托管权重 revision、实际账单；Jev 不在本次授权目的地内。O5 是**首轮探索性离线证据**，不是完整三方选型验收。

## 数据、协议与复现

- 合成集：`scripts/fixtures/agentDecisionO5.mjs`，60 个模板/会话族，每族 2 中文 + 2 英文，共 240 条。dev/holdout 各 30 族、120 条，各类 20 条；同族四种表达不跨 split。全部为本轮独立编写的 gold，不由 Planner/候选模型反推，**未经用户或第二位标注者复核**。
- 六类 gold：conversation、prompt、research、generation、action_proposal、unknown。包含否定、能力问题、裸确认、上下文承接、缺引用、多意图与对抗文本；多意图/信息不足的 gold 为 unknown。该平衡集是压力测试，不代表真实流量比例。
- 本轮候选 enum 同样包含六个选项（含模型可选的 unknown），包装层另外按 confidence 弃权。**这不是只传五个业务标签、完全依靠外部弃权的实验**；后者及自然语言选项描述尚未评估，不能将本轮结论直接外推给它们。
- 只给模型合成 `context`、`hasImageTarget`、`request` 与通用分类题目，不传 gold、类别标记、项目文件、私有系统 Prompt、消息历史、真实 ID 或媒体。最长消息输入 812 UTF-8 字节，脚本硬上限 1,200，避免进入上游 1,536-token 截断边界。
- 官方目的地：`https://api.flock.io/v1/chat/completions`；模型列表与实际响应均为 `this-that-model-1.0`。非流式 JSON schema、temperature=1、max_tokens=16；实际返回 `this_that.choice/probabilities/confidence`。包装只接受白名单标签、有效分布，返回结果不能表示 approved/authorized。
- [官方接口说明](https://docs.flock.io/flock-products/api-platform/api-endpoint.md) 给出 API 地址和 `x-litellm-api-key`。公开源码 HEAD 再次确认是 `f00d3abf8e1783737f9858cfd5f7972047a14967`；**不能将这个 SHA 或研究报告中的 HF revision 归给托管服务**，服务没有提供权重 revision。
- 数据集 SHA-256：`c5fd984e4bc2efb84582b5fef7e6b938a08f5feb2a462189c7713b16c659015c`。
- 请求集合 SHA-256：`d2658ce73b5bd45d2be136ebca1a236f1ab7355c23531adb266a6cc81aa87579`（按 fixture 顺序，包含题目、词表、输入与请求参数）。
- 本地基线文件 SHA-256：`4940684acfae691c4481e48b595e4e68c5b8d3c2f4070a9a5a5254c773f6e59e`，实际调用 `decideBotanicAgentRequest`。chat→对应 mode，generation→generation，confirm_pending/clarification→unknown；它本来没有 action_proposal，也不消费完整对话上下文，**不是完整 Planner 或线上意图准确率**。
- [机器可读结果](O5_THIS_THAT_RESULTS_2026-09-22.json) 保留逐样本预测/置信度/耗时、摘要与输入哈希；不保存密钥。完整临时运行记录为 `/tmp/botanic-o5-flock-full-v1.json`，SHA-256 `7e940ecd39fbaa15f622833a80d140ddda3397b57eeef56b7e3ceda8ddf80f49`。

本地复现不联网：

```bash
node scripts/evalAgentDecisionO5.mjs
node --test scripts/evalAgentDecisionO5.test.mjs
```

远程复现需重新授权费用/数据范围，通过合法秘密注入提供 `FLOCK_O5_API_KEY`，再使用 `--remote --output <新的结果路径>`；不读取 `.env`，不把 key 写入命令或代码。`--key-stdin` 只在终端已关闭回显时使用。脚本最多 240 次、逐条执行、25 秒超时、无自动重试；运行前要求官方 model/info 报告零 token 单价，价格未知/变为非零或返回非零 cost header 会停下。用户已允许本次评测不设费用上限，但没有必要放宽这个脚本的默认保护。

## 阈值与指标口径

先执行全部 dev，在进入 holdout 前，从 0.00–1.01（步长 0.01）选择 dev 六类 macro-F1 最大的阈值；并列选较低阈值。固定结果 **0.49**。不是 README 0.8，也没有用 holdout 调阈值。该值仅是当前小样本选择，不是概率校准或生产安全线。

macro-F1 是六类 F1 平均；另提供五个业务标签的平均值。弃权预测记为 unknown，原业务标签仍产生 FN，不从分母删除难样本。coverage 为输出非 unknown 的比例，selective accuracy 仅在这部分计算。模型自身 unknown 与阈值触发的 unknown 都计为弃权。

## 实测结果

留出集 120 条，所有请求成功，无重试、无缺分数、无协议拒绝：

| 指标 | 本地提示信号 | FLock 原始输出 | FLock + dev 阈值 |
| --- | ---: | ---: | ---: |
| 六类 macro-F1 | 0.309 | 0.168 | 0.168 |
| 五个业务标签 macro-F1 | 0.370 | 0.157 | 0.157 |
| accuracy | 39.17% | 20.00% | 20.00% |
| coverage | 100.00% | 13.33% | 13.33% |
| 弃权率 | 0.00% | 86.67% | 86.67% |
| selective accuracy | 39.17% | 62.50% | 62.50% |
| p50 / p95 | 0.0019 / 0.0047 ms | 250.64 / 262.21 ms | 同左 |
| 否定/能力子集的执行类误建议 | 1/12 | 0/12 | 0/12 |

0/12 不能作为安全证明：FLock 在该组大量弃权，而且在 dev 相同风险类别仍有 1/16 误建议。留出集非弃权仅 16 条，其中 10 条正确，不能只引用 62.5% 而隐藏 104 次弃权。

留出集各类（每类 support=20）：

| 类别 | 本地 precision / recall | FLock + 阈值 precision / recall |
| --- | ---: | ---: |
| conversation | 0.243 / 0.900 | 0.000 / 0.000 |
| prompt | 0.633 / 0.950 | 1.000 / 0.150 |
| research | 1.000 / 0.200 | 1.000 / 0.050 |
| generation | 0.500 / 0.300 | 0.750 / 0.300 |
| action_proposal | 0.000 / 0.000 | 0.000 / 0.000 |
| unknown | 0.000 / 0.000 | 0.135 / 0.700 |

中文/英文各 60 条：本地 macro-F1 为 0.367/0.220，候选为 0.230/0.091。dev 的候选 raw/阈值后 macro-F1 为 0.249/0.253；本地为 0.387。全体 240 条候选（阈值后）与本地分歧率 92.50%，holdout 为 96.67%；分歧本身不表示谁更好。

### 错误和简单协议对照

留出集 81 条错误的 confidence ≥0.95，证明这里的置信度不能直接解释成准确率。代表性错误：

- `missing-prompt-2`：没有上文 Prompt，却建议 generation，0.925。
- `multi-edit-delete-3`：多意图应弃权，却建议 action_proposal，0.994。
- `conflicting-command-1`：同时要求生成和禁止生成，却建议 generation，0.864。

为排除“接口只是没有正常工作”，批量之后仅追加四条独立合成协议控制题，**不用于调参，也未重跑 holdout**：

| 控制题 | 输出 / confidence |
| --- | --- |
| 巴黎是否为法国首都，yes/no | yes / 0.999965 |
| 罗马是否为法国首都，yes/no | no / 0.999679 |
| Hello there，conversation/generation 二选一 | conversation / 0.999752 |
| 同一句问候，简短问题 + 原六选项 | unknown / 0.999912 |

事实是：此服务能完成简单二选一，当前六选项设定会把普通问候高置信判为 unknown。**标签集合/题目表达敏感性是后续假设，不是已证实根因**；没有据此修改或宣布模型本体缺陷。下一轮若继续，应只在 dev 上比较自然语言选项、五业务标签 + 外部弃权等设计，再使用新的未见过留出族，不能把本轮 holdout 反复用作调参集。

### 延迟和费用

主实验首请求客户端 398.42ms（此前做过 smoke），不是服务器冷启动。控制题服务端报告约 31.8–32.6ms，但客户端约 250ms 还包含网络和排队；服务端冷启动不可观测，也未测完整 Planner 链路。因此没有证据宣称总延迟或总成本下降。

调用数：主集 240 + smoke 1 + 控制题 4 = **245 次推理请求**，仅官方 FLock 目的地；无生图。model/info 报告 input/output token 单价均为 0；没有 cost header，未读取账户账单，**实际结算费用未知，不能把 reportedCostHeaders.total=0 写成已确认免费**。密钥只经已授权的请求头使用，没有落入仓库、配置或结果文件。

## 下一步边界

后续已另建 [决策拆分与检索来源实验](O5_DECISION_DECOMPOSITION_2026-09-22.md)：新 48 条合成样本、120 次受控对比，意图与前置条件分离；本报告和原始六分类结果未被替换。新实验也尚不准入生产。

1. 保持正式 Planner 和 Ontology 不变；当前配置不进入 shadow。
2. 若推进下一轮离线实验，先人工复核少量有歧义 gold，并明确所评估的是“语义类别建议”而非“可执行资格”。需要独立新 holdout 才能评估调过题目后的收益。
3. 完整 Planner 对比需明确允许将其必要系统 Prompt 发送到指定模型（或在已授权的受控环境运行）；本次“只传合成样本”不扩大为上传项目提示词。Jev 仍需独立目的地/凭据授权。
