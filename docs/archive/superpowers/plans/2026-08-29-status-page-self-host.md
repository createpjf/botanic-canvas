# 自建状态页数据源 Implementation Plan

> **For agentic workers:** 按任务实现。本轮由同一会话直接做完，不另开子代理。

**Goal:** `/status` 改为读同源 `/status.json`，由 Vercel 采集样本 + 仓库事故文件生成快照，不再用 Better Stack。

**Architecture:** 领域层 `mapSelfHostedStatusSnapshot` 是权威。Vercel Function 写 Blob、读快照。浏览器只拉 JSON。Railway rewrite 排除这两条路径。

**Tech Stack:** 现有 SPA、`node:test`、Playwright、`@vercel/blob`（仅 Function）。

## Global Constraints

- 状态读写不走 Railway。缺测不补绿。产品内不发事故。测试不打真实 Blob / 生产探针。

---

## 文件

| 文件 | 职责 |
| --- | --- |
| `src/domain/statusPage.ts` | 自建映射、剪枝；去掉 Better Stack mapper |
| `src/lib/statusPage.ts` | 默认 `/status.json`，快照透传 |
| `src/lib/statusPageRuntime.ts` | 探活与样本合并（Function 与测试共用） |
| `api/status-collect.ts` | POST 鉴权写 Blob |
| `api/status-snapshot.ts` | GET 公开快照 |
| `src/data/statusIncidents.json` | 手工事故 |
| `vercel.json` | rewrite / cron |
| `.github/workflows/status-collect.yml` | Hobby 兜底 |

任务：领域测试 → 映射 → lib → runtime → Functions → 路由/文档/E2E。
