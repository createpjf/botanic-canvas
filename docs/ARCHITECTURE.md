# Botanic 模块接口与依赖方向

这份说明记录当前代码中的稳定 seam。目标不是把工程拆成更多目录，而是让复杂行为集中在少量深模块中，使 UI 改动不会直接改变生图、队列或存储语义。

## 模块与允许依赖

```text
UI（App / components）
        ↓
画布应用模块（store）
        ↓
领域契约（domain） ← 网络与本地持久化接口（lib）
                               ↓
                         同源 Node API
                               ↓
         任务队列 → 生成处理器 → Provider / Media / ProductStore Adapter
```

| 模块 | 主要位置 | 对外接口 | 允许依赖 |
| --- | --- | --- | --- |
| UI | `src/App.tsx`、`src/components/` | 用户事件与渲染属性 | 画布应用模块、领域契约；应用外壳可调用 `lib` 的高层接口 |
| 画布应用模块 | `src/store/` | 画布命令、状态与任务生命周期 | `domain`、`lib`、种子数据 |
| 领域契约 | `src/domain/` | 画布数据、生成结果放置等纯规则 | 类型依赖与纯计算，不依赖 UI、Store、网络或存储 |
| 浏览器基础设施 | `src/lib/` | 会话、生成请求、项目文档与离线草稿接口 | `domain`、浏览器/网络 Adapter，不依赖 UI 或 Store |
| Node API | `server/index.mjs` | 鉴权后的 HTTP 接口 | 队列、处理器、运行时组合根 |
| 生成处理器 | `server/generationProcessor.mjs` | `processGenerationJob(jobId)` | 注入的 ProductStore、Media 与 Provider |
| Adapter | `server/*Store.mjs`、`server/objectStore.mjs` 等 | 产品存储、媒体、队列、第三方图像能力 | 各自外部系统；由 `server/runtime.mjs` 选择并组装 |

模型能力由 `server/generationModels.mjs` 统一声明，Worker 只能经
`server/generationService.mjs` 路由到 OpenAI、MiniMax Image 或 MiniMax H3。
所有供应商输出都先转成 `{ mediaKind, mimeType, buffer }`，再由媒体服务持久化；
H3 的 MP4 与历史图片共用授权 URL，但历史缺少 `mediaKind` 时始终按图片兼容读取。

`src/components/` 是纯 UI 模块，不得直接导入 `src/lib/`、`src/store/` 或 `server/`。`src/App.tsx` 是当前应用组合外壳，可以把 Store 与高层浏览器接口组合后通过属性传给 UI。

## 受保护的稳定接口

以下行为必须通过接口兼容和测试保护，不能由 UI 改动顺带改变：

- 同一重试复用同一幂等键，服务端按用户与幂等键去重。
- 任务状态由持久化任务记录决定；UI 占位状态不是权威来源。
- 一次任务的每个输出都有任务内唯一身份，并成为独立结果节点。
- 已有 `candidateId` 但尚无图片的节点必须原位补图，不能被误判为已展示。
- 远端成功输出可以纠正本地空节点或旧失败状态。
- 本地草稿不能覆盖更新的远端任务结果；合并任务结果时保留当前画布布局。
- 媒体通过稳定的同源引用进入画布，组件不接触对象存储凭据。

## 自动护栏

`npm test` 会同时执行：

- 服务端生成、幂等、媒体、存储和历史结果回填测试；
- `src/domain/` 的纯领域契约测试；
- 当前源码的依赖方向检查。

也可单独执行：

```bash
npm run check:architecture
```

检查会拒绝：

- 任意前端源码导入 `server/`；
- UI 组件直接导入网络、存储或 Store；
- `domain` 反向导入 UI、Store、种子数据或基础设施；
- `lib` 反向导入 UI 或 Store；
- Store 反向导入 UI。

## 变更准则

1. 先确定需求归属的模块，只修改拥有该行为的实现。
2. 跨 seam 时先固定或扩展稳定接口，再修改两侧 Adapter。
3. UI 需求使用 Fake/Mock 数据验证，不调用真实图像 Provider。
4. 生图或存储变更必须增加对应接口测试，并覆盖已有项目和历史任务。
5. 生产数据清理、数据库重置和真实生图验证需要单独授权。
