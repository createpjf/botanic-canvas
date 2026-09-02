# Botanic 系统状态页（自建数据源）

> 替换 [原规格](2026-08-29-status-page-design.md) 的 Better Stack 读路径。`/status` 路由、Landing 入口、`StatusSnapshot` 与格子 UI 保留。

**Goal:** `/status` 继续画 24 小时 / 30 天 / uptime / 事故，数据改由 **Vercel 上的独立采集** 提供，不经过 Railway，也不再用 Better Stack。

**Architecture:** Vercel Function 定时探活，样本写入 Vercel Blob。浏览器只拉同源 `/status.json`。领域层把「样本 + 仓库事故文件」收成现有 `StatusSnapshot`。UI 只渲染快照。

**Tech Stack:** 现有 SPA 与 `src/domain/statusPage.ts` 词表；新增 Vercel Functions（不进 Railway 反代）；Vercel Blob 存样本；`@vercel/blob` 只出现在 Function 里，不进前端包。

## Global Constraints

- 不改变幂等键、任务恢复、项目版本冲突、媒体授权、Artifact 级联删除。
- 不把 `/api/health` 的配置倾倒暴露给状态页。
- 状态读写不得走 Railway。`vercel.json` 里 `/api/:path*` → Railway 的 rewrite **必须排除** 采集与快照路径。
- `src/components/` 不访问网络或 Blob。
- 普通开发测试不打真实生产 URL、不写真实 Blob；夹具 + 注入 `fetchImpl`。
- 只报有广泛影响的事故。产品里不做事故发布台。
- 缺测的日子和小时标 `unknown`，不补绿。
- `/api/health` 仍只表示 API 进程在，200 不当成生成管道可用。

## 已定决策

| 项 | 决定 |
| --- | --- |
| 供应商 | 不用 Better Stack / Instatus / 自建 Uptime Kuma |
| 读路径 | 浏览器 → 同源 `GET /status.json`（Vercel Function 读 Blob + 事故文件） |
| 写路径 | `POST /status-collect`，校验 `CRON_SECRET`，探活后追加样本 |
| 历史存储 | Vercel Blob 一份 JSON，只存样本；覆盖写。并发丢失单次样本可接受 |
| 事故 | 仓库 `src/data/statusIncidents.json`，改文件并部署即生效 |
| 订阅 | v1 不做。页脚只显示更新时间 |
| 组件 | 稳定 id：`web`（工作台）、`api`（API）、`auth`（登录，未配探针 URL 则整项不出现） |
| 探针间隔 | 15 分钟。Hobby 上 Vercel Cron 可能做不到时，用 GitHub Actions 打同一个 collect URL |
| 未配置 | 生产默认就有 `/status.json`，不再依赖 `VITE_STATUS_PAGE_JSON_URL`。显式传入 `jsonUrl: null` 才是未接入（测试用） |
| 默认 fetch | `VITE_STATUS_PAGE_JSON_URL` 未设时用 `/status.json` |

原规格里「本地未配 URL → 未接入」只留给测试。生产打开 `/status` 应看到组件行，历史从第一次采集开始攒。

---

## 1. 数据流

```text
Cron / GitHub Action
  → POST /status-collect  (Authorization: Bearer CRON_SECRET)
  → 并行探 web / api / [auth]
  → 读 Blob 旧样本 → 追加本拍 → 丢掉 30 天以外 → 写回 Blob

浏览器
  → GET /status.json
  → Function 读 Blob 样本 + 仓库事故文件
  → mapSelfHostedStatusSnapshot(...)
  → StatusSnapshot
  → StatusWorkspace（现有 UI）
```

探活失败或超时记为该组件 `outage`，成功为 `operational`。探针本身不分 `degraded`；`degraded` / `maintenance` 只来自事故文件。

不要探 `/status` 或 `/status.json`（自指）。

## 2. 样本与事故形状

Blob（`status-samples.json`，`addRandomSuffix: false`）：

```ts
type StatusSampleFile = {
  version: 1
  updatedAt: string // ISO
  samples: StatusSample[] // 按 at 升序，只留 fetchedAt 起算 30 个 UTC 历日以内
}

type StatusSample = {
  at: string
  checks: Record<'web' | 'api' | 'auth', 'operational' | 'outage'>
}
```

`auth` 未配置探针时，该 key 不写。

事故文件（`src/data/statusIncidents.json`）：

```ts
type StatusIncidentRecord = {
  id: string
  title: string
  level: StatusLevel // operational 不允许
  startedAt: string
  resolvedAt: string | null
  affected: Array<'web' | 'api' | 'auth'> // 空 = 页级，涂全部出现的组件
  updates: Array<{ at: string; body: string }>
}
```

非法行在映射时丢掉，不让整页变 `unavailable`。列表规则沿用：进行中置顶，其余按 `startedAt` 新到旧，截 20 条。

## 3. 映射（替换 Better Stack JSON:API）

权威函数：`mapSelfHostedStatusSnapshot(samples, incidents, fetchedAt) → StatusSnapshot`。纯函数。删掉或停用 `mapStatusSnapshot` 对 Better Stack 根对象的依赖；夹具改成自建形状。

组件当前态 = 该 id **最后一条样本** 的 check；没有样本则为 `unknown`。

