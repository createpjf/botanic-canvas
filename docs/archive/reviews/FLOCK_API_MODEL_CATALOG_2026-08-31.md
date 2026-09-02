# FLock API Platform 模型目录核验（2026-08-31）

## 结论

- FLock 公开目录当前展平后共有 **28 个模型 ID**：23 个 `text`、4 个 `image`、1 个 `video`。这里的类型来自公开 API 字段，不等同于已验证的输出能力。
- Botanic 生产 API Key 调用 `https://api.flock.io/v1/models` 返回 **35 个可见模型 ID**。
- 两个目录交集为 22 个；公开目录代表平台展示，认证后的 `/v1/models` 才代表当前 Key 可见的推理路由。
- 本次只读取模型目录，没有发起图片、视频或其他付费生成。

## 公开目录（canonical 与 child slugs）

来源：[`GET https://platform.flock.io/api/models`](https://platform.flock.io/api/models)

| Provider | 模型 ID |
|---|---|
| DeepSeek | `deepseek-v3.2`, `deepseek-v3.2-dsikh`, `deepseek-v4-flash`, `x c`, `deepseek-v4-pro` |
| Google | `gemini-3-flash-preview`, `gemini-3.1-flash-image-preview`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3.7-flash` |
| Kimi | `kimi-k2-thinking`, `kimi-k2.5`, `kimi-k2.5-llm`, `kimi-k2.6`, `kimi-k3` |
| MiniMax | `minimax-m2.1`, `minimax-m2.5`, `minimax-m2.7` |
| Qwen | `qwen3-235b-a22b-instruct-2507`, `qwen3-235b-a22b-thinking-2507`, `qwen3-235b-a22b-thinking-qwfin`, `qwen3-30b-a3b-instruct-2507`, `qwen3-30b-a3b-instruct-coding`, `qwen3-30b-a3b-instruct-qmini`, `qwen3-30b-a3b-instruct-qmxai` |
| Zai | `glm-5`, `glm-5.3`, `glm-5.3-flash` |

## Botanic 当前 API Key 可见目录

来源：认证读取 [`GET https://api.flock.io/v1/models`](https://api.flock.io/v1/models)。未记录或输出 API Key。

| Family | 模型 ID |
|---|---|
| DeepSeek | `deepseek-v4-flash`, `deepseek-v4-flash-dsikh`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`, `deepseek-v4-pro-dslife`, `deepseek-v4-pro-suck` |
| Gemini | `gemini-3.1-flash-image-preview`, `gemini-3.1-pro-deai`, `gemini-3.1-pro-preview`, `gemini-3.6-flash`, `gemini-3.6-flash-cheap`, `gemini-3.6-flash-flocklife`, `gemini-3.7-flash` |
| GLM | `glm-5`, `glm-5.3`, `glm-5.3-flash` |
| OpenAI | `gpt-image-2` |
| Kimi | `kimi-k2-thinking`, `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.6-llm`, `kimi-k2.6-vc`, `kimi-k3`, `kimi-k3-kimimoto`, `kimi-k3-llm`, `kimi-k3-vc` |
| MiniMax | `minimax-m2.1`, `minimax-m2.5` |
| Qwen | `qwen3-235b-a22b-instruct-2507`, `qwen3-235b-a22b-thinking-2507`, `qwen3-235b-a22b-thinking-qwfin`, `qwen3-30b-a3b-instruct-2507`, `qwen3-30b-a3b-instruct-coding`, `qwen3-30b-a3b-instruct-qmini`, `qwen3-30b-a3b-instruct-qmxai` |

## 目录差异

公开目录有、当前 Key 未返回：

`deepseek-v3.2`, `deepseek-v3.2-dsikh`, `gemini-3-flash-preview`, `gemini-3.5-flash`, `kimi-k2.5-llm`, `minimax-m2.7`

当前 Key 返回、公开目录未列为 canonical/child slug：

`deepseek-v4-flash-dsikh`, `deepseek-v4-pro-dslife`, `deepseek-v4-pro-suck`, `gemini-3.1-pro-deai`, `gemini-3.6-flash`, `gemini-3.6-flash-cheap`, `gemini-3.6-flash-flocklife`, `gpt-image-2`, `kimi-k2.6-llm`, `kimi-k2.6-vc`, `kimi-k3-kimimoto`, `kimi-k3-llm`, `kimi-k3-vc`

这些后缀 ID 更适合视为账号可见的具体路由别名；产品配置优先使用公开 canonical ID，除非已经单独验证别名的能力、价格和稳定性。

## 官方接口说明

- FLock 将推理 API 与平台管理 API 分开：推理基址为 `https://api.flock.io/v1`，平台管理基址为 `https://platform.flock.io/api`。[FLock Agent & CLI Access](https://platform.flock.io/agents)
- 推理接口兼容 OpenAI；官方文档要求通过模型目录确认可用 ID，再调用 `/chat/completions`。[FLock API Endpoint](https://docs.flock.io/flock-products/api-platform/api-endpoint)
- 模型目录会随平台和账号授权变化；部署前应重新读取认证后的 `/v1/models`，不能只依赖写死列表。
