# 直传上传、粘贴与视频素材

> 设计规格。本轮只定方案，不改运行时代码。

**Goal:** 桌面拖拽已存在，本轮补齐两件事：**粘贴**图片/视频进画布与对话框；**上传视频**（100MB+）。为承载视频，客户端上传改为预签名直传对象存储，媒体分发改为签名 URL 直取。

**Architecture:** 客户端上传走三步——服务端铸预签名 PUT URL（**不建库记录**）→ 客户端直传 S3 → commit 端点做 64KB Range GET 验魔数后才建记录。服务端侧的供应商产出仍走 `persistBytes`,分界按**来源**划而非体积。媒体读取补上 S3 的 `createSignedUrl`,让已有的 302 分支在 S3 部署下生效，视频因此获得原生 Range。视频的格式与可播性由**浏览器自己的解码器**判定（`<video>` 加载），不自己解析编码。

**Tech Stack:** 现有 `server/objectStore.mjs`（S3）、`server/mediaService.mjs`、`server/promptMediaRoutes.mjs`、`server/mediaFormats.mjs`（PR-A 建立的权威词表）、`src/lib/uploadedAssets.ts`。新依赖一个：`@aws-sdk/s3-request-presigner`（上传与分发共用）。

## Global Constraints

- **以实际字节为准，不信任客户端声明的类型。** 这是 `mediaService.mjs` 现有规矩，直传架构下唯一的落点是 commit 步骤的 64KB Range GET。放弃它等于开洞。
- **「接受什么」与「交给供应商什么」是两个集合，不得合并。** 沿用 PR-A 建立的 `UPLOAD_*` / `CANONICAL_*` 划分，视频照同一形状新增。
- **预签名 URL 绝不进日志。** 它是凭证等价物；`check:security` 扫密钥模式，抓不到它。
- 服务端是唯一强制边界。客户端校验是快路径与体验，不是信任边界。
- `src/domain/` 不得导入 `server/`（`check:architecture` 强制）。跨边界词表按契约测试模式处理。
- 浏览器原语（`<video>`、`ClipboardEvent`、`DataTransfer`）必须可注入，否则 `src/lib/*.test.ts` 覆盖不到编排逻辑。
- 全量中英双语，`{ 'zh-CN', en }` 形状由 TypeScript 强制。
- 用户上传的原始文件不被静默改动或丢弃；发生拒绝时必须说清它是否仍然可用。
- 不引入 ffmpeg 或任何视频转码依赖。

---

## 现状（不要重做）

| 能力 | 现在在哪 | 现状 |
| --- | --- | --- |
| 桌面拖拽 → 画布 | `useCanvasInteractionCoordinator.ts:207` `onCanvasDrop` → `addDroppedFilesToCanvas(files, position)` | **已实现**，且落在光标位置 |
| 桌面拖拽 → 对话框 | `AgentWorkspace.tsx:867` → `importImageFiles` | **已实现** |
| 桌面拖拽 → 素材库 | `CanvasWorkspacePanels.tsx:489` → `stageFiles` | **已实现** |
| 粘贴 | —— | **完全不存在**，全仓库 `onPaste`/`clipboardData` 零命中 |
| 图片格式词表 | `server/mediaFormats.mjs` + `src/domain/mediaFormats.ts` + `scripts/mediaFormatContract.test.mjs` | PR-A 已建立，含偏移感知的 `ftyp` 匹配 |
| 视频词表 | —— | **不存在**。`uploadedAssets.ts:51` 把 `mediaKind` 写死 `'image'` |
| 视频数据模型 | `GenerationMediaKind = 'image' \| 'video'`；素材库有图片/视频筛选与 `videoAsset` 文案 | **已就绪**，只是传不进来 |
| 视频生成参考 | `generationProvider.mjs` 有 `mediaKind === 'video'` 分支与 `inputRole` 枚举 | **已支持**，但供应商适配器 base64 内联请求体 |
| 客户端上传 | `POST /api/projects/:id/media`，JSON 里的 data URL | base64 膨胀 33%，单文件 8MB、请求体 32MB |
| S3 签名读 URL | `objectStore.mjs` 只导出 `putMedia`/`get`/`close` | **未实现 `createSignedUrl`** |
| 媒体分发 302 分支 | `promptMediaRoutes.mjs:66` | 代码已写好，S3 部署下永远走不到 |
| 媒体流式回传 | `httpServer.mjs:193` `streamMedia` | 整体管道输出，**无 Range/206/Accept-Ranges** |
| 媒体删除 | —— | 不存在；孤儿交由桶生命周期规则 |
| `media_objects` | `postgresProductStore.mjs:322` | 原始 7 列；去重/原图列仍属 PR-B，未落地 |

