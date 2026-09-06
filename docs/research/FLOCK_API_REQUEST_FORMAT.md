# FLock API Platform OpenAI-compatible Chat Completions 请求格式研究

> 调研日期：2026-09-04
>
> 对象：FLock API Platform（`api.flock.io`）文本 Chat Completions 入口
>
> 证据边界：仅使用 FLock 官方文档、官方公开控制台说明、官方 GitHub 仓库与官方 npm CLI/SDK 源码。未发送任何真实 Provider 请求，未读取本地密钥、环境变量实值、请求日志或账号数据。
>
> 官方源码快照：[`FLock-io/model-api-platform@793621c`](https://github.com/FLock-io/model-api-platform/tree/793621cf1f4f03d30d33c73971f6ed107f14f772)（2026-09-02）。

## 结论摘要

1. **可直接作为 FLock 公开契约使用的最小接口**是：`POST https://api.flock.io/v1/chat/completions`，请求头使用 `x-litellm-api-key: <FLock API key>`，正文至少包含 `model` 与 `messages`。FLock 明确把 `Authorization: Bearer <jwt>` 分配给 `platform.flock.io/api` 管理接口，而不是推理接口。[FLock API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)；[官方 Agent 文档](https://platform.flock.io/agents)；[官方源码中的服务边界](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L17-L25)
2. **FLock 没有公开完整的 Chat Completions schema。** 官方页面只演示 `system`、`user` 和字符串 `content`；没有枚举所有 `messages` 角色，也没有规定 `assistant.content` 在工具调用时应省略还是传 `null`。[FLock API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)
3. **FLock 官方资料没有给出 `tools`、`tool_choice`、返回 `tool_calls` 或第二轮工具结果回传的线级格式。** 官方源码只暴露模型级能力字段 `supports_function_calling`、`supports_tool_choice`、`supports_response_schema` 与 `supported_openai_params`，说明这些能力可能随模型变化，不构成平台全局保证。[官方模型信息类型](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/types/lite-llm.ts#L225-L243)
4. **不能从“OpenAI-compatible”推出 `GET /v1/models`、工具续接和 `response_format` 已被 FLock 逐项保证。** 当前官方推理端点表只列出 `/chat/completions`；官方控制台源码读取模型详情时调用的是内部 `/v1/model/info`。直接推理接口的 `GET /v1/models` 在本次官方资料中未形成公开契约。[官方端点表](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L263-L292)；[官方模型代理源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/models/route.ts#L42-L61)
5. **公开目录当前只给 Botanic 四个默认模型中的 `deepseek-v4-flash-vision-exp` 标注了 `Tools`。** `gemini-3.7-flash` 只有 `Text`，`kimi-k3` 为 `Text / Reasoning / MoE`，`glm-5` 为 `Coding / Text / Reasoning`。这些是目录展示标签，不是 function-calling wire contract；缺少 `Tools` 标签也不能反向证明模型一定不支持工具。[官方公开目录](https://platform.flock.io/api/models)
6. **`stream: true` 已确认使用 SSE。** 官方源码按 `data: ...` 读取事件、识别 `[DONE]`，并从 `choices[0].delta.content` 聚合文本；但没有处理或说明流式 `delta.tool_calls`。[官方 CLI SSE 解析](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/cli/src/commands/chat.ts#L7-L20)
7. **官方 CLI 的 `/api/lite-llm/messages` 是平台管理层代理，不等同于 direct inference。** 该代理重建请求体时只保留 `model`、`messages`、`stream`、`max_tokens`、trace 和 `stream_options`；客户端传入的 `tools`、`tool_choice`、`temperature`、`response_format` 不会被转发。要研究工具调用只能看 direct inference，不能用 CLI 代理行为代替。[官方代理实现](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L124-L142)

## 证据等级

| 标记 | 含义 |
| --- | --- |
| **已确认** | FLock 官方文档有明确说明，或官方生产源码直接构造/解析该字段。 |
| **模型级** | FLock 官方源码显示能力按模型记录，不能推广为所有模型均支持。 |
| **兼容性候选** | 符合 FLock 的“OpenAI-compatible”声明，但 FLock 没有逐字段确认。不能当成正式契约。 |
| **未确认** | 本次官方资料没有定义；必须由 FLock 补充文档，或另行授权做真实请求验证。 |

## 逐项核查表

| 项目 | 结论 | 状态 | 官方证据 |
| --- | --- | --- | --- |
| Base URL | Direct inference 基址为 `https://api.flock.io/v1`。 | **已确认** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)、[Agent 文档](https://platform.flock.io/agents) |
| 推理认证头 | 使用 `x-litellm-api-key: <FLock API key>`。 | **已确认** | [直接 cURL](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L234-L244)、[官方源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/lib/litellm-axios.ts#L70-L76) |
| `Authorization: Bearer` | 官方将其用于 `platform.flock.io/api` 的管理 JWT；官方故障排查明确要求 `api.flock.io` 改用 `x-litellm-api-key`。Bearer 对 direct inference 的兼容性未获官方保证。 | **已确认 / 未确认兼容性** | [服务边界](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L49-L56)、[401 指引](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L379-L386) |
| `GET /models` | `GET https://api.flock.io/v1/models` 没有出现在当前官方推理端点表；官方页面中的“List Models API”没有实际链接。管理目录是 `GET https://platform.flock.io/api/models`；官方控制台内部另用 `/v1/model/info`。 | **未确认** | [端点表](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L263-L292)、[模型代理源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/models/route.ts#L42-L61) |
| `POST /chat/completions` | 完整 URL 为 `https://api.flock.io/v1/chat/completions`。 | **已确认** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)、[官方 README](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/README.md#L122-L126) |
| `messages` | 官方示例使用对象数组；仅展示 `system`、`user` 和字符串 `content`。 | **已确认到示例范围** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint) |
| 角色全集 | `assistant`、`tool` 等角色未在 FLock API 页面枚举。平台代理 OpenAPI 只写“OpenAI-compatible chat messages”并允许任意属性。 | **未确认** | [代理 OpenAPI schema](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/docs/openapi.yaml#L1811-L1826) |
| `content` 可选性 | 没有官方说明 `assistant` 携带 `tool_calls` 时 `content` 应为字符串、`null` 或省略；也没有说明 `tool.content` 允许哪些类型。 | **未确认** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint) |
| `tools[].function` schema | FLock 没有公开字段级 schema 或示例。 | **未确认；模型级能力** | [模型能力字段](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/types/lite-llm.ts#L225-L243) |
| `tool_choice` | 官方源码记录 `supports_tool_choice`，但没有公开允许值或请求示例。 | **模型级 / 未确认格式** | [模型能力字段](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/types/lite-llm.ts#L225-L243) |
| 返回 `tool_calls` | 没有 FLock 官方响应示例；`finish_reason`、`id`、`function.arguments` 的格式也未定义。 | **未确认** | 当前 [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint) 只说明返回 completion object。 |
| 第二轮工具回传 | 没有官方示例确认 `assistant.tool_calls`、`tool_call_id`、`name`、`content` 的组合，也没有确认多工具调用顺序。 | **未确认** | 当前官方文档与官方 CLI 均无该流程。 |
| SSE | `stream: true` 返回 `text/event-stream`；官方 CLI 识别 `data: `、JSON chunk 与 `[DONE]`。 | **已确认（文本增量）** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)、[官方 OpenAPI](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/docs/openapi.yaml#L711-L732)、[CLI parser](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/cli/src/commands/chat.ts#L7-L20) |
| SSE 工具增量 | 官方 CLI 只解析 `delta.content`，没有说明 `delta.tool_calls` 的拼接规则。 | **未确认** | [CLI parser](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/cli/src/commands/chat.ts#L7-L20) |
| `max_tokens` | 直接 API 文档列为可选整数，文档默认值为 `16`；官方平台代理会固定覆盖为 `1024`。 | **已确认，但入口不同** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)、[代理源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L124-L133) |
| `temperature` | 文档列为可选数字，默认 `1`，范围 `0–2`。 | **已确认** | [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint) |
| `response_format` | API 页面没有列出；官方模型信息有 `supports_response_schema` 与 `supported_openai_params`，说明支持度可能按模型变化。 | **模型级 / 未确认格式** | [模型能力字段](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/types/lite-llm.ts#L225-L243) |
| Direct inference 错误体 | FLock 没有公开 `api.flock.io/v1/chat/completions` 的稳定错误 JSON schema。 | **未确认** | 当前 [API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint) 无错误章节。 |
| Platform proxy 错误体 | 管理/代理接口使用 `{ "error": string, "code": string }`；聊天代理按 HTTP 状态映射错误码。该格式不能自动外推到 direct inference。 | **已确认，仅限管理/代理层** | [官方错误格式](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L296-L318)、[代理错误映射](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L166-L190) |

## 1. Base URL 与认证

FLock 把两个服务明确分开：

| 服务 | Base URL | 凭据 | 用途 |
| --- | --- | --- | --- |
| LLM Inference | `https://api.flock.io/v1` | `x-litellm-api-key: <FLock API key>` | Chat Completions 等模型推理 |
| Platform Management | `https://platform.flock.io/api` | `Authorization: Bearer <JWT>` | 账号、团队、API Key、账单、用量与公开模型目录 |

来源：[FLock Agent & CLI Access](https://platform.flock.io/agents)；[官方仓库 SKILL.md](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L17-L25)。

### `Authorization: Bearer` 是否兼容 direct inference

官方结论应按更严格的说明处理：

- FLock 的 direct cURL 示例只发送 `x-litellm-api-key`。[官方 direct cURL](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L234-L244)
- FLock 官方源码调用推理网关时也发送 `x-litellm-api-key`。[官方网关客户端](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/lib/litellm-axios.ts#L70-L76)
- FLock 官方故障排查明确写明：`api.flock.io` 出现 401 时应使用 `x-litellm-api-key`，而不是 `Authorization: Bearer`。[官方 401 指引](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L379-L386)

同一份官方页面又提供了只设置 `api_key` 的 OpenAI Python SDK 示例，却没有显式展示如何补充 `x-litellm-api-key`。[官方 SDK 示例](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L246-L260) 因此官方资料在“SDK 示例”和“明确认证头要求”之间存在缺口；本研究不能据此声称 Bearer 已兼容。

**接入裁决：** direct inference 只把 `x-litellm-api-key` 视为受 FLock 官方支持的认证方式；`Authorization: Bearer` 仅用于 Platform Management JWT。若 SDK 会自行增加其他认证头，不应把该行为当成 FLock 契约。

## 2. 模型列表接口

### 官方已公开

- `GET https://platform.flock.io/api/models`：Platform Management 的模型目录，官方端点表标记为无需 JWT。[官方端点表](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L263-L286)
- 官方 CLI 的 `flock models list` 调用的也是上述管理接口，而不是 `api.flock.io/v1/models`。[官方 CLI models 源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/cli/src/commands/models.ts)
- 官方控制台自己的 LiteLLM 模型代理当前调用 `/v1/model/info`，并在存在 API Key 时使用 `x-litellm-api-key`。[官方模型代理](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/models/route.ts#L42-L61)

### 官方未公开

`GET https://api.flock.io/v1/models` 没有出现在 FLock 当前 direct inference 端点表中。API Endpoint 页面写了“Use the List Models API”，但链接在公开 Markdown 中是未解析的 `\[List Models API]`，没有给出 URL。[FLock API Endpoint Markdown](https://docs.flock.io/flock-products/api-platform/api-endpoint.md)

因此：

- 不能把公开目录 `platform.flock.io/api/models` 当作某个 API Key 实际可调用模型的完整证明；
- 也不能在不做真实请求的前提下，把 `/v1/models` 写成 FLock 已公开保证的 direct endpoint；
- `/v1/model/info` 是官方控制台源码使用的上游接口，但 FLock 没有将它列为面向客户的公共契约。

### Botanic 四个默认模型的公开目录标签

本次对官方公开目录执行了一次**无认证、非推理**的只读请求：[`GET https://platform.flock.io/api/models`](https://platform.flock.io/api/models)。2026-09-04 返回的相关条目如下：

| 模型 slug | `type` | `tags` | 目录层结论 |
| --- | --- | --- | --- |
| `deepseek-v4-flash-vision-exp` | `text` | `Text`、`MoE (DSA)`、`Reasoning`、`Tools` | 四个默认模型中唯一带 `Tools` 标签。 |
| `gemini-3.7-flash` | `text` | `Text` | 公开目录没有标注 `Tools`；条目的 `thumbnail` 为 `gemini.webp`，可与页面上的 Gemini 图标对应。 |
| `kimi-k3` | `text` | `Text`、`Reasoning`、`MoE` | 公开目录没有标注 `Tools`。 |
| `glm-5` | `text` | `Coding`、`Text`、`Reasoning` | 公开目录没有标注 `Tools`。 |

证据强度边界：

- `deepseek-v4-flash-vision-exp` 的 `Tools` 是 FLock 官方当前目录给出的正向能力标签；
- 目录条目的 `capabilities` 字段当前为 `null`，没有随标签提供 function schema、`tool_choice`、`tool_calls` 或第二轮消息契约；
- `gemini-3.7-flash`、`kimi-k3`、`glm-5` 缺少 `Tools` 标签，只能说明**公开目录未作该标注**，不能证明底层路由必然拒绝工具；
- 页面图标/thumbnail 只能确认模型展示身份，不能用作能力证据；
- 因而目录标签适合做产品预筛选，不足以证明 Botanic 的首轮工具调用、第二轮续接和流式工具调用均兼容。

## 3. 官方确认的最小 Chat Completions 请求

以下格式是 FLock 官方公开示例的最小安全子集，不会触发真实请求：

```http
POST /v1/chat/completions HTTP/1.1
Host: api.flock.io
Content-Type: application/json
Accept: application/json
x-litellm-api-key: <FLock API key>
```

```json
{
  "model": "<model-id>",
  "stream": false,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ]
}
```

来源：[FLock API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)。

### `messages` 的文档缺口

官方示例明确支持消息对象数组，但参数表又把 `messages` 描述为 `string | array`，并继续描述字符串、token 数组与 `<|endoftext|>` 分隔符；这与同页的 Chat Completions 消息对象示例不一致。[FLock API Endpoint Markdown](https://docs.flock.io/flock-products/api-platform/api-endpoint.md)

可确认的范围只有：

- `system` + 字符串 `content`：有官方示例；
- `user` + 字符串 `content`：有官方示例；
- `user.content` 为图像内容块：官方平台代理源码会检查 `image_url` 内容块大小，但该逻辑属于平台代理，不是 direct endpoint 的完整 schema。[官方代理校验源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L24-L50)

无法从 FLock 官方资料确认：

- `assistant.content` 是否允许 `null`；
- `assistant` 有 `tool_calls` 时是否必须省略 `content`；
- `tool.content` 是否只允许字符串，还是允许结构化内容数组；
- `developer`、`function` 等其他角色是否被 FLock 网关接受；
- 不同底层模型是否会进一步收紧消息形状。

## 4. Tools / Function Calling

### FLock 官方实际确认了什么

官方模型信息类型包含：

- `supports_function_calling`
- `supports_tool_choice`
- `supports_response_schema`
- `supported_openai_params`
- `supports_native_streaming`

来源：[官方 `types/lite-llm.ts`](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/types/lite-llm.ts#L225-L243)。这些字段证明 FLock 平台会跟踪模型能力，但也证明能力是**模型级属性**，不能认为所有目录模型都支持工具调用。

公开目录的当前标签与此边界一致：四个 Botanic 默认模型中只有 `deepseek-v4-flash-vision-exp` 带 `Tools`，但目录没有公开与该标签对应的 wire schema。[官方公开目录](https://platform.flock.io/api/models) 因此即使模型带 `Tools`，也不能把 FLock 的“OpenAI-compatible”概括性声明自动升级成“所有模型都实现完整且相同的 function-calling 契约”。

### FLock 官方没有确认什么

本次检索的官方 API 页面、Agent 文档、OpenAPI、CLI 与生产源码中均未找到以下公开 wire contract：

- `tools` 数组的 JSON Schema；
- `tools[].type === "function"` 的强制要求；
- `function.name`、`description`、`parameters`、`strict` 的允许范围；
- `tool_choice` 的允许值（如 `none`、`auto`、`required`、指定函数对象）；
- 模型响应中 `message.tool_calls`、`finish_reason`、`function.arguments` 的准确形状；
- `parallel_tool_calls`；
- 第二轮工具结果回传格式；
- 流式 `delta.tool_calls` 的分片与拼接规则。

### OpenAI 兼容性候选格式（不是 FLock 已确认契约）

下面只用于标出当前需要 FLock 确认或做授权验证的边界，不能作为“FLock 官方保证”引用。

首轮候选：

```json
{
  "model": "<model-id>",
  "stream": false,
  "messages": [
    { "role": "user", "content": "Research FLock FOMO" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_web",
        "description": "Search public web pages",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string" }
          },
          "required": ["query"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

候选响应：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "search_web",
              "arguments": "{\"query\":\"FLock FOMO\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

第二轮候选：

```json
{
  "model": "<model-id>",
  "stream": false,
  "messages": [
    { "role": "user", "content": "Research FLock FOMO" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_123",
          "type": "function",
          "function": {
            "name": "search_web",
            "arguments": "{\"query\":\"FLock FOMO\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_123",
      "name": "search_web",
      "content": "{\"results\":[{\"title\":\"...\",\"url\":\"...\"}]}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_web",
        "description": "Search public web pages",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string" }
          },
          "required": ["query"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

上述候选仍有四个无法靠 FLock 官方资料裁决的关键变体：

1. 第二轮 `assistant.content` 应传 `null` 还是完全省略；
2. `tool` 消息中的 `name` 是必需、可选还是不允许；
3. 第二轮是否必须再次携带 `tools` 与 `tool_choice`；
4. 不同 FLock 模型路由是否接受相同的续接格式。

这正是工具执行成功、第二轮模型请求仍可能返回 4xx 的协议风险点。

### 官方 Platform proxy 对工具调用的限制

官方 `/api/lite-llm/messages` 代理只从客户端读取 `model`、`messages`、`apiKey`，随后自行构建如下上游请求：

```ts
{
  model,
  messages,
  stream: true,
  max_tokens: 1024,
  litellm_trace_id: user.litellmUserId,
  stream_options: { include_usage: true }
}
```

来源：[官方代理源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L124-L142)。因此官方 CLI/平台代理当前不会把客户端传入的 `tools`、`tool_choice` 或 `response_format` 透传给 direct inference。工具型 Agent 应直接对接 `api.flock.io/v1/chat/completions`，并对每个模型单独验证能力。

## 5. Streaming SSE

### 已确认格式

`stream: true` 时：

- 返回 `text/event-stream`；
- 事件行以 `data: ` 开头；
- 普通事件 payload 是 JSON；
- 终止标记可为 `data: [DONE]`；
- 文本增量位于 `choices[0].delta.content`。

来源：[FLock API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)；[官方 CLI parser](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/cli/src/commands/chat.ts#L7-L20)；[官方代理 SSE 响应](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L144-L164)。

```text
data: {"choices":[{"delta":{"content":"Hel"}}]}

data: {"choices":[{"delta":{"content":"lo"}}]}

data: [DONE]
```

### 未确认格式

FLock 官方 CLI 只消费 `delta.content`。当前官方资料没有说明：

- `delta.tool_calls[].index`；
- 工具调用 `id`、`function.name`、`function.arguments` 是否分片；
- `usage` 在最后一个 chunk 还是独立 chunk；
- SSE 错误事件是 JSON chunk、普通 HTTP 错误体还是连接中断。

官方代理源码会设置 `stream_options: { include_usage: true }`，说明该对象至少被 FLock 自己使用，但 API Endpoint 页面没有公开 `stream_options` 的子字段契约。[官方代理 payload](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L124-L142)

## 6. `max_tokens`、`temperature` 与 `response_format`

| 参数 | 官方状态 | 结论 |
| --- | --- | --- |
| `max_tokens` | 已列入 API Endpoint | 可选整数；官方页面给出的默认值为 `16`。注意官方平台代理会固定传 `1024`，两者不是同一入口行为。 |
| `temperature` | 已列入 API Endpoint | 可选数字；默认 `1`，范围 `0–2`。 |
| `stream` | 已列入 API Endpoint | 可选布尔值；默认 `false`；`true` 时为 SSE。 |
| `stream_options` | 已列入但未展开 | 官方源码使用 `{ "include_usage": true }`；没有公开更多子字段。 |
| `response_format` | 未列入 API Endpoint | 不能视为全局支持。官方模型信息的 `supports_response_schema` / `supported_openai_params` 表明应按模型判断。 |

来源：[FLock API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)；[官方模型能力类型](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/types/lite-llm.ts#L225-L243)。

## 7. 错误响应

### Direct inference：未形成公开 schema

FLock API Endpoint 页面没有列出 direct inference 的错误对象、`type`、`param`、`code`、request ID 或各状态码示例。因此不能安全假设 `api.flock.io/v1/chat/completions` 总会返回某一种 LiteLLM/OpenAI 错误结构。

客户端最低限度应把以下信息分开处理：

- HTTP status；
- `Content-Type`；
- 可选、非权威的 JSON body；
- 经过脱敏的请求指纹；
- model、stream、步骤编号；
- 不记录 API key，也不默认持久化完整 Provider body。

上述为接入建议，不是 FLock 官方错误 schema。

### Platform Management / proxy：官方格式

FLock 官方 Agent 文档给出的管理层错误格式为：

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_CODE"
}
```

公开错误码包括 `UNAUTHORIZED`、`FORBIDDEN`、`VALIDATION_ERROR`、`NOT_FOUND`、`QUOTA_EXCEEDED`、`TEAM_BLOCKED`、`SERVER_ERROR`、`DB_TIMEOUT`。[官方错误格式](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/SKILL.md#L296-L318)

官方聊天代理还把上游状态映射为：401 → `UNAUTHORIZED`、403 → `FORBIDDEN`、404 → `NOT_FOUND`、409 → `CONFLICT`、429 → `QUOTA_EXCEEDED`、其他 4xx → `VALIDATION_ERROR`、其余 → `SERVER_ERROR`。[官方映射源码](https://github.com/FLock-io/model-api-platform/blob/793621cf1f4f03d30d33c73971f6ed107f14f772/src/app/api/lite-llm/messages/route.ts#L14-L21)

该映射发生在 `platform.flock.io/api/lite-llm/messages` 代理层，不能证明 direct inference 会返回同样的 body。

## 8. 对 Botanic Agent 的接入裁决

### 可以直接依赖

1. Base URL：`https://api.flock.io/v1`。
2. 入口：`POST /chat/completions`。
3. 推理认证：`x-litellm-api-key`。
4. 基本文本消息：`system` / `user` + 字符串 `content`。
5. `stream: true` 使用 SSE；文本增量按 `data:` JSON 与 `[DONE]` 处理。
6. `max_tokens`、`temperature` 可按官方页面发送。

### 不能当成已验证能力

1. `Authorization: Bearer <FLock API key>` 对 direct inference 可用；
2. `GET /v1/models` 是 FLock 当前公开承诺的模型发现接口；
3. 所有模型都支持 `tools`、`tool_choice`、并行工具或结构化输出；
4. `assistant.content: null` 与省略 `content` 等价；
5. `tool.name` 必须存在或必须省略；
6. 第二轮必须或无需重复 `tools`；
7. SSE 工具增量与 OpenAI 的分片规则完全一致；
8. direct inference 错误体与 FLock Platform proxy 错误体一致。

### 最小落地建议

- Direct inference 固定发送 `x-litellm-api-key`；不要用管理 JWT 替代。
- 不通过官方 `/api/lite-llm/messages` 代理运行工具循环，因为该代理会丢弃 `tools` 等字段。
- 从模型信息中读取或维护 `supports_function_calling`、`supports_tool_choice`、`supports_response_schema`；缺失时按“不支持”处理。
- 工具首轮、非流式工具响应、第二轮续接、流式工具响应应拆成独立兼容性门槛；一个模型通过普通文本并不证明它通过工具续接。
- 在 FLock 补充官方 schema 或授权真实验证前，第二轮失败应归类为“Provider tool-continuation compatibility”，不能笼统归因于模型能力不足。

## 9. 不确定项清单

| 不确定项 | 影响 |
| --- | --- |
| `GET https://api.flock.io/v1/models` 的公开支持、认证与响应 schema | 无法仅靠官方资料建立账号级模型发现契约。 |
| Direct inference 是否兼容 `Authorization: Bearer <API key>` | OpenAI SDK 接入可能因认证头差异出现 401。 |
| `assistant.content` 在 `tool_calls` 场景应为 `null` 还是省略 | 可能导致第二轮 400/422。 |
| `tool` 消息是否接受/要求 `name` | 可能导致第二轮 schema 校验失败。 |
| 第二轮是否必须重复 `tools` / `tool_choice` | 可能改变模型续接行为或触发校验失败。 |
| `tool_choice` 的支持值和指定函数对象格式 | 不能安全启用 required/forced tool。 |
| `parallel_tool_calls` 与多个 `tool_call_id` 的排序要求 | 多工具 Agent 语义未确认。 |
| 流式 `delta.tool_calls` 的分片格式 | 无法写出经 FLock 官方证明的增量解析器。 |
| `response_format` 的 `json_object` / `json_schema` wire schema | 结构化输出只能按模型能力试验，不能全局开启。 |
| Direct inference 错误 JSON、request ID 与错误码 | 当前统一错误文案会丢失定位依据。 |
| 各模型路由对 OpenAI schema 的收紧或转换差异 | 普通文本成功不代表工具续接成功。 |

## 10. 2026-09-04 账号级现场实测

以下结果来自当前本地 FLock API 配置和 Botanic Agent 当前项目的真实请求；只记录状态、耗时和安全摘要，不记录 API key、原始图片或完整 Provider body。

| 探针 | 结果 |
| --- | --- |
| `GET https://api.flock.io/v1/models`，`x-litellm-api-key` | HTTP 200，约 6.43 秒；返回目录明确包含 `deepseek-v4-flash-vision-exp` |
| 最小 vision 请求，1×1 PNG，`max_tokens=256` | HTTP 200，首字节约 4.27 秒，`finish_reason=stop`，返回“看到了图片” |
| 使用 Botanic Provider transport 的同一最小请求 | HTTP 200，约 3.18 秒；现有 `Authorization` 与 `x-litellm-api-key` 组合可达 |
| 当前 Agent 首轮真实请求：17 条消息、约 2.22 MB data URL、8 个工具、`max_tokens=3000` | 本地 55 秒护栏触发 `PROVIDER_TIMEOUT`；没有拿到上游 HTTP body |
| 同一请求移除工具、仍使用原始 PNG、`max_tokens=256` | 仍在约 55 秒超时，排除工具 schema 和输出预算为主因 |
| 同一历史和系统提示，图片替换为 1×1 PNG | HTTP 200，约 6.3 秒 |
| 同一历史，图片改为约 277 KB JPEG，保留 8 个工具、`max_tokens=256` | HTTP 200，约 20.4 秒 |

当前图片是 `960×1280` PNG，二进制约 `1.66 MB`，以内联 data URL 进入请求后约 `2.22 MB`。因此本次失败的结论是：模型和服务端基础网络均可用；大尺寸 PNG 的 vision 预处理/请求路径在 FLock 侧或网关侧超过 Botanic 的 55 秒预算。由于客户端主动 abort，`PROVIDER_TIMEOUT` 是 Botanic 的本地分类，不等价于 FLock 返回了 HTTP 504。

最小修复方向是只在服务端发送给 vision Provider 前压缩/转码图片，保留画布原图不变；当前实测约 277 KB JPEG 可通过，建议把最终 Provider data URL 控制在 512 KB 级别并记录安全的图片字节数、模型和耗时指标。仅提高超时不能解决大 PNG 的请求路径问题。

## 官方来源索引

1. [FLock Docs — API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)
2. [FLock Docs — API Endpoint Markdown](https://docs.flock.io/flock-products/api-platform/api-endpoint.md)
3. [FLock Docs — Getting Started](https://docs.flock.io/flock-products/api-platform/getting-started)
4. [FLock API Platform — Agent & CLI Access](https://platform.flock.io/agents)
5. [FLock API Platform — Public Models API](https://platform.flock.io/api/models)
6. [FLock 官方 GitHub — model-api-platform](https://github.com/FLock-io/model-api-platform)
7. [本次核对的官方源码提交 `793621c`](https://github.com/FLock-io/model-api-platform/tree/793621cf1f4f03d30d33c73971f6ed107f14f772)
8. [FLock 官方 npm CLI — `@flock-io/api`](https://www.npmjs.com/package/@flock-io/api)

## 研究限制

- 公开契约核查阶段没有调用 `api.flock.io` 或任何推理/付费 Provider 入口；本节新增的现场实测使用了当前本地配置的 key，但报告不记录其值。
- 现场实测代表当前账号、当前网络出口和当前 Provider 路由；生产环境若使用不同 key、代理或区域出口，需要独立复测。
- 没有用 LiteLLM、OpenAI 或第三方实现文档补齐 FLock 的空白；候选 JSON 仅用于标明“OpenAI-compatible”仍待 FLock 确认的字段。
- 结论代表 2026-09-04 的公开资料状态；模型能力、路由和文档可能变化。
