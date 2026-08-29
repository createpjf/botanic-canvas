# Botanic 系统状态页

> 设计规格。本轮只定方案，不改运行时代码。

**Goal:** 产品内公开路由 `/status` 展示 Botanic 系统状态，信息结构对齐 [Railway Status](https://status.railway.com/)，时间窗只做 **24 小时** 与 **30 天**。Landing 顶栏给出入口。数据来自 Better Stack 公开 JSON，不经过 Railway。

**Architecture:** 浏览器直拉 Better Stack `index.json`。领域层收成产品快照；UI 只渲染快照。`/api/health` 只给 Better Stack 当探针目标，不给前端画状态页。

**Tech Stack:** 现有 SPA 壳 `src/App.tsx`、Landing `src/components/ProductLanding.tsx`、i18n `{ 'zh-CN', en }`、Vercel `connect-src`。新模块：`src/domain/statusPage.ts`、`src/lib/statusPage.ts`、`src/features/status/`。

## Global Constraints

- 不改变幂等键、任务恢复、项目版本冲突、媒体授权、Artifact 级联删除。
- 不把 `/api/health` 的配置倾倒（模型、持久化、队列、灰度）暴露给状态页。
- `src/components/` 不直接访问 Store、网络或服务端。Landing 只加链接。
- 普通开发测试不得调用真实 Better Stack；用夹具 JSON 与注入的 `fetchImpl`。
- 只报有广泛影响的事故。单次生成失败、单租户问题不上页。
- 产品里不做事故发布台。发布与订阅留在 Better Stack。

## 已定决策

| 项 | 决定 |
| --- | --- |
| 入口 | pathname `/status`（不是 `#/status`），未登录可开 |
| Landing 导航 | 「产品能力 / 工作方式」旁加「状态」 |
| 工作台导航 | v1 不做。这页给进不了工作台的人看 |
| 供应商 | Better Stack。不用 Instatus（公开 API 没有日历史） |
| 读路径 | 浏览器 → Better Stack 公开 JSON。不经过 Railway，v1 不缓存 |
| 30 天条 | 以 `fetchedAt` 的 UTC 日历日为终点，固定 30 个历日。有 `status_history` 用官方状态；没有记录的日子标 `unknown`，不补绿 |
| 24 小时条 | 公开 API 没有小时桶。用事故/维护时段与小时桶相交着色 |
| 组件名 | 跟 Better Stack `public_name` 与排序走，代码不写死中文对照表 |
| 文案 | 只翻译总状态、说明、空态、导航；组件名第一版用供应商名称 |

## 现状（不要重做）

| 能力 | 现在在哪 | 现状 |
| --- | --- | --- |
| Landing | `src/components/ProductLanding.tsx` | 顶栏只有产品能力、工作方式、语言、登录。无页脚 |
| 应用路由 | `src/App.tsx` | 无 pathname 路由。工作台走 hash（`#/projects`、`#/canvas/...`） |
| 健康检查 | `server/httpServer.mjs` `GET /api/health` | 进程存活 + 配置回显。不检查 Postgres / Redis / Worker / Provider。恒 200 |
| 前端代理 | `vercel.json` | `/api/*` 转到 Railway；其余 rewrite 到 `index.html`。`/status` 已能出 SPA |
| CSP | `vercel.json` `connect-src` | 仅 `self`、Supabase、Railway。未放行 Better Stack |
| 发布门闩 | `src/lib/releaseGate.ts` | 与状态页无关。`/status` 仍走现有 `ProductAppFrame` |

不要新建 `/api/status`，不要把状态页挂在 Railway 上，不要 iframe Better Stack 托管页。

---

## 1. 路由与入口

`window.location.pathname` 去掉尾部 `/` 后等于 `/status` 时，`App.tsx` 渲染状态页，**不进入** landing / 登录恢复 / 工作台状态机。

- 查询串、hash 不影响判定。`/status#/projects` 仍是状态页，不打开工作台。
- 状态页顶栏：「状态」为当前页；品牌回 `/`；语言切换复用现有组件；「登录工作台 / 进入工作台」与 Landing 同一回调。登录浮层打开时保持 pathname `/status`。
- 鉴权回调清理不得把 `/status` 改成 `/`。
- 本地未配供应商 URL：仍渲染 `/status`，进入「未接入」态，不发请求。

---

## 2. 页面结构

视觉跟 Landing 同一套（纸色、细线、现有字号），不引入新动效库。

从上到下：

1. **总状态**：色点 + 一句。取值：全部正常 / 部分异常 / 严重中断 / 维护中 / 无法探测 / 状态页未接入。
2. **说明**（固定）：只报有广泛影响的事故；小范围或个别项目问题不在这里。
3. **组件列表**：每行 = 名称、当前态、24 格、30 格、24 小时 uptime%、30 天 uptime%。无分组标题。
4. **事故**：`ends_at == null` 置顶，其下按 `starts_at` 新到旧。最多 20 条（夹具与真实 payload 都截断）。无事故时写「近期没有公开事故」。每条展示标题、级别、开始、恢复或「进行中」、按时间排序的更新正文。
5. **页脚**：数据更新时间（Better Stack `data.attributes.updated_at`，没有则用拉取时刻）。「订阅通知」外链到订阅 URL，`rel="noreferrer"`，在新标签打开。

格子：

- 24 小时：24 个等宽格，覆盖 `[fetchedAt - 24h, fetchedAt)`，从旧到新。
- 30 天：固定 30 格，从旧到新。无记录的日子是 `unknown`，不是绿。
- Hover / 可聚焦：时间范围 + 状态名；有事故则加标题；日格若 `downtime_duration > 0` 加宕机时长。颜色不单独承担信息，`aria-label` 必须可读。
- 日格按 Better Stack 的 `day`（`YYYY-MM-DD`）原样使用，不换时区重算。小时格按 `fetchedAt` 的 UTC 切桶；展示标签用浏览器本地时区。

空与失败：

| 条件 | 总状态 | 组件 / 事故 |
| --- | --- | --- |
| 未配置 JSON URL | 状态页未接入 | 不画假组件 |
| 超时（8s）、非 2xx、非 JSON、根形状无效 | 无法探测 | 不画假组件，不沿用旧数字 |
| 配置了且映射成功 | 见 §4 | 按快照渲染 |

---

## 3. 配置与 CSP

| 变量 | 用途 |
| --- | --- |
| `VITE_STATUS_PAGE_JSON_URL` | Better Stack 公开 `https://<page>/index.json`。空 = 未接入 |
| `VITE_STATUS_PAGE_SUBSCRIBE_URL` | 可选。空则用 JSON URL 去掉末尾 `/index.json` |

`.env.example` 写明这两项。生产配在 Vercel。不要把 Better Stack API token 放进 `VITE_*`。

`vercel.json` 的 `connect-src` 增加：

- `https://*.betteruptime.com`
- `https://*.betterstack.com`

若状态页用自定义域名，实现时把该 origin 一并写入 CSP，否则浏览器拦请求，页会变成「无法探测」。

---

## 4. 产品词表与映射

权威实现：`src/domain/statusPage.ts`。Better Stack JSON:API 不得漏进 UI。

### 4.1 状态

```ts
type StatusLevel = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown'
```

严重度（取更差、占比）：`outage > degraded > maintenance > unknown > operational`。

供应商字符串先 `trim` 再小写再映射：

| 供应商 | 产品 |
| --- | --- |
| `operational` | `operational` |
| `degraded` | `degraded` |
| `downtime` | `outage` |
| `maintenance` | `maintenance` |
| `not_monitored` | `unknown` |
| 其他 / 缺省 | `unknown` |

总状态文案：

| Level | zh-CN | en |
| --- | --- | --- |
| operational | 全部正常 | All systems operational |
| degraded | 部分异常 | Partial disruption |
| outage | 严重中断 | Major disruption |
| maintenance | 维护中 | Maintenance |
| unknown | 无法探测 | Status unavailable |
| （未配置） | 状态页未接入 | Status page is not connected |

未配置不是 `StatusLevel`，是加载态 `unconfigured`，UI 单独分支。

### 4.2 快照

```ts
type StatusLoadState = 'unconfigured' | 'unavailable' | 'ready'

type StatusHourCell = {
  start: string // ISO
  end: string
  level: StatusLevel
  incidentTitle?: string
}

type StatusDayCell = {
  day: string // YYYY-MM-DD
  level: StatusLevel
  downtimeSeconds: number
  maintenanceSeconds: number
}

type StatusComponent = {
  id: string
  name: string
  level: StatusLevel
  hours24: StatusHourCell[] // 长度 24
  days30: StatusDayCell[]   // ready 时长度 30
  uptime24h: number | null  // 0–100
  uptime30d: number | null
}

type StatusIncidentUpdate = { at: string; body: string }

type StatusIncident = {
  id: string
  title: string
  level: StatusLevel
  startedAt: string
  resolvedAt: string | null
  updates: StatusIncidentUpdate[]
}

type StatusSnapshot = {
  loadState: StatusLoadState
  fetchedAt: string
  updatedAt: string | null
  overall: StatusLevel | null // unconfigured / unavailable 时为 null
  components: StatusComponent[]
  incidents: StatusIncident[]
  subscribeUrl: string | null
}
```

`unconfigured` / `unavailable` 时：`overall == null`，`components` 与 `incidents` 为空。

### 4.3 Better Stack → 快照

输入：公开 `index.json` 根对象 + `fetchedAt` + 订阅 URL。

1. **总状态**  
   映射 `data.attributes.aggregate_state`。缺省则取组件当前态的最差值；没有组件则为 `unknown`。

2. **组件**  
   `included` 里 `type === 'status_page_resource'`。  
   排序：先按所属 section 在 `relationships.sections.data` 中的顺序，再按 `attributes.position` 升序，再按 `id`。  
   `name` = `public_name`（空则回退 `id`）。  
   当前态 = 映射 `attributes.status`。  
   **不要**用供应商的 `availability`（那是他们页面上的长窗，不是 30 天）。

3. **30 天格**  
   窗口：`fetchedAt` 的 UTC 日历日往前共 30 个历日（含当天），从旧到新，长度恒为 30。  
   将 `status_history` 按 `day` 去重（后者覆盖前者）做成查找表。  
   窗口内有记录：用官方 `status` / `downtime_duration` / `maintenance_duration`。  
   窗口内无记录：`level = unknown`，秒数为 0。  
   `uptime30d`：只把**有记录**的日子计入。  
   `uptime = 1 - sum(downtime_duration) / (有记录天数 * 86400)`，夹在 0–100。`maintenance_duration` 不计入宕机。有记录天数为 0 则 `null`。

4. **事故**  
   `included` 里 `type === 'status_report'`。  
   `title`、`starts_at`、`ends_at`、`report_type`、`aggregate_state`、`affected_resources`。  
   级别：先映射 `aggregate_state`；若仍是 `unknown` 且 `report_type === 'maintenance'`，则为 `maintenance`。  
   进行中：`ends_at` 为空。  
   更新：`relationships.status_updates` 对应的 `status_update`，按 `published_at` 升序；`body` = `message`。  
   列表：进行中在前，其余按 `starts_at` 降序，截 20 条。

5. **24 小时格（按组件）**  
   24 个桶：`[fetchedAt - 24h + i*1h, fetchedAt - 24h + (i+1)*1h)`，`i = 0..23`。  
   默认 `operational`。  
   一条事故若与桶相交，则把该事故的级别涂到**受影响组件**上；多条取更差。`incidentTitle` 取该桶内最差那条的标题。  
   受影响组件：`affected_resources[].status_page_resource_id`。数组缺或空 = 页级事故，涂全部组件。  
   进行中事故的区间右端用 `fetchedAt`。

6. **24 小时 uptime**  
   在 `[fetchedAt - 24h, fetchedAt)` 上，对该组件所有 `outage` / `degraded` 事故区间做并集（分钟，向下取整到分钟）。维护不扣。  
   `uptime24h = 1 - downMinutes / 1440`，夹在 0–100。无此类事故则为 100，不是 `null`。

7. **订阅 URL**  
   配置的 subscribe URL；否则 JSON URL 去掉末尾 `/index.json`。两者都空则为 `null`，页脚不渲染订阅链接。

映射函数必须是纯函数：`(payload, fetchedAt, subscribeUrl) → StatusSnapshot`。非法根对象返回 `loadState: 'unavailable'`，不抛给 UI。

---

## 5. 模块与依赖

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 领域 | `src/domain/statusPage.ts` | 词表、映射、uptime、小时相交、事故排序 |
| 领域测试 | `src/domain/statusPage.test.ts` | 夹具 JSON，不发网 |
| 浏览器 I/O | `src/lib/statusPage.ts` | 读 env、8s 超时、`fetchImpl` 可注入、把结果交给领域映射 |
| 页面 | `src/features/status/StatusWorkspace.tsx` | 拉数、中英文案、结构 |
| 入口 | `src/App.tsx` | pathname 门闩 |
| Landing | `src/components/ProductLanding.tsx` | 导航链接 |
| 样式 | `src/styles.css` | `.product-status` 前缀，跟 Landing 同一视觉变量 |
| 配置 | `.env.example`、`vercel.json` | URL 与 CSP |
| 地图 | `docs/CODEMAP.md` | 实现时补一行 |

`src/lib/statusPage.ts` 允许依赖 `domain` 与 `fetch`。`features/status` 可以依赖 `lib` 与 `domain`。禁止 `components` 拉 JSON。禁止 `server/` 新增状态页路由。

---

## 6. Better Stack 运营（代码外）

实现不创建供应商账号。上线前人工完成：

1. 建 Status Page，打开公开 JSON。
2. 资源建议（名称可改，排序即页上顺序）：
   - 工作台 — 探生产 Web `GET /`（不要探 `/status`，避免自指）
   - API — 探 Railway `GET /api/health`，200 即存活
   - 登录 — 探 Supabase Auth health
   - 生成 / Agent / 媒体 — 能 HTTP 或心跳就探；探不准则手动资源，只靠人工事故
3. 事故只在对方控制台发，只报广泛影响。
4. 托管页可留作邮件订阅目标。主入口永远是产品 `/status`。

`/api/health` 恒 200 只表示 API 进程在。不要把它解释成生成管道可用。

---

## 7. 测试

领域层必须覆盖：

- `aggregate_state` 与资源 `status` 的大小写与 `downtime → outage`
- 30 个历日窗口、缺日为 unknown、维护秒数不扣 30 天 uptime
- 跨小时、跨 `fetchedAt` 的进行中事故
- `affected_resources` 只涂对应组件；空数组涂全部
- 重叠事故取并集分钟，不双计
- 维护相交上色但不扣 24 小时 uptime
- 非法 payload / 缺 `data` → `unavailable`
- 事故列表进行中置顶、截 20

`src/lib/statusPage.ts`：未配置不发请求；超时与非 2xx → `unavailable`。

E2E：打开 `/status`，标题可见。用 `page.route` 喂夹具，不打真供应商。Landing 导航能到 `/status`。

`npm run check:architecture`：`src/components/` 不新增对 `src/lib/statusPage` 的导入。

---

## 8. 明确不做

- 工作台内入口、Landing 上的实时状态点
- 90 天条、月度分组、自建探针历史、Vercel KV 缓存
- Better Stack 私钥、SLA 管理 API、小时级探针桶
- 产品内发事故、邮件订阅实现
- 新的 Railway `/api/status`
- iframe / 官方 widget
- 把 Redis、Postgres、Worker 内部名暴露给用户
- 用「生成任务失败」自动标红整站
