# this-that-model / Jev 决策模型一手证据研究

研究日期：2026-09-22（Asia/Shanghai）。研究对象：[FLock-io/this-that-model][repo]，并向 TypeSafe 官方资料核实 Jev 的身份与接口差异。

范围：只读检查公开源码、官方模型卡、数据集卡、论文和 API 文档；未审阅 Botanic 业务代码。Botanic 集成建议依据本次任务和仓库 AGENTS.md 给定的产品边界，不代表已确认现有实现。未安装依赖、运行研究对象的代码或测试、下载模型权重、启动推理服务，也未向模型发送任何 Botanic 私有内容。唯一仓库交付是本报告。

证据标记：**源码事实**是固定版本代码直接体现的行为；**官方声称**是作者报告、尚未经本次推理复验的结果；**建议/推断**是据此形成的集成判断；**未验证**不等于不支持。

## 1. 结论与采用建议

**建议：列为可开展离线评估的文本决策候选；暂不批准作为生产决策权威。** 它的价值是对显式候选项做一次前向计算，返回封闭选项集内的结果和分布。现有一手证据不足以证明它能可靠处理 Botanic 的中文创意需求、品牌视觉判断、授权判断或完整 Agent 规划。[S03][S04][H01][H03]

| 场景 | 建议 | 依据与边界 |
|---|---|---|
| 简短需求的意图分类、选择下一步处理器、判断是否需要补充信息 | 条件适用：先离线测试，再考虑只记录建议的影子运行 | 动态选项和概率分布已有实现；中文与品牌领域准确率未知。[S03][S04][H01] |
| 根据已提取的文字、OCR 或结构化描述，给素材增加候选标签 | 条件适用 | 只能评估输入的文字；文字提取质量与模型判断质量须分别验证。[S05][S07] |
| 品牌一致性、排版、构图、Logo、产品形态等原图验收 | 不适用当前模型入口 | 没有图像编码入口；HTTP 图像 content part 不会被当作图像处理。[S05][S07][H02] |
| 层级分类、多标签需求 | 可由调用方组织，非现成能力 | SDK 是每题单选；层级顺序、多个标签及相互约束均需外部逻辑。[S03][S04] |
| 完整创意规划、长链推理、工具编排、图谱搜索 | 不建议替代现有 Agent | 不生成计划或工具调用；论文自己报告多步推理与图搜索局限。[S06][P01] |
| 授权、付费生图批准、幂等去重、取消/恢复裁决、实体状态确定 | 不适用 | 选项概率不是用户授权、事务锁、幂等记录或实体事实。此为集成边界，不依赖模型准确率。 |

“不会输出枚举之外的答案”是输出范围保证，**不等于判断正确、无幻觉、不会失败或可以自动执行**。即使结果是 `allow` 且概率接近 1，也不能创造调用者没有的权限。[S03][S04][S06]

## 2. 版本、来源与可追溯性

| 对象 | 本次核实的版本 |
|---|---|
| GitHub 仓库 | `FLock-io/this-that-model`，公开仓库；默认分支 `main`。[repo-api] |
| 默认分支 HEAD | `f00d3abf8e1783737f9858cfd5f7972047a14967`；提交标题 `Test Laya`；committer 时间 `2026-09-21T14:26:04Z`。[commit] |
| 独立确认 | GitHub REST `commits/main` 与 `git ls-remote --symref … HEAD` 返回相同 SHA；后者同时返回 `ref: refs/heads/main HEAD`。 |
| 抓取方式 | 官方 codeload 的固定 SHA 源码归档，解压至独立临时目录；按该副本核对下文行号。 |
| Python 包声明 | `thisthat`，`1.0.0`，Python ≥3.10，开发状态标记为 Beta；不是已核实的 PyPI 发布状态。[S01] |
| Hugging Face 权重仓库 | `flock-io/this-that-model-1.0`，revision `3d927195c4f9845efe66c5715883a7a0f42b1239`。[model-api][model-tree] |
| 官方空间评测集 | `limberc/this-that-spatial-bench`，revision `423c49f4ad2b8d200b38e845fdf046ba6b37d46b`。[dataset-api] |
| GitHub Releases | 检查时为空列表；代码 commit、包内版本号、HF 权重 revision 是三个不同版本标识。[releases] |

临时证据目录为 `/tmp/this-that-model-research.HjsCXW/`，不进入项目或作为永久引用。GitHub 代码引用全部固定到上述完整 SHA；HF 文本也固定 revision。TypeSafe 官网文档未提供固定发布版本链接，属于研究日期当日快照，后续可能变化。

本次 GitHub REST、Git 只读引用查询、codeload、Hugging Face 和 TypeSafe 官方站点均可访问，没有以第三方镜像或搜索摘要替代原始证据。

## 3. JEV 到底是什么，与 this-that-model 的关系

