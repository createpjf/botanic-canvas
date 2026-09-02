# 生产 API 恢复与真实生成验收

验收日期：2026-08-05（Asia/Shanghai）
服务端 revision：`3f3bee4`（PR #21）

## 事故与修复

- 生产项目错误响应已经写出后，HTTP 组合根仍继续兜底并第二次写响应头，触发 `ERR_HTTP_HEADERS_SENT`，导致 Railway API 进程退出。
- `server/httpServer.mjs` 的错误响应现在明确返回“已处理”结果；真实请求级回归测试会在重复 `writeHead` 时失败。
- PR #21 的 `verify` 与 `ui-e2e` 门禁通过并已合并到 `main`。

## 部署与健康检查

| 服务 | Deployment | Revision / 状态 |
| --- | --- | --- |
| Railway API | `1cc61e91-b152-463b-a2c6-1fbe40e007fe` | `3f3bee4`，SUCCESS / RUNNING |
| Railway Worker | `a68314c7-8b66-47b0-b087-b9d1ec9c0618` | `3f3bee4`，SUCCESS / RUNNING |
| Vercel Production | `dpl_FrmsfQaUjxcH5ckq4ocSrfTdSFQ1` | 前端产物未改变，沿用上一 READY deployment |

- Railway API 已配置健康检查路径 `/api/health`，超时 60 秒。
- Railway 直连 `/api/health` 与 Vercel 同源 `/api/health` 均返回 200。
- 未登录访问 `/api/projects` 返回 401 `AUTH_REQUIRED`。
- API 与 Worker 启动日志正常；Worker 并发为 3。

## 最小真实生成

- 使用已登录生产账号新建临时项目，添加共享品牌素材，并提交 1 个 GPT Image 2、3:4、1K 的图片任务。
- Worker 任务 `job_ayVH_OMs0n0lERkC2BcvYIRHCex8fXLGHMExO_mHTpM` 完成 Provider 调用并返回 1 个输出。
- 浏览器展示独立结果节点；整页刷新后素材、生成节点、配方和结果图片仍在，验证了项目持久化与恢复链路。
- 临时项目验收后已从生产项目库删除，项目数由 10 恢复为 9。

## 验收边界

- 本轮没有重新执行三角色权限矩阵、数据库级 Artifact 数量对账或 15 分钟持续观测；这些仍以 2026-08-04 专项验收为历史证据，不能视为本轮重跑。
- 本轮浏览器证据覆盖可见页面、真实生成与刷新恢复；未单独导出浏览器控制台日志。