---

## 问题 1：上传链路

### 三步流程

```
① POST /api/projects/:id/media/upload-url        权限 'edit'，复用 media 限流
   服务端 mediaId → storageKey = projects/{projectId}/{mediaId}
   presigner 签 PUT URL，签名锁死 Content-Type 与 Content-Length 区间
   → { mediaId, uploadUrl, expiresIn }
   不写库

② 客户端 PUT 原始字节到该 URL（不经我们的服务器）

③ POST /api/projects/:id/media/{mediaId}/commit  权限 'edit'
   HEAD 确认对象存在、体积落在签名区间内
   Range GET 前 64KB → detectImageFormat 验魔数与声明类型一致
   通过 → 建 media_objects 记录
```

### 为什么 presign 时不建记录

三种失败模式的结局：客户端没传 → 什么都没留下；传了没 commit → 桶里一个孤儿对象；commit 校验不过 → 同样只是孤儿对象。**没有任何一种会留下悬挂的数据库记录**，而孤儿字节本就由桶生命周期规则处理（`persistBytes` 注释已写明这是既定做法）。

这消掉了直传方案通常要付的中间态代价。

### 伪造 storageKey

commit 时客户端报 mediaId。`storageKey` 形状为 `projects/{projectId}/{mediaId}`,而 commit 走 `requireProjectPermission(projectId, 'edit')`——即便伪造，也只能在自己本就有写权限的项目内提交，且该 key 上的对象只可能来自持有该项目有效预签名 URL 的人。授权落在项目上，位置正确，不需要额外的 HMAC 或短期映射表。

### 分界按来源，不按体积

`persistProviderImage` / `persistProviderMedia`（供应商产出落库）仍走 `persistBytes`——服务端到存储，本就不该绕行。只有**客户端上传**迁到直传。因此不会出现「小文件走这条、大文件走那条」的两套路径。

### 与 PR-B 的顺序

`media_objects` 的去重列与原图列尚未落地，而 PR-B 的客户端归一化产出的正是浏览器里的字节，那些字节也要上传。**本功能排在 PR-B 之前**，PR-B 的 sha256 去重直接落在 commit 步骤：客户端算哈希，服务端 commit 时按 owner 分域查表。否则归一化那边会先按 base64 写一遍，回头再迁一次。

---

## 问题 2：媒体分发

### S3 补 createSignedUrl

`promptMediaRoutes.mjs:62-76` 的 302 分支代码已写好，顺序也对（先 `requireUser` + 归属校验，再铸 URL）。它在 S3 部署下走不到，只因 `mediaService.mjs:165` 的 `typeof objectStore.createSignedUrl !== 'function'` 守卫为真。

给 `server/objectStore.mjs` 补 `createSignedUrl`,用 `@aws-sdk/s3-request-presigner` 复用其已有 S3 client。补上后现有分支自动生效，Supabase 与 S3 两种部署走同一条代码路径。

### TTL 按介质分

规则：**TTL 必须覆盖该资源被使用的时长**。

| 介质 | TTL | 依据 |
| --- | --- | --- |
| 图片 | 600 秒（现有默认） | 取一次就完了 |
| 视频 | 6 小时（具名常量） | `<video>` 跟随 302 后记住解析出的 URL 整个观看会话；拖进度条发出的是对同一 URL 的 Range 请求。过期 → 403 → 播放中途断掉，用户不知道发生了什么 |

代价是视频的泄露窗口更长，这是明知的取舍。

### 授权姿态变化

签名 URL 是**持有即可用的凭证**：会出现在浏览器网络面板、可能被复制、在 TTL 内对任何持有者有效。这与今天 S3 部署的逐请求鉴权不同。缓解只有两条——铸造前已验身份与归属（现有代码已做），以及 TTL。`Cache-Control: private, no-store` 保留，使每次加载重新走鉴权并铸新 URL。

### 不给 streamMedia 补 Range