**官方写法为 `Jev`，是 TypeSafe AI 的模型产品名，名称来自 William Stanley Jevons。不是本次可展开成英文词组的缩写。** TypeSafe 创始发布文章 FAQ 原文为：“We named Jev after William Stanley Jevons.” 同文将 System One 的命名关联到 Kahneman 的 System 1/System 2。不能自行把 JEV 扩写成某种 judge、embedding 或 evaluation 架构。[J01]

这几个名称应分开：

| 名称 | 官方证据所支持的身份 |
|---|---|
| Jev / TypeSafe | TypeSafe 自有 System One 模型及托管 API。官方当前文档列 `jev-1.13.0`；`jev-latest` 是可移动别名。[J02][J03] |
| this-that-model | FLock 发布的约 1.88B 参数模型、Python 推理包及可选自托管 HTTP 包装。README 将 Jev 列作比较对象，不声称这是 Jev 的官方权重或 SDK。[S01][S02][H01] |
| NanoJev | 第三方开源复现项目；FLock 引用其模拟器和 68 道题的 Jev 服务返回记录。NanoJev 不是 TypeSafe 官方 Jev。[S12] |
| decider-2b | FLock 模型卡声明的上游模型名称，注明 Apache-2.0。公开 `Mapika/decider-2b` 模型卡与该名称相符，但 FLock 没有给出完整命名空间和起始 revision，不能锁定其实际训练起点。[H01][H05] |

Jev 官方协议是 `POST https://api.typesafe.ai/v1/systemone`，Bearer 鉴权，输入 `{state, model, questions}`，question 类型包括 `choice`、`score`、`noul`；返回 `answers`。this-that-model 的 HTTP 协议则是 `/v1/chat/completions`，输入 messages 和 enum，**并非直接兼容 Jev 的 System One 协议**。[J02][J04][S06][S07]

## 4. 能力矩阵：以当前源码为准

| 必核项 | 已核实结论 | 直接来源 |
|---|---|---|
| 模型 / SDK / 服务 | 三者都有：HF checkpoint；本地 `TypedDecider` Python 包；可选 FastAPI 服务。未发现 FLock 为此模型提供的公开托管推理 URL/SLA。 | `pyproject.toml:5–35`；`thisthat/model.py:79–99`；`thisthat/server.py:119–132`。[S01][S03][S06] |
| 文本 | SDK 的 `state: str`、`Question.text` 和字符串 options 经 tokenizer 输入；JSON 需先序列化成文本。不是图像模型。 | `thisthat/model.py:114–137`；`thisthat/prompt.py:99–133`。[S03][S05] |
| 图像 | 无 image processor、pixel tensor 或图像编码路径；HTTP content 数组只读取各项的 `text`。常规 `image_url` 项会贡献空字符串，不能据 HTTP 接受 JSON 就认定支持图像。 | `thisthat/openai_protocol.py:58–68`；HF `config.json:2–4,51` 为 `Qwen3_5ForCausalLM` / `qwen3_5_text`。[S07][H02] |
| 动态 label | 每次请求可传不同选项，2–255 个，必须互异；不是固定分类头的预设类别表。内部用单 token 标签对位置编码，外部选项本身可为多词描述。 | `thisthat/types.py:7–30`；`thisthat/prompt.py:35–80`。[S04][S05] |
| 动态 label 的质量 | 接口可接收新 label，不代表模型理解任意新领域。255 是代码上限，不是 255 分类准确率保证；现有宽度测试只列到 26，且主要验证输出形状与归一化。 | `tests/test_head.py:16–23`。[S11] |
| 层级 | 无树、parent/child、路径概率或层级约束实现；HTTP 只找顶层 properties 中第一个 enum 或根 enum。可由调用方逐层调用或枚举完整路径，但这是集成方案。 | `thisthat/openai_protocol.py:15–46`；`thisthat/types.py:42–53`。[S07][S04] |
| 单题多标签 | 不支持原生多选：每题始终以最大概率选一个 index。对一组概率取 top-k 不能自动变成多标签成立概率。 | `thisthat/model.py:165–172`。[S03] |
| 多问题 | Python `decide(state, [Question,…])` 在一个 forward pass 读多个 answer slot；`decide_batch` 可处理多状态。HTTP 当前只构建一个 Question，不暴露 SDK 的多问题接口。 | `thisthat/model.py:102–125,145–175`；`thisthat/server.py:75–77`。[S03][S06] |
| 多问题的一致性 | 没有先前答案回填、联合约束或矛盾消解。默认 `state_first` 按题插入 slot，后题可看到前题文本；不能把“一次前向”理解成问题顺序完全无影响或结果逻辑相容。 | `thisthat/prompt.py:122–130`。[S05] |
| 分数归一化 | 每题仅在有效 label logits 上做 `softmax(logits / temperature)`，裁去其余项后再归一化；和为 1，表示当前候选集内的相对分布。 | `thisthat/model.py:103–111,163–172`。[S03] |
| confidence | `probabilities[index]`，即最大选项概率，没有额外 confidence head。 | `thisthat/types.py:47–53`。[S04] |
| 阈值 | 库没有内置阈值路由或自动拒答参数；README 的 `<0.8: escalate()` 是调用方示例，不是跨领域标定的生产阈值。 | `README.md:17–42`；`thisthat/model.py:114–134`。[S02][S03] |
| unknown / abstain | 默认不存在 unknown 状态，始终选枚举之一。调用方可声明 `unknown` / `cannot tell` 为普通选项，或按阈值在模型外转人工；均不构成可靠的域外检测保证。论文另称训练中插入过 abstention 选项，但未交付对应训练集与复现链。 | `thisthat/model.py:165–172`；`tests/test_head.py:7–13`；论文 p.6 §3.3。[S03][S11][P01] |
| Score / Noul | 当前包只公开 Question/Decision 的类别选择。可自行以有序 enum 或 yes/no 表示任务，但没有 Jev 的 Score/Noul 类型和全部语义。 | `thisthat/types.py:10–60`；`thisthat/__init__.py:1–15`。[S04][S19] |