总状态 = 出现的组件当前态取更差；没有任何样本则为 `unknown`。

**30 天格：** `fetchedAt` 的 UTC 日往前共 30 个历日。某日有样本：有任一次 `outage` 则当天 `outage`，否则 `operational`；`downtimeSeconds` = 当天 outage 样本数 × 采集间隔秒数（900）。无样本的日子 = `unknown`、秒数 0。`uptime30d` 只计入有样本的日子；有样本天数为 0 则为 `null`。事故的 `maintenance` 不计入 30 天宕机秒数。

**24 小时格：** 24 个小时桶。桶内无样本且无相交事故 → `unknown`（不默认绿）。桶内有样本：有 outage 样本则为 `outage`，否则 `operational`，再与相交事故取更差。`incidentTitle` 取该桶最差事故标题。

**24 小时 uptime：** 窗口内 outage 样本数 × 900 秒，换成分钟后 `/ 1440`。窗口内完全无样本则为 `null`，不是 100。事故的 degraded/outage 区间仍按原 `mergeDownMinutes` 并入，与样本宕机取较大值，避免只写了事故、采集还是绿时 uptime 虚高。

`loadState`：Blob 读失败或样本文件 `version` 非法 → `unavailable`，不画假组件。样本为空仍是 `ready`，组件行在，格子为 unknown。

## 4. Vercel Functions 与路由

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/status-collect` | POST | 鉴权、探活、写 Blob |
| `/status.json` | GET | 读 Blob + 事故文件，返回 `StatusSnapshot` 或 `unavailable` 空快照 |

实现放在仓库根 `api/`（Vercel filesystem）。`vercel.json`：

1. Railway rewrite 排除 `api/status-collect` 与 `api/status-snapshot`（或等价文件名）。
2. `/status.json` rewrite 到 snapshot Function。
3. `/status-collect` rewrite 到 collect Function。
4. `crons`: Hobby 不能低于一天一次，仓库里写成每天一次兜底；15 分钟探活以 GitHub Action 打同一个 collect URL 为准。Function 仍要能被 Action 调用。

Collect 必须校验 `Authorization: Bearer $CRON_SECRET`（或 Vercel Cron 同款头），错了 401。GET `/status.json` 公开，**不得探活**（防刷）。

`Cache-Control: no-store` 已在 catch-all headers 上。

CSP：同源拉 `/status.json`，不必再为 Better Stack 加域名。实现时不要为 Blob 公共域名开 `connect-src`——浏览器不直连 Blob。

## 5. 环境变量

| 变量 | 范围 | 用途 |
| --- | --- | --- |
| `CRON_SECRET` | Vercel / GitHub Action | 采集鉴权 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Function | Blob |
| `STATUS_PROBE_WEB_URL` | Function | 默认生产 Web 源站 `/`，不要探 `/status` |
| `STATUS_PROBE_API_URL` | Function | 默认 Railway `GET /api/health` |
| `STATUS_PROBE_AUTH_URL` | Function | 可选。空则不出现 `auth` 组件 |
| `VITE_STATUS_PAGE_JSON_URL` | 前端 | 可选覆盖。未设 = `/status.json` |

不要把 Blob token 或 `CRON_SECRET` 放进 `VITE_*`。

`.env.example` 写明上述项。生产配在 Vercel。

## 6. 页面与文案

`StatusWorkspace` 继续只吃 `StatusSnapshot`。组件显示名按 id 翻译（工作台 / API / 登录），不要把 id 直接给用户。

「状态页未接入」保留给 `loadState === 'unconfigured'`（测试或显式关闭）。生产默认不再走这支。

页脚：数据更新时间用 Blob `updatedAt`，没有则用 `fetchedAt`。无订阅链接。

说明句不变：只列出有广泛影响的事故。

## 7. 本地与测试

- 领域测试：自建夹具覆盖映射规则（缺日 unknown、小时无样本 unknown、空样本 ready、事故涂组件、uptime null、截 20 条）。
- `src/lib/statusPage.ts`：默认 URL 是 `/status.json`；`jsonUrl: null` 不发请求；超时 / 非 2xx / 非法 JSON → `unavailable`。
- Function 探活与 Blob：用注入的 `fetchImpl` / Blob 替身，不打生产。
- E2E：继续 `page.route` 喂 `/status.json` 夹具。Landing 仍能进 `/status`。
- `npm run check:architecture`：`src/components/` 不得新增对 `src/lib/statusPage` 或 `api/` 的导入。

本地 `npm run dev` 没有 Function 时，`/status.json` 会 404，页为「无法探测」。这是预期，不在 Vite 里伪造绿条。

## 8. 明确不做

- Better Stack / Instatus / Uptime Kuma
- 新的 Railway `/api/status`
- 产品内发事故、邮件订阅
- 浏览器直连 Blob
- 用生成任务失败自动标红
- 把 Redis、Postgres、Worker 内部名暴露给用户
- 90 天条、自建多地区探针
- 在 `server/` 为状态页加路由（会进 Railway）

## 9. 迁移

接上后可以删 `VITE_STATUS_PAGE_SUBSCRIBE_URL` 与 Better Stack 夹具。CSP 里的 `betteruptime` / `betterstack` 可一并去掉。历史从第一次成功采集起算，不回填接上之前的 30 天。