视频直取 S3 后，Range 由 S3 原生支持。`httpServer.mjs:193` 在配置了对象存储之后只服务本地原型，为它实现 206/多段/条件请求是花错地方的钱。本地无对象存储时的回落路径保留，不删。

---

## 问题 3：视频素材与生成参考

### 格式校验交给浏览器解码器

iPhone 默认录 HEVC 编码的 `.mov`,Chrome 多数构建解不了。只按容器放行会让用户成功上传一个**永远播不出来**的文件——比直接拒绝更糟。

从容器解编码（`stsd` 原子里找 `hvc1`/`avc1`）可行但是易错的字节解析。改用**真正会播它的解码器去验**：客户端建 `<video>`,`src` 指 blob URL,等 `loadedmetadata`。

- 加载失败 → 拒绝，`VIDEO_UNPLAYABLE`
- 加载成功 → 顺带取得 duration 与 width/height,而素材记录本来就需要这两个值

零解析、用真实解码器、还解决另一个需求。与图片路径同构。

### 词表

```
UPLOAD_VIDEO_FORMATS      video/mp4  video/quicktime  video/webm
CANONICAL_VIDEO_FORMATS   video/mp4                     ← 供应商约束
```

服务端魔数校验**复用 PR-A 的偏移感知匹配器**——mp4/mov 标识同在 `ftyp` box、offset 4，与 HEIC/AVIF 同一机制。

### 两个上限

| 常量 | 建议值 | 作用点 |
| --- | --- | --- |
| `maxUploadVideoBytes` | 100 MB | 上传时 |
| `maxVideoDurationSeconds` | 120 | 上传时 |
| `maxReferenceVideoBytes` | 沿用现有 `maximumReferenceBytes`（`runtime.mjs:135`,8 MB） | **生成提交时** |

`maxReferenceVideoBytes` **是未经验证的沿用值**，与 PR-A 的像素上限同一性质：8 MB 视频被 base64 内联进 MiniMax 的 JSON 请求体后约 10.7 MB,是否真能被接受没有实测过。因此它必须是一处具名常量、一处修改，且注释写明未验证。

**拒绝发生在用户真要用它生成的那一刻，不是上传时。** 消息必须说清是哪条限制、当前值、怎么办，并明确「它仍可留在素材库与画布上」——不能让用户以为文件废了。

**格式那一条不是新建。** `generationProvider.mjs:320` 已有 `'视频参考素材必须是 MP4。'`,`.mov`/`.webm` 连到生成节点本就会被拒。本轮只需给它补上「它仍可留在素材库与画布上」的下一步说明；错误码沿用现有 `INVALID_REFERENCE`,不新增码。

### mediaKind 开关

`uploadedAssets.ts:51` 写死的 `mediaKind: 'image'` 改为按探测结果设置。这是视频素材进入现有模型的那一个开关——`GenerationMediaKind`、素材库筛选、`videoAsset` 文案都已在等它。

**一处待实测确认，不当成已知事实：** 画布素材节点是否已能渲染视频。生成侧已能产出视频，故大概率能；若不能，本节需增加一个渲染分支。

---

## 问题 4：粘贴

### 一个监听器，按焦点路由

```
剪贴板里有没有文件类图片/视频？
  没有 → 直接放行，什么都不做（文本粘贴绝不被劫持）
  有   → 焦点在对话框内   → importImageFiles（与拖放同一条）
         否则画布是活动面 → addDroppedFilesToCanvas（视口中心）
```

只有一个监听器，因此不存在两处同时处理、素材进两次的问题。

### 读 items 而非 files

从 Finder 复制文件走 `clipboardData.files`,但截图（`Cmd+Shift+Ctrl+4`）、网页右键复制图片、图像编辑器复制，都只在 `clipboardData.items` 里给一个 blob。只认 `files` 会漏掉最常见的截图场景。筛选条件：`kind === 'file'` 且类型在词表内。

### 不处理 text/html 与 text/uri-list

从网页复制的图片会同时带 `text/html`（一个 `<img src>`）与 `text/uri-list`。抓远端 URL 会引入 SSRF 面，且那不是「粘贴图片」而是「粘贴链接」,是另一个功能。

### 画布落点：视口中心

粘贴不是指针事件，没有 `clientX/Y`（`onCanvasDrop` 正是靠它）。记录最后指针位置需要新增状态，且指针从未进过画布时仍需回落。视口中心可预测、无新状态。