候选集合改变后，分母和竞争关系都会变化，所以跨 label 版本、类别数量、语言与温度的 `confidence` 不能直接横向比较。所有选项都不合适时，softmax 仍会分配总和 1；输出范围保证不解决这个问题。此结论由上述归一化与 argmax 实现推出，不是模型实测。

**Jev 的 confidence 不能直接迁移。** Jev 官方文档说 confidence 是由分布计算的统计量；其三选项交互示例用 `(3×最大概率−1)/2` 近似，明确只是 demo approximation，不能当成服务端完整公式。官方 API 示例中最大概率 0.85 对应 confidence 0.78，也与 this-that 的定义不同。阈值迁移必须重新验证。[J04][J05]

Jev 同样把 Choice 定义为单选，建议显式加入 `other`，并用多次 Choice 组织层级分类；这不是 this-that 自动继承的功能。[J06]

## 5. 实际推理入口与 HTTP schema

### 5.1 本地推理链

静态调用链为：`TypedDecider.from_pretrained()` → tokenizer 和 `AutoModelForCausalLM` → `decide()` / `decide_batch()` → `prompt.build()` → backbone hidden state → answer slot → label embedding 投影 → 选项 softmax → `Decision`。代码没有调用 `generate()` 或自回归解码循环。[S03][S05]

SDK 默认 `temperature=1.0`、`layout="state_first"`、`max_state_tokens=1536`；batch 默认 8。state 超预算只保留前部 token 切片、丢弃尾部，返回值没有截断告警。题目和选项另加在后面，1536 不是完整请求 token 上限。HTTP 没有暴露 layout / max_state_tokens 配置，使用 SDK 默认值。[S03][S05][S06]

HF config 声明 `max_position_embeddings=262144`，**不能据此宣称当前 HTTP 支持 262k 上下文**，也不能等同于该长度下的已测质量或显存要求。[H02]

### 5.2 HTTP 路由与请求

入口为 `python -m thisthat.server`，默认监听 `127.0.0.1:8000`。源码提供 `GET /health`、`GET /v1/models`、`POST /v1/chat/completions` 以及 FastAPI `/docs`；本次未启动服务。[S06]

下例是根据源码写的接口示意，内容为无私有数据的普通示例，**未发送请求**：

```json
{
  "model": "flock-io/this-that-model-1.0",
  "messages": [
    {"role": "user", "content": "Please summarize the attached brief."},
    {"role": "user", "content": "Which kind of request is this?"}
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "decision",
      "schema": {
        "type": "object",
        "properties": {
          "intent": {"enum": ["summarize", "classify", "unknown"]}
        },
        "required": ["intent"],
        "additionalProperties": false
      }
    }
  },
  "temperature": 1.0,
  "logprobs": true,
  "stream": false
}
```

实际解析规则与一般 OpenAI API 不同：[S06][S07]

- `messages` 中最后一条 `role=user` 是 question；**其余所有消息**的文本拼成 state，源码甚至会包括排在该 user 后面的非 user 消息。role 不作为独立权限或指令等级传给模型。
- enum 可来自 `response_format.json_schema.schema`、`response_format.schema`，或恰好一个 tool 的 `function.parameters`；也接受根 schema 的 enum，输出字段名默认为 `answer`。
- properties 中有多个 enum 时只返回遍历到的第一个；不递归处理嵌套 schema。`required`、`additionalProperties`、`strict` 和工具调用语义不是此解析器完整验证的契约。
- enum 成员统一 `str()` 化；数字/布尔类型并不会保持原 schema 的类型。接入时应只传互异字符串选项。
- 无 enum、无有效 user message、选项少于 2 或大于 255有明确 400 路径。重复选项在随后构造 Question 时抛 ValueError，该处不在现有 400 捕获区内，不能保证所有坏请求都得到一致 400；此为静态发现，未做 HTTP 复现。
- 请求的 `model` 不参与选择或验证，响应返回进程启动时已加载的 `model_name`。不能以请求字段证明真正用了哪个 checkpoint。
- temperature 用 `max(1e-3, float(value or 1.0))` 处理，因此 `0` 会变成 1.0，负数会夹到 0.001；不能假设与通用生成 API 的温度语义一致。

### 5.3 返回结构

非流式返回 `chat.completion` 形状；核心字段如下，均由 `thisthat/server.py:80–103` 直接确认：[S06]

| 路径 | 实际含义 |
|---|---|
| `choices[0].message.content` | 字符串化 JSON：`{"intent":"<所选枚举项>"}`；调用方仍需一次 JSON 解析。它没有模型自由文本解析问题，不等于整个 HTTP 响应无需解析。 |
| `this_that.index` / `choice` | 0 起始选项下标和选项文本。 |
| `this_that.probabilities` | 以全部选项文本为 key 的分布。 |
| `this_that.confidence` | 被选项概率。 |
| `this_that.latency_ms` | 服务端包围 `decider.decide` 的计时，不含客户端网络、请求排队等完整耗时。 |
| `choices[0].logprobs.content[0]` | 仅 `logprobs=true` 时存在；把整个选项文本包装为 token，提供其 logprob 和 top_logprobs。不是生成 token 序列的真实逐 token logprob。 |
| `usage` | `prompt_tokens`、`completion_tokens`、`total_tokens` **全部硬编码为 0**。零输出生成 token 合理，但零 prompt_tokens 不是实际无输入计算，不能用于计费或容量评估。 |

`stream=true` 只返回一个包含答案的 SSE chunk，再发 `[DONE]`，没有逐 token 生成；当前 chunk 没有非流式响应中的 `this_that`、logprobs 或 usage。需要概率做路由时应明确选择非流式接口。传 tool schema 也仍然返回普通 message content，不会生成 OpenAI `tool_calls`。[S06]

这是可研究使用的 HTTP 包装，不能视为完整 OpenAI 协议实现或已具备生产服务保障。源码未实现 API key 鉴权、配额、限流或跨请求合批，且 async handler 直接执行同步推理；生产并发、队列、超时和取消表现均未测。[S06]

## 6. 权重、训练、数据与许可证

### 6.1 已公开资产

- **权重**：HF API 显示模型公开、未 gated；`model.safetensors` 为 3,763,692,048 bytes，参数数量 1,881,825,088，BF16。LFS 宣告 SHA-256 为 `11bab4bbbce0214dcb4d70a88e74b3e4bde6fe8a95f239e3d0c355946e0000e0`。本次只读取元数据，未下载，因此不是本地完成的权重哈希校验。[model-api][model-tree]
- **结构**：模型卡描述 24 层、18 层 DeltaNet linear attention、6 层 full attention，config 的 layer_types 与此一致；没有视觉分支。[H01][H02]
- **评测数据**：GitHub 包含 `data/recorded_68.jsonl`；HF 数据集文件树是 README、`test.jsonl`、`stats.json`、`fingerprints.txt` 等。卡片将唯一 split 定义为 test，不能把它当训练集发布。[S13][H03][dataset-api]
- **许可证**：GitHub LICENSE 为 MIT，要求保留版权和许可声明；NOTICE 标记 NanoJev 模拟器与记录数据的 MIT 来源。HF 模型卡和评测集卡也声明 MIT；模型卡另注明 `decider-2b` 上游为 Apache-2.0，不能用本仓库 MIT 覆盖全部上游义务。[S12][S14][H01][H03]

### 6.2 训练公开到什么程度

论文声称混合 cross-entropy 与 Brier 目标、使用基于结果的训练估计器，并在部分题中加入 abstention；第二轮空间训练生成了 60,200 道新题，按 fingerprint 与 rendered state 排除评测重合。论文还描述 `θ(λ)=θ₀+λΔ` 的回退方式。[P01，p.6、12]

**未交付完整训练复现链。** 检查本次源码文件树及 HF 文件树，未发现对应训练入口、完整训练样本、数据清单与各项许可、优化器状态、训练配置或两套 checkpoint + λ 加载接口。当前 `from_pretrained` 直接加载单一 checkpoint。模型卡的 adaptation 说明及论文公式不等于仓库已经提供可执行训练或 λ 回滚功能。[S03][S15][H01][model-tree]

公开 `Mapika/decider-2b` 模型卡声明源自 `Qwen/Qwen3.5-2B-Base`，并链接自己的训练资料；这是该上游项目的一手陈述。FLock 未固定其起点，不能把 Mapika 当前 v10 的训练配方、`abstain_below`、视觉变体、System One 协议、缓存或性能直接归给 FLock 此 checkpoint。[H05]

正式采用前仍需锁定 FLock 的精确上游 revision、训练数据许可和权重发布链。现有资产支持“权重及推理代码公开”，不足以支持“训练完全可复现”或“所有训练数据商业授权已逐项核实”。

## 7. 中文、延迟、硬件与自托管证据

### 中文与领域迁移