### 粘贴内容的命名

`readUploadedAssetInput` 现为 `file.name.replace(/\.[^.]+$/, '')`。截图的 `name` 常是空串或 `image.png`,直接用会得到空素材名或一列无法区分的「image」。需要带时间戳的回落名。

### 视频粘贴是顺带的

复用同一校验器意味着「不写图片专属过滤」比「写」代码更少。从 Finder 复制视频文件粘贴会正常工作；截图类来源本就不产出视频。不为其单独做任何事。

---

## 问题 5：错误与测试

### 纯逻辑 / 薄机制

三处浏览器 API 在 `node:test` 里不存在，处理办法一致——决策做成纯函数，机制层薄到没有逻辑可测：

| 决策（纯函数，全测） | 机制（薄，注入原语） |
| --- | --- |
| 粘贴路由：剪贴板条目描述 + 焦点位置 → 目标落点 | 读 `clipboardData.items`、挂监听器 |
| 视频准入：时长/尺寸/字节/格式 → 接受或具名拒绝 | `<video>` 加载取元数据 |
| 参考素材准入：素材规格 → 能否用于生成 | —（本就是纯的） |

### 服务端三步

用假对象存储测全：铸 URL（签名锁死类型与体积区间）、commit 时对象不存在、commit 时魔数与声明类型不符、commit 时实际体积越界。**第三条是「以实际字节为准」这条保证在直传架构下唯一的落点**，是本节最要紧的钉子。

### 错误码

| 码 | 用户看到 |
| --- | --- |
| `MEDIA_COMMIT_NOT_FOUND` | 上传未完成，请重新选择文件 |
| `MEDIA_COMMIT_TYPE_MISMATCH` | 文件内容是 MOV，与声明的 MP4 不一致，请重新选择 |
| `MEDIA_COMMIT_TOO_LARGE` | 文件实际大小超出本次上传申请的范围，请重新选择 |
| `VIDEO_UNPLAYABLE` | 这段视频当前浏览器无法解码（常见于 iPhone 的 HEVC）。请导出为 H.264 的 MP4 |
| `VIDEO_TOO_LONG` | 这段视频 3 分 40 秒，超过 2 分钟上限。请裁剪后重试 |
| `VIDEO_TOO_LARGE` | 这段视频 340 MB，超过 100 MB 上限 |
| `REFERENCE_VIDEO_TOO_LARGE` | 这段视频 87 MB，作为生成参考最多 8 MB。它仍可留在素材库与画布上 |
| `INVALID_REFERENCE`（已存在，仅补文案） | 生成参考只接受 MP4，这段是 MOV。它仍可留在素材库与画布上 |

后两条的末句不可省：它决定用户是否误以为文件废了——正是 PR-A 那次生产故障里缺失的东西。

### 明确未被自动化覆盖

一片绿不等于功能是通的。以下必须写进 PR 描述：

- **桶的 CORS 配置。** 本功能最大的「测试全绿但功能全废」缺口：浏览器 PUT 到 S3 会被预检拦下，而所有服务端测试仍通过，因为它们从不发跨域请求。**必须在真实浏览器对真实桶验一次。**
- 真实预签名 PUT（需凭证与网络）
- 跨浏览器 `<video>` 解码差异，特别是 HEVC
- 跨浏览器/操作系统的剪贴板行为

---

## 推荐落地顺序

**PR-1：粘贴（最小、零依赖、先交付真正被要求的东西）**
路由纯函数 + 一个监听器 + 命名回落。走的是既有的 `importImageFiles` / `addDroppedFilesToCanvas`,**不依赖直传也不依赖视频**。桌面拖拽本就已实现，粘贴才是本次请求的实际缺口，因此排第一。

**PR-2：分发**
`objectStore.createSignedUrl` + 视频 TTL 常量。点亮已有的 302 分支。不改上传，不加视频。立即收益：媒体不再全部流经 API，且为视频的 Range 铺好路。

**PR-3：直传上传**
upload-url / commit 两个端点、64KB 回验、客户端改走三步、`persistDataUrl` 的客户端路径下线。仍只支持图片，先让新链路在低风险载荷上跑稳。

**PR-4：视频素材**
视频词表、`<video>` 准入校验、`mediaKind` 开关、两个上限与 use-time 拒绝、画布视频渲染（若需）。放最后是因为它同时依赖 PR-2 的 Range 与 PR-3 的大文件承载。