this-that 模型卡标记 `language: en`；空间评测集也标记英文，并明确承认英语是每类两三种模板，**不测试自然表达鲁棒性**。本次核查的 README、推理代码、模型卡和公开 benchmark 文档中没有中文准确率、中文校准或中文品牌场景报告。[H01][H03]

对 vendored 68 条 JSON 数据做独立读取，确认均是二选一、17 个不同 state，未发现 CJK 汉字。这个结果只覆盖这份记录集；未对 7,305 条 test 数据逐条语言审计，也没有运行中文推理。能传 Unicode 字符串不证明中文表现可靠。[S13]

Jev 的官方 Models / State 文档则明确：英文是主要训练语言且表现最好，其他语言包括 CJK 可以处理，但准确率较低；没有在所查页面给出可用于 Botanic 的中文量化结果。Jev 也只支持文字、文字 JSON，不支持图像、音频和视频。[J03][J07]

### 运行条件与性能

| 项目 | 证据与适用限制 |
|---|---|
| 设备选择 | `CUDA → MPS → CPU`；默认 CUDA BF16、MPS FP16、CPU FP32。代码具备这些加载路径，不等于本次已验证运行成功。[S03] |
| 官方硬件 | README 将发布的延迟归于笔记本 RTX 5080；论文称使用单张 16GB 笔记本 GPU 训练。长状态 200×200 的测量使用 80GB 卡，模型卡说该例不能放入 16GB 笔记本 GPU。[S02][H01][P01] |
| 权重与内存 | 磁盘 BF16 权重约 3.76GB，不是峰值 VRAM/RAM。CPU 默认 FP32 下仅参数理论量级约 7.53GB，另需运行时、激活和缓存；此为按参数数量推算，不是实测最低配置。[model-api][S03] |
| 30.9ms | 官方脚本说明发布值是均值 30.9±16.6ms、中位数 27.3ms；README 的比较表却将 30.9 放在说明为 median 的列里，口径存在冲突。[S09][S02] |
| 本地测量方式 | `time_per_decision` 丢弃 warmup、batch=1 路径、CUDA/MPS 同步，计时 `decide`；不含模型首次加载、下载和 HTTP 网络。默认 repeats=100、warmup=25。[S03][S09] |
| Mac / CPU | README 预期 Mac 更慢；未提供可用于 Botanic 的 MPS/CPU p50/p95、吞吐、冷启动、并发或峰值内存结果，未验证“不同设备质量一致”的宣传性表述。[S02] |
| 自托管 | 支持本地模型目录与本地监听；可在准备好权重后评估离线部署。本次没有实际证明完整离线启动和依赖兼容。[S03][S06] |
| 依赖版本 | 包声明 `torch>=2.4`、`transformers>=4.57`；HF config 记录保存环境 `transformers_version=5.17.0`。尚未确认声明的最低版本能加载 `Qwen3_5ForCausalLM`；需固定并实测，不宜照最低版本承诺兼容。[S01][H02] |
| 缓存 | `schema_first` 有布局和 `prefix_len`，但当前 model.py 没有消费 prefix_len 或持久复用跨请求 KV/DeltaNet state。README/论文的前缀复用成本公式不等于此发布包已实现缓存。[S03][S05] |

Jev 官网公布 70–500ms 端到端响应和每百万输入 token $0.042；这是托管服务的官方声称，不是本次延迟/账单测量。[J01][J03] this-that 的“free”不包含硬件折旧、显存占用、运维、并发余量或托管成本；README 明确电费按 80W、$0.30/kWh 估算，$0.000014 是 **68 题整轮**的成本，不是每题成本，不能与服务价格直接当作同一口径比较。[S02][P01，p.7]

## 8. 官方 benchmarks 是否适用

### 8.1 能证明什么，不能证明什么

| 官方评测 | 官方报告 / 本次核查 | 对 Botanic 的适用性 |
|---|---|---|
| 68 题 / 17 state 的 recorded cohort | README：this-that accuracy 0.941、Brier 0.042、NLL 0.126；Jev 0.765 / 0.133 / 0.403。来源是第三方记录，不是本次在线对照。[S02][S12] | 仅支持局部迷宫几何二选一的有限比较；同一 state 上多题相关，小样本不能外推中文或品牌判断。 |
| 随机执行器校准 | 官方 accuracy 0.750、期望上限 0.746，qL2 0.0250 对 constant 0.0962；准确率针对抽样结果，轻微超过期望上限可由抽样波动产生。[H01][S17] | 能启发对概率进行校准评估；不能证明所有领域 `confidence=0.8` 就有 80% 正确率。 |
| Context ladder | 32×32 至 200×200，提供与答案相关的局部窗口明显优于整图；局部约 1.0。[S02][H01] | 支持减少无关上下文这一方法；不证明 1536-token 截断不会丢掉关键授权、否定或用户约束。 |
| 7,305 道空间题 / 6,525 state / 15 families | README 和模型卡：整体 0.839；每类前150题的 2,250 子集为 0.844；Jev 子集 0.803。[S02][H01][H04] | 迷宫/贪吃蛇、ASCII/JSON/模板文字，非像素输入、中文创意需求、品牌审美或真实 Agent 操作。 |
| 内部 42-family suite | 论文引用但明确 internal suite 不发布；部分 headline 延迟来自该集合。[P01，p.1、14][S09] | 不能独立复算全部宣传指标，不能作为 Botanic 验收集。 |

本次用独立数据读取与算术复算了 recorded 文件中的 Jev 指标：accuracy `0.7647058824`、Bernoulli Brier `0.1332132353`、NLL `0.4027685092`，与其显示为 0.765 / 0.133 / 0.403 一致。**只复核已记录概率的算术，不证明当今 Jev 服务、this-that 权重或模型对比已复验。** 文件没有固定 Jev 服务版本的字段，不能归因为当前 `jev-1.13.0` 的性能。[S13][S16]

空间 benchmark 的训练分布差异必须保留：FLock 明确当前 checkpoint 训练过全部 15 种题型，而托管对照模型在此为 zero-shot。排除了完全相同的评测项，也不等于题型没见过。因此 0.844 对 0.803 不能写成通用“超过 Jev”，更不能外推“比更大模型适合品牌 Agent”。[S02][S08]

HF 数据集的 `seen_in_training` 卡片仍称只有 2,000/7,305 属于训练题型；这与后来 checkpoint “全部15类训练过”的说明不是同一个训练阶段。不能把 `unseen` 列直接解释成当前 checkpoint 的真正未见领域成绩。[H03][S08]

### 8.2 同一发布材料中的不一致

| 指标 / 功能 | README / 模型卡 | 同固定源码或论文里的另一说法 | 本报告处理 |
|---|---|---|---|
| recorded accuracy / Brier / NLL | 0.941 / 0.042 / 0.126 | `scripts/reproduce_recorded.py:27` 的 EXPECTED 是 0.926 / 0.046 / 0.139；测试也用 0.926 / 0.046。 | 全部保留，不替作者选一个当实测值。[S02][S10][S18] |
| recorded 温度 | SDK 默认 1.0 | 重现脚本和对应测试使用 1.3。 | 校准结果需要绑定温度。相同 logits 下正温度不改变 argmax，不能只靠温度为 accuracy 差异作解释。[S03][S10][S18] |
| 空间全量 / 子集准确率 | 0.839 / 0.844 | 仓库论文 p.12 为 0.871 / 0.868。 | 未找到各数字与权重 revision 的明确对应，不能宣称完整复现。[S02][H01][P01] |
| ASCII / JSON / prose 训练后结果 | 0.779 / 0.936 / 0.942 | 论文 p.12 为 0.844 / 0.958 / 0.967。 | 视为版本或实验记录待澄清，不自行猜原因。[S02][P01] |
| 30.9ms 的统计口径 | 比较表文字称 median | 测量脚本明示 mean 30.9、median 27.3。 | 不给统一 p50 承诺。[S02][S09] |
| 前缀缓存与 λ 回滚 | 文档/论文描述能力或收益 | 当前推理入口未见缓存复用及 λ 加载实现。 | 按已发布代码能力评估。[S03][S05][P01] |

另需注意：CI 的真实 GPU 测试只在 `workflow_dispatch` 且有 self-hosted GPU runner 时运行；测试 fixture 无 CUDA 会跳过模型测试。因此看到一般 CI 配置或通过标记，不足以证明所有发布指标已持续检验。本次未查询每次 CI 运行日志，也未运行测试。[S20][S21]

## 9. Botanic 集成边界与最小评估方案

以下为建议，不是实现任务或对 Botanic 当前代码的审计结论。

主审在本次协作中报告三项输入问题：Memory 安全投影丢失 `status` / `subject` / `conflictsWith`，Ontology 先截取 240 项导致显式引用丢失，以及 `artifact_search` 先取 80 项再匹配。本研究未复审其实现。它们应被视为评估决策模型前的输入完整性条件：模型无法恢复未收到的状态、引用和候选 Artifact；更高置信度不能抵消这些缺失，也不能用分类结果掩盖它们。

1. **只给建议，不给执行权。** 模型输出可作为 `意图候选 + 各项概率 + 需澄清/人工复核`；程序从受控 allowlist 映射到处理器。模型不得创造工具、权限、资源 ID 或批准动作。
2. **授权继续由显式用户动作与确定性权限检查决定。** “用户似乎想生成图片”不等于同意付费；“可以删除”分类不等于删除授权。高置信度也不能跳过确认、媒体授权或数据访问校验。
3. **幂等与状态继续由现有控制面决定。** 任务幂等键、取消版本、恢复状态、项目版本冲突和事务结果不能由分类模型判断替代。重试后的两个相同标签不证明两次外部动作是同一次操作。
4. **实体权威保持独立。** Session、Message、Memory、Run、生成任务及持久化记录的权威由项目约束决定；分类输出不能把 UI 暂态变成完成状态，也不能证明 Artifact 已生成、可访问、已授权或已持久化。Artifact 历史血缘不能因标签或画布选择而被改写。
5. **明确保留 unknown 与失败通路。** 低置信度、选项覆盖不足、超长 state、缺少上下文、服务超时和格式异常，都走现有可恢复分支；“unknown 枚举项”与“调用失败”分别记录，不能强行选最近类别后继续执行。