排序理由：PR-1 独立交付用户实际要的功能；PR-2 与 PR-3 各自可独立发布并单独回滚；PR-4 建在两者之上。

### 本轮只做 PR-1，PR-2/3/4 推迟

**视频被移出范围后，PR-3 的理由整个消失了**：改直传的唯一动机是 100MB 视频塞不进
base64-in-JSON,而图片上限 8 MB、base64 后约 10.7 MB,现有 32 MB 请求体完全放得下。
没有视频就去建预签名上传，是为一个已撤回的需求付复杂度。

PR-2 自身仍然立得住（媒体不再全部穿过 API、两种部署合并成一条代码路径），但它带来的
授权姿态变化有一半是靠视频撑起来的，因此一并推迟。

本文其余部分照原样保留：视频回到范围内时，PR-2/3/4 直接按此实施，不需要重新设计。

## 明确不做

- **ffmpeg / 视频转码。** 浏览器无法转码视频（ffmpeg.wasm 约 30MB 不可接受）；MOV/WebM 因此只能当素材，不能当生成参考。
- **粘贴远端图片 URL**（`text/html` / `text/uri-list`）。SSRF 面，且是另一个功能。
- **给 `streamMedia` 加 Range。** 配置对象存储后它只服务本地原型。
- **记录指针位置以决定粘贴落点。** 视口中心已足够且无新状态。
- **媒体删除与引用计数。** 仓库现无删除路径；孤儿交由桶生命周期规则。
- **服务端视频探测**（时长/编码）。`<video>` 已给出全部所需，且用的是真实解码器。
- **上传断点续传。** 100MB 单次 PUT 在正常链路上可接受；失败即重传。

## 验证

```bash
npm test
npm run check:architecture
npm run check:security
npm run check:evals
npm run build
git diff --check
```

**浏览器手验（自动化覆盖不到，必做）：**

1. **先验 CORS**：浏览器里拖一张图 → 确认 PUT 直达 S3 未被预检拦下。这条不过，后面都不用试。
2. 拖一段 50MB MP4 → 上传成功 → 画布可播放 → 拖动进度条可 seek（证明 Range 生效）。
3. 拖一段 iPhone HEVC `.mov` → 被拒且提示可执行。
4. 截图后 `Cmd+V` 粘进对话框 → 成为上下文 chip，且名称不是空的。
5. 截图后 `Cmd+V` 粘进画布 → 落在视口中心。
6. 在节点标题输入框里粘贴**文本** → 正常粘贴文本，不触发素材上传。
7. 把一段 87MB 的视频连到生成节点 → 被拒，且提示说明它仍可留在素材库。
8. 观看一段视频超过 10 分钟后拖动进度条 → 不中断（证明视频 TTL 生效）。

## 文件地图（实现时）

**新增**

| 文件 | 职责 |
| --- | --- |
| `server/mediaUploadRoutes.mjs` | upload-url / commit 两个端点 |
| `server/mediaUploadRoutes.test.mjs` | |
| `src/domain/videoAdmission.ts` + `.test.ts` | 视频准入纯策略 |
| `src/domain/clipboardRouting.ts` + `.test.ts` | 粘贴路由纯判定 |
| `src/lib/videoProbe.ts` | `<video>` 加载取元数据，原语可注入 |
| `src/lib/clipboardPaste.ts` | 监听器挂载，薄 |
| `src/lib/mediaUploadClient.ts` | 三步上传编排 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `server/objectStore.mjs` | 新增 `createSignedUrl`（读）与预签名 PUT |
| `server/mediaService.mjs` | TTL 按介质分；commit 回验 |
| `server/mediaFormats.mjs` | 新增视频词表与上限常量 |
| `server/generationProvider.mjs` | 生成参考的视频体积/格式 use-time 校验 |
| `src/domain/mediaFormats.ts` | 客户端视频词表副本 |
| `scripts/mediaFormatContract.test.mjs` | 覆盖新增视频词表 |
| `src/lib/uploadedAssets.ts` | `mediaKind` 按探测结果设置；改走三步上传 |
| `src/features/agent/AgentWorkspace.tsx` | 挂粘贴监听器 |
| `src/features/canvas/useCanvasInteractionCoordinator.ts` | 视口中心落点 |