若后续获准实验，最小可判定方案是：

- 先用公开或人工合成、无需外传私有素材的中文/英文成对样本；覆盖创建、修改、整理、评审、取消、查询、缺少对象、多意图、否定和未知类别。另设含提示注入文字的 state，检查是否把素材文字误当授权。
- 固定源码 SHA、权重 revision、tokenizer、温度、label 文本与顺序、截断规则。分别记录中文表现和英文表现，不以翻译后的好成绩替代原中文成绩。
- 与既有规则基线及当前决策方案对照；关注每类召回、错误自动执行率、unknown 检出/误报、概率校准，以及不同阈值下“可自动处理比例—错误率”的权衡。阈值应由风险目标和验证集决定，不直接使用 README 的 0.8。
- 在实际目标硬件上测冷启动、稳态 p50/p95、峰值内存、并发和服务失败处理；核查概率能从 HTTP 完整返回、状态截断不会悄悄吞掉关键条件。
- 只有文本语义任务的指标满足要求后才考虑影子运行；视觉验收仍需有图像能力的独立链路。不会因该评估结果自动获得发布、授权改造或生产流量切换许可。

## 10. 明确未验证项与交付状态

| 未验证项 | 当前证据缺口 |
|---|---|
| 中文品牌视觉生产需求分类质量 | 无官方中文分项评测；本次未推理。 |
| 模型真实图像理解能力 | 当前入口无图像支持；未考察或采用其他模型的视觉变体。 |
| 新 label / 255 类 / 多问题 / 层级的稳定性 | 类型与计算路径已核，真实语义准确率、顺序敏感性、矛盾率未测。 |
| unknown 与高置信度错误 | 无 Botanic 域外/拒答评测，不具备本领域阈值。 |
| 当前权重与全部论文数字一致性 | 文档、脚本常量与 PDF 有明确冲突；没有运行模型裁定。 |
| 训练可复现、全量数据许可与上游确切起点 | 当前发布材料不完整；未把同名上游最新版本当已确认祖先。 |
| Mac/CPU、依赖最低版本、离线启动、服务稳定性 | 只有源码加载路径和部分官方叙述；未安装、启动或压测。 |
| 实际服务费用和速度 | 未调用 Jev/FLock 服务；电费、托管价格与端到端延迟口径不同。 |
| Botanic 接入位置与当前实现是否满足边界 | 按用户要求未检查业务源码，由主审代码任务判断。 |

本报告由主审委派的研究子任务按 research skill 完成一手材料追溯，主审另行审查 Botanic 业务链路并复核关键推理/协议源码。核查只包含静态源码阅读、公开资料抓取及记录数据的独立算术复核，未将仓库内测试代码执行结果或作者报告冒充为本次实测。

## 证据索引

下列 S 编号均指 `FLock-io/this-that-model` 的固定 commit；标签中的路径和行号可直接供主 agent 复查。PDF 用页码/章节定位；H 为固定 HF revision；J 为 TypeSafe 当日官方文档。

- [S01 — pyproject.toml:5–39，包名、版本、依赖、Beta 标记][S01]
- [S02 — README.md:1–284，官方用法、指标与限制][S02]
- [S03 — thisthat/model.py:25–222，加载、推理、softmax、计时][S03]
- [S04 — thisthat/types.py:7–60，选项约束、Decision 与 confidence][S04]
- [S05 — thisthat/prompt.py:28–133，label、截断、布局][S05]
- [S06 — thisthat/server.py:49–137，HTTP 实际输入/输出与启动][S06]
- [S07 — thisthat/openai_protocol.py:15–68，enum 与 message 解析][S07]
- [S08 — scripts/reproduce_spatial.py:1–88，训练分布 caveat 与评测子集][S08]
- [S09 — scripts/measure_latency.py:1–65，均值、中位数与采样条件][S09]
- [S10 — scripts/reproduce_recorded.py:26–92，EXPECTED 与温度][S10]
- [S11 — tests/test_head.py:7–49，范围测试与 unknown 示例][S11]
- [S12 — NOTICE:1–26，NanoJev 与服务记录来源][S12]
- [S13 — data/recorded_68.jsonl:1–68，公开原始记录][S13]
- [S14 — LICENSE:1–21，MIT 条款][S14]
- [S15 — 固定源码树，已发布文件范围][S15]
- [S16 — benchmarks/metrics.py:17–49，指标定义][S16]
- [S17 — scripts/reproduce_simulator.py:33–73，校准评测与期望上限][S17]
- [S18 — tests/test_published_results.py:13–45，旧指标与容差][S18]
- [S19 — thisthat/__init__.py:1–15，公开接口][S19]
- [S20 — .github/workflows/ci.yml:62–69，GPU 测试触发条件][S20]
- [S21 — tests/conftest.py:15–23，无 CUDA 时跳过][S21]
- [P01 — 仓库论文，p.6 训练/abstention/λ，p.7 recorded，p.12–14 空间评测及限制][P01]
- [H01 — 官方模型卡 README.md:1–217][H01]
- [H02 — 官方模型 config.json:1–75][H02]
- [H03 — 官方评测集卡 README.md:1–110][H03]
- [H04 — 官方评测集 stats.json][H04]
- [H05 — Mapika/decider-2b 自身模型卡；不证明 FLock 的起始 revision][H05]
- [J01 — TypeSafe 发布文章，FAQ 名称来源、输入与速度][J01]
- [J02 — TypeSafe Introduction，Jev 与三类 primitives][J02]
- [J03 — TypeSafe Models，版本、价格、语言与输入支持][J03]
- [J04 — TypeSafe Quick start，真实 HTTP schema][J04]
- [J05 — TypeSafe Confidence，派生统计量及 demo 近似][J05]
- [J06 — TypeSafe Choice，单选、other 与层级组合][J06]
- [J07 — TypeSafe State，文字与 CJK 边界][J07]

[repo]: https://github.com/FLock-io/this-that-model
[repo-api]: https://api.github.com/repos/FLock-io/this-that-model
[commit]: https://github.com/FLock-io/this-that-model/commit/f00d3abf8e1783737f9858cfd5f7972047a14967
[releases]: https://api.github.com/repos/FLock-io/this-that-model/releases
[model-api]: https://huggingface.co/api/models/flock-io/this-that-model-1.0/revision/3d927195c4f9845efe66c5715883a7a0f42b1239
[model-tree]: https://huggingface.co/api/models/flock-io/this-that-model-1.0/tree/3d927195c4f9845efe66c5715883a7a0f42b1239
[dataset-api]: https://huggingface.co/api/datasets/limberc/this-that-spatial-bench/revision/423c49f4ad2b8d200b38e845fdf046ba6b37d46b
[S01]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/pyproject.toml#L5-L39
[S02]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/README.md#L1-L284
[S03]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/model.py#L25-L222
[S04]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/types.py#L7-L60
[S05]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/prompt.py#L28-L133
[S06]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/server.py#L49-L137
[S07]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/openai_protocol.py#L15-L68
[S08]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/scripts/reproduce_spatial.py#L1-L88
[S09]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/scripts/measure_latency.py#L1-L65
[S10]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/scripts/reproduce_recorded.py#L26-L92
[S11]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/tests/test_head.py#L7-L49
[S12]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/NOTICE#L1-L26
[S13]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/data/recorded_68.jsonl#L1-L68
[S14]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/LICENSE#L1-L21
[S15]: https://github.com/FLock-io/this-that-model/tree/f00d3abf8e1783737f9858cfd5f7972047a14967
[S16]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/benchmarks/metrics.py#L17-L49
[S17]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/scripts/reproduce_simulator.py#L33-L73
[S18]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/tests/test_published_results.py#L13-L45
[S19]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/thisthat/__init__.py#L1-L15
[S20]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/.github/workflows/ci.yml#L62-L69
[S21]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/tests/conftest.py#L15-L23
[P01]: https://github.com/FLock-io/this-that-model/blob/f00d3abf8e1783737f9858cfd5f7972047a14967/paper/this-that-model.pdf
[H01]: https://huggingface.co/flock-io/this-that-model-1.0/blob/3d927195c4f9845efe66c5715883a7a0f42b1239/README.md#L1-L217
[H02]: https://huggingface.co/flock-io/this-that-model-1.0/blob/3d927195c4f9845efe66c5715883a7a0f42b1239/config.json#L1-L75
[H03]: https://huggingface.co/datasets/limberc/this-that-spatial-bench/blob/423c49f4ad2b8d200b38e845fdf046ba6b37d46b/README.md#L1-L110
[H04]: https://huggingface.co/datasets/limberc/this-that-spatial-bench/blob/423c49f4ad2b8d200b38e845fdf046ba6b37d46b/stats.json
[H05]: https://huggingface.co/Mapika/decider-2b/blob/b37f7e1ba3fbc9238004cf531fabbee2619973fd/README.md#L1-L84
[J01]: https://typesafe.ai/blog/introducing-system-one-models-and-jev
[J02]: https://docs.typesafe.ai/introduction
[J03]: https://docs.typesafe.ai/models
[J04]: https://docs.typesafe.ai/introduction/quickstart
[J05]: https://docs.typesafe.ai/confidence
[J06]: https://docs.typesafe.ai/primitives/choice
[J07]: https://docs.typesafe.ai/concepts/state
