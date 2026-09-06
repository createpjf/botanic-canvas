# Agent 面板与 Harness 修复进度

依据：本任务已确认的《Botanic Agent 面板与 Harness 修复方案》（2026-09-05）。

## 进度

此前开发与真实生成验收记录保留；四类本地修复完成后，继续收口真实指定第二张图编辑及其结果操作。

最新验收：CP-R3-EDIT-1。真实指定第二张图编辑已跑通：同一视觉模型使用传输副本后返回，GPT Image 2 单次编辑产生一张蓝底新图；两张原图哈希未变，Run/Job/Artifact/聊天和刷新恢复一致。另修复血缘来源被误当作定位/继续编辑目标的问题。最新全量 2839 通过、0 失败、2 可选 PostgreSQL 跳过；既有 18 项隔离 UAT 的证据仍属于 CP-FOUR-1，本轮未重跑全部 18 项。生图累计 6/6 次，不再追加；共享部署、物理设备和修复后真实补图/取消复验仍单列。原 4173/8787 服务已恢复，但原项目页面登录失效，待用户重新登录后复验。本轮未提交、推送、部署或共享迁移。

验收按下表逐项列出本地证据与缺口，不再用混合本地/共享环境的「0/9」作为开发进度。

本地实现只表示对应代码和聚焦检查已完成，不代表浏览器全场景、共享服务或发布验收通过。完整目标仍按 A–I 保留，不以本地实现比例代替最终完成率。

2026-09-05 用户明确当前是本地开发：按本地可复现问题、必要回归和可见结果收口；共享环境、物理设备与发布验收单列，不作为本地开发完成的阻塞条件，不据此重复全套审计。

| 子项 | 本地实现 | 仍需补齐 |
| --- | --- | --- |
| A0 | 已实现 | 同构建全场景整体验收；共享网络与后台浏览器计时仍不以本地模拟代替 |
| A1 | 已实现 | 初次展示核对原 Turn/原请求、历史卡只读、缺页快照有界读取及未载入 Run 精确定位已验实际组件；跨设备与共享服务恢复待验 |
| A2 | 已实现 | CP-A2/E1-1 补真实本地 API/Worker/PG 的确认回包丢失→刷新→同 Run 结果恢复；同键重试未新增生成。共享服务与跨设备另验 |
| A3 | 已实现 | 两项原先跳过的真实 PostgreSQL 确认一致性/完整 RPC 检查已补跑通过；共享环境与三 Adapter 完整端到端仍待验，迁移不自动执行 |
| B1 | 已实现 | CP-I1-BG-1 补整页上传双图→实际本地请求含描述→durable 引用事件→刷新还原；原图模式与失败类别由既有请求契约测试覆盖，真实 Provider 另验 |
| B2 | 已实现 | CP-I1-BG-1 补整页单项重新准备：只读响应模拟一项失败，真实准备端点只收到失败节点，不新建 Turn/Run/Job；远端目标/同步保护/取消隔离的既有验证保留，原项目及共享环境另验 |
| C1 / C2 | 已实现并复验 | CP-I1-ORIGINAL-2补本地inline权威媒体保留，HTTP回写/epoch 2重建/协作移动回归通过；原项目真实断线与刷新仍保留两图。CRDT清洗、Outbox/ACK及既有缺项回写不重放不变；共享权限恢复与跨项目完整竞态另验 |
| D1 | 已实现 | 默认设置与手动确认已验；尺寸误作变体已修；真实本地 Plan → Run → Job 的 2 张 / 3:4 / 2K 一致性已验，非测试 Provider 与共享环境仍待验 |
| E1 / E2 / E3 | 已实现并复验 | CP-I1-ORIGINAL-2修复缺URL图片误归工具，缺媒体不提供无效下载/继续修改；原项目结果2/工具0、详情解码、定位既有节点、单图继续修改引用与消息内结果均通过。缺地址分类由回归覆盖；历史分页/同ID更新证据保留，真实模型品质与共享环境另验 |
| F1 | 已实现并复验 | CP-I1-ORIGINAL-2原项目真实8787中断30秒，离线提示准确，草稿保留，恢复后同任务与两图可用；28 Turn/2 Run/2 Job及原图指纹不变。未在服务恢复后重放失败模型请求，避免真实Provider调用 |
| F2 | 已实现 | CP-F2-2 补整页 Plan提交→Run身份迟到→Worker已派发→Stop→取消回执不可达→刷新接续同一Run；原任务、durable ACK、旧图及不重复生成通过。主动取消显示已停止。跨设备/独立Worker部署另验 |
| G1 | 已实现 | CP-I1-BG-1 补整页读取历史事件：整轮17秒/步骤5秒，缺时间显示未知；成功折叠、手动操作保留、不将reexecute显示为已恢复。并行/分页依既有契约验证；真实服务时钟另验 |
| G2 | 已实现 | CP-I1-BG-1 补整页同站不同URL/必要query保留、重复URL去重、最终单一引用入口及Enter/Escape/焦点返回；项目实体组件验证保留，真实触屏另验 |
| H1 | 已实现 | 三档视口、短视口、附件焦点与Shimmer已验；CP-H1-4 补原生tabs.setZoom(2)、布局重排、双附件键盘移除。真实触屏/软键盘与OS级偏好另列，不阻塞本地开发 |
| I1 | 本轮恢复验收通过 | CP-I1-ORIGINAL-2在原项目关闭已确认的两处缺陷并复验真实断线/刷新/结果可达性；当前构建2828项通过。不是全部真实Provider、共享部署或实体触屏验收；本轮未发送新生成请求 |

每完成一个修复包并通过对应验证，更新进度并追加 checkpoint。进行中、仅代码完成、未验证均不计入完成数。Checkpoint 是开发记录，不是产品运行时 Checkpoint，也不代表已提交或部署。

| 包 | 范围与完成条件 | 状态 |
| --- | --- | --- |
| A | 当前确认只生效一次；答案可靠保存；历史卡只读；失败/刷新接续同一操作 | 本地主链路通过 · CP-A2/E1-1补真实本地API/Worker/PG确认回包丢失后恢复同一Run，SQL检查已补；共享与跨设备另验 |
| B | 引用准备、实际采用、部分失败明确；安全观测；attempt/会话隔离；不持久化视觉内容 | 本地主链路通过 · CP-I1-BG-1补双图实际描述请求与事件恢复、失败项真实单独准备；只读故障夹具/假模型边界保留，原项目与共享环境另验 |
| C | 同步失败原因与重试真实；按操作保护；保留草稿/Outbox；不自动重新生成 | 本地主链路通过 · CP-I1-ORIGINAL-2关闭inline恢复缺陷，原项目断线/刷新两图保留；既有同步与缺项回写证据保留，真实权限恢复与跨项目完整竞态另验 |
| D | 使用有效默认设置；减少非必要澄清；计划可修改；保留计费/批量/外部确认 | 本地主链路通过 · 单图默认计划与真实本地2张/3:4/2K参数贯穿Plan/Run/Job已验，仍保留手动确认；假Provider边界保留 |
| E | 任务与结果可辨认；同 Run 唯一投影；部分结果/索引失败/分页/已删节点正确；返回恢复上下文 | 本地主链路通过 · 指定媒体提交、原图保留、同ID更新及旧页保护已验；受控响应/假模型与共享服务边界保留 |
| F | 失败处直达恢复动作；取消入口连续；未知结果禁止普通重试；保留已完成结果 | 本地主链路通过 · CP-F2-2停止证据保留；CP-I1-ORIGINAL-2补原项目服务中断、正确错误提示、草稿与原图保留；跨设备/真实失败Provider重放另验 |
| G | 来源去重且可核验；不误合并同站页面；可触控引用；真实用时/恢复；折叠不抢用户操作 | 本地主链路通过 · CP-I1-BG-1补完整页面只读历史事件、未知时间、去重来源、键盘与焦点；真实触屏与服务时钟另验 |
| H | 消息/Bob/分隔线统一；字体/Composer/附件固定；响应式、焦点、触控与 reduced-motion | 本地主链路通过 · 三档视口、短视口、原生200%缩放、键盘附件与浏览器动态偏好已验；真实触屏/软键盘另列 |
| I | 全量门禁、同版本浏览器验收、逐项完成审查；证据不足项明确保留 | 本轮本地收口通过 · CP-I1-ORIGINAL-2的当前门禁和原项目恢复证据已齐；未执行的真实生成/共享环境/物理设备保持独立边界 |

## 受保护边界

- 保留已有未提交修改，不 reset、不整包覆盖、不批量升级组件。
- 不改变 Provider、Flock 请求、网络超时、幂等身份、权限、取消 fence/ack、未知结果处理、画布同步协议。
- Turn、Run、Job、Message、Artifact 维持现有权威归属；不建第二套持久化状态机。
- 不持久化原始 reasoning、caption 原文、图片字节、私有 URL、Provider body。
- 不修改 ReactFlow 主画布布局，不引入 UI 库或测试框架。
- 本地实现不包含提交、推送、部署、迁移、真实付费生成；这些需要独立授权。

## 统一交互验收

- 用户右对齐（≤85%）；Assistant 头像、过程、结果、正文、操作统一左边线。
- 最新可见 Assistant（含运行占位）只显示一个 Bob。
- 当前轮运行中没有完成分隔线；终态 Assistant 开始处仅一条，用户消息之前没有；不删除合法 Markdown hr。
- 无内容时仅一个真实 Shimmer；内容到达撤掉通用占位；waiting_user/关联 Run 运行中不伪装整轮完成。
- HTTP 断线不等于失败；取消请求响应不等于 Worker 停止；索引失败不改 Run 状态。
- 普通元数据/错误≥12px，正文14px/1.6，小屏输入16px；附件点击区与相邻图片不重叠。
- 技术详情限开发模式，只有真实恢复才显示恢复记录；raw reasoning 仅当轮内存。

## 浏览器验收账本

| 场景 | 状态 / 证据 |
| --- | --- |
| 项目进入、深链刷新、超时与快速切换 | 本地通过 · 实际项目列表进入/深链重载正常；实际 CanvasWorkspace 隔离慢读验证重复事件只读取一次、旧读不挡新项目、45 秒错误出口与原项目重试；CP-C1/F1 新项目慢保存后首次发送、保存失败后一键接续原消息均通过，无 Message 404 或重复用户消息 |
| 普通问答，无空卡和空工具栏 | 部分通过 · 打包页能力边界检查保留；完整页面通过真实本地 API/Turn 执行器/PostgreSQL 和 fake Provider 发送、流式及刷新恢复。非 mock Provider 行为不在该证据内 |
| 带图准备、实际采用和部分失败 | 本地主链路通过 · CP-I1-BG-1实际双图上传、真实本地API/假模型描述请求、durable反馈及刷新恢复；历史读取模拟一项失败后，真实准备端点只重试该节点，显示已重新准备但未发送，不重建Turn/Run/Job。原生视觉/超限/目标失败/attempt隔离依既有契约检查，真实Provider另验 |
| 单图默认设置、必要确认 | 部分通过 · 隔离本地预览输入“生成一张海边人像”直接显示 GPT Image 2 / 3:4 / 2K / 1 张的可编辑计划，保留“生成”确认；未触发 Provider |
| 确认后刷新、同操作恢复 | 本地主链路通过 · CP-A2/E1-1 经过真实本地 API/Worker/PG：服务端接受计划后回包返回503，刷新恢复唯一原Run、唯一新图、不重开该计划确认，旧节点及媒体保留；假生成调用仅增加1次。共享服务恢复未验 |
| 占位/工具/Run 状态与停止 | 本地主链路通过 · 文本Turn既有证据保留；CP-C1/H1-5同源码整页完成迟到Run身份、Worker开始、停止、取消回包丢失与两次刷新，按独立Job API核对cancelled、signalRequired、workerReleased及signalAcknowledgedAt；原任务/旧图保留，无重复生成及页面异常 |
| 单图、多图、部分完成与继续修改 | 本地主链路通过 · CP-E3-3 缺失节点仍保留 Artifact、下载及恢复；CP-E3-4 从对话第二张图实际发送新版本，配方与媒体绑定只包含所选图片、原节点/媒体不变，确认1张只增1次假生成，刷新新旧图片均解码。假模型语义与图片品质不作为真实编辑效果证明 |
| 失败处重试，成功结果保留 | 本地通过 · 完整 UI → API → PostgreSQL → 假 Provider：首轮 2 次请求仅 1 图成功；补图只增加 1 次，首图 URL 保留，最终两图解码、两个 Artifact；同键重放不增加生成。真实付费 Provider 未调用 |
| 索引读取失败不触发生成 | 本地通过 · 原 Message 组件证据保留；完整页面将索引 GET 返回 503，结果面板保留当前画布的两图并提供重试；恢复真实 API 后点击重试、错误消失，生成调用数仍为 2。分页失败范围另验 |
| 历史第101项、更多页重试与返回 | 本地通过 · CP-E3-2 在隔离 PostgreSQL 添加101条专属测试记录，通过实际 Artifact API 分页；更多页503保留已有结果，重试原游标载入历史图片，实际解码，缺失节点不显示定位，继续改仅引用所选媒体且生成调用数不变；结果列表滚动后返回保留聊天位置、草稿、引用与输入焦点 |
| 跨项目迟到索引与更多结果入口 | 本地通过 · CP-E3-3 暂存 A 的真实 API 响应，切入 B 后再释放，B 不出现 A 的结果且草稿保留；当前消息已有图片、索引仍有历史页时保留“查看更多结果”，最终构建三项非删除浏览器检查通过 |
| 同ID结果更新与首页刷新保留历史 | 本地页面通过 · CP-E2-2 在实际页面与真实媒体上注入旧版→新版→旧分页，标题/缩略图/预览接受新版，旧版不覆盖，两个历史项无重复。关闭再打开Agent触发真实首页读取后仍保留历史；只模拟HTTP版本响应，不修改数据库Artifact |
| 同步受阻与真实重试反馈 | 本地主链路通过 · CP-C1-3 暂缓真实握手回包并推进测试时钟，超时后从 Agent 头部恢复；真实服务端拒绝测试代理损坏的更新，草稿与原 Outbox 增量保留。两处重试入口接续原身份，剩余失败原因不消失；实际提交 ACK 暂缓时显示保存中，放行后排空并显示已保存。未改变真实账号权限，权限恢复另验 |
| 同步期间结果回写与生成恢复 | 本地通过 · CP-C2-1：行动原回执已完成但同步未恢复时保留两项结果，禁用继续回写；恢复只补缺项，刷新不重放工具。真实本地 API/PostgreSQL 的双图 Run 在暂缓握手期间完成，两个 Artifact 与结果节点在重连/刷新后保留，图片可解码，假 Provider 调用数仍为2。不是外部工具或真实图片 Provider 验收 |
| 多附件移除、焦点与误触 | 本地通过 · 真实两张图片、3 档视口与短视口，移除按钮 ≥24px 且在容器内，Enter 逐个移除后聚焦相邻/添加按钮；真实触屏另验 |
| Web/项目引用，键盘与触屏 | 本地主链路通过 · CP-I1-BG-1完整页面只读事件夹具验证同站两页及query保留、重复URL合并为单一最终入口，Enter打开/Escape关闭且焦点返回；实体及@实体归一由既有实际组件证据覆盖，真实触屏另验 |
| Bob、左右对齐、终态分隔线 | 部分通过 · 现有 Bob E2E 与原项目 DOM 证据保留；实际 Message 状态切换验证历史头像为零、最新仅一个，用户/等待/工具/流式/运行 Run 无完成线，终态仅一条；完整应用的实时恢复组合仍待验 |
| 360 / 768 / 1440、200% 缩放、短视口/软键盘 | 本地主链路通过 · 三档/短视口与移动WebKit既有证据保留；CP-H1-4 使用原生tabs.setZoom(2)，1440布局宽度变为720、DPR翻倍，按钮与输入无溢出且双附件键盘移除/焦点通过。不是CSS zoom或裁切；物理触屏/真实软键盘未验 |

## 集成门禁

- [x] 最近一次完整 `npm test`（CP-R3-EDIT-1）：1993 服务端/脚本 + 846 客户端 = 2839 通过、0 失败；2 可选 PostgreSQL 跳过。日志：`/private/tmp/botanic-r3-final-tests.log`，不拼接早前单独 SQL 结果。
- [x] CP-I1-3 单独补跑 `agentMessageEntityReferencesMigration.test.mjs`：6/6，无跳过（包含上述两项 SQL）；不拼接成一次新的全量测试结果
- [x] `npm run check:architecture`
- [x] `npm run build`：CP-R3-EDIT-1 最终构建为6.18秒，保留现有大包警告。日志 `/private/tmp/botanic-r3-final-build.log`；仅本地构建，无部署
- [x] `git diff --check`
- [x] 本轮1–4同一构建的原项目恢复验收及逐项审查；未重新触发真实生成，其他场景按账本边界保留
- [x] CP-I1-REAL-1：用户授权的真实单图生成、文本回复、结果定位、修改准备、刷新与API重启恢复；仅1次生图尝试
- [x] `check:evals`：9条固定样本符合期望，43项Turn与69项前端意图回归通过；不作为创意质量评估。日志 `/private/tmp/botanic-prerelease-real-evals.log`
- [x] `check:security`：仓库现有凭据/调试注入门禁通过；不等同完整渗透测试
- [x] Chromium现有门禁：29通过、18隔离UAT跳过，54.8秒。独立4182页面使用local模式并将API代理指向不可用端口，未访问真实账号或生图服务；日志 `/private/tmp/botanic-prerelease-real-e2e.log`。包含1440/768/360及360×400、双附件移除与键盘焦点；真实浏览器另按CP-I1-REAL-1记录
- [x] CP-FOUR-1 全新执行上述 18 项隔离 UAT，全部通过；另有旧卡补图与迟到停止确认专项通过。CP-R3-EDIT-1 补真实指定图编辑与结果操作验收；物理触屏与共享发布仍未验，不能宣称上线就绪。
- [ ] 发布前：授权后 staging 文本/引用/受控图片/恢复链路，核对前端/API/Worker revision；未验证不宣称生产就绪

## Checkpoints

### CP-R3-EDIT-1 · 2026-09-06 17:08 CST · 真实第二张图编辑与结果目标修复

- 隔离项目 `project-1788665720084`，原 `start-real.mjs` 预算账本继续累计，未重置额度。经用户明确授权使用隔离测试令牌登录 `localhost:4191`。本轮新增一次原模型规划复现、修复后的正常规划链路，以及一次真实 GPT Image 2 编辑；没有在原项目发生成请求。
- 修复前真实复现：`turn_387d4eedd36968e41389c109921b5b14` 的 native vision 请求约 2,156,957 bytes、1 张图、16 tools，54,996ms 后本地 abort，未收到上游响应头；不是供应商返回 HTTP 504。原图 1,589,949 bytes，持久事件确认目标已提交、尚无工具执行。
- 最小修复：`server/media/agentVisionImage.mjs` 复用已有 PNG decoder 与 `jpeg-js`，只在原生看图/caption 共用准备边界创建不回写的 JPEG 副本，当前第二张图降至 114,299 bytes，1024×1024 尺寸不变。未修改生成 parent/配方、Flock 请求字段、模型、timeout、幂等键或 schema。共享 PNG decoder 增加按声明像素量限制解压的护栏，避免优化路径放大畸形压缩数据。
- 优化边界明确：只处理大于 512KB、最多 4MP 的非交错 8-bit 不透明 PNG；透明、动画、其他格式或解码失败保持原图，不冒充已优化或替换空图。没有引入依赖；更大/透明图片的性能仍需各自复现，不能用本次成功推论全部图片类型。
- 修复后同一 `deepseek-v4-flash-vision-exp` 请求约 189,757 bytes，32,566ms 收到 HTTP 200，42,170ms 完成该视觉流；接续正常 Planner 工具链。根 Turn `turn_31105a5eba4528306c2bb059cb9b0762` 与计划 Turn `turn_12b5f54e08740d4edb01101439c4fc24` 均 completed，没有静默换模型或加长超时。
- UI 核对 GPT Image 2、1:1、1K、1张、仅「斜向」父图后提交一次。Run `agent_run_iFUc9j6HizyCVve39AVa7VfcTgOLBwk9bduM8hFvZAE` completed；Job `job_4pByWo5l4ENHeY3VXxph5byiwgfw12qjfthoSKjxEd4` succeeded、1 attempt、1 output。预算记录 `kind=edit,references=1,status=200`；本轮用去最后一次生图额度，累计 6/6。
- `targetBinding` 与 `inputProvenance.parent` 精确指向第二张原图及其原媒体 SHA256；编辑输入仍是原始 PNG，而非视觉 JPEG。原两张图 data URL 哈希分别保持 `6e3c8d16d16656633200d43fabc9860801dd012f0437d8f4642db53888d354fa`、`dcc42816df86126c73997250135e0367c8d883f4deef8ad98faeb3bd5e6486ec`；新图 `2497341d4aec93c68ea29b7116318af8cf446ecf1151134b9132c3d5a90dd4d8`。项目新增唯一结果与 Artifact，现有 2 个 completed Run、3 个 Artifact；三张画布图刷新后均实际解码 1024×1024。肉眼确认新图浅蓝背景、银杏斜向构图；不把生成式编辑称为像素级完全保真。
- 真实操作暴露并修复第二个问题：Artifact 的 `sourceNodeIds` 同时包含输入血缘与当前输出，UI 原先选了父图。新增纯投影 `agentArtifactTargetNodeIds`，从生成产物的操作目标中排除已记录父图/参考输入，接通聊天缩略图/定位/继续修改、结果详情与批选、任务可定位计数。权威血缘完整保留；当前输出已删除时不回退选父图。修复后定位只选「蓝底银杏」，继续修改托盘仅引用该新图；未提交下一轮生成。
- 回归：看图副本测试先红后绿；PNG 超量解压拒绝、结果目标投影与批选回归通过；完整 `npm test` 1993 + 846 = 2839 通过、0失败、2可选PG跳过。架构检查、构建6.18秒、diff检查通过，保留既有大包警告。日志 `/private/tmp/botanic-r3-final-tests.log`、`botanic-r3-final-build.log`、`botanic-r3-architecture-final.log`；真实对照日志 `botanic-r3-continue-api.log` 与 `botanic-r3-fixed-api.log`，均只记录安全请求尺寸/模型/耗时，不记录 Provider body 或原始推理。
- 原 4173/8787 原本已停止；只读确认本地无在途 Turn/Run/Job 后按原配置恢复服务。原项目仍保留3个成功Job；页面显示登录失效，已请用户重新登录，原账号页面验收待补。真实补图/取消修复后复验仍未新增执行；物理触屏/软键盘、共享服务及发布仍未验。不把本轮真实编辑通过称为整体上线放行。

### CP-FOUR-1 · 2026-09-06 13:11 CST · 四类本地修复与回归收口

范围：用户明确顺序 1 → 3 → 4 → 2。保留已有脏工作树；不提交、推送、部署、执行共享迁移或新增真实生成。隔离测试使用 API 8789、PostgreSQL 55433、前端 4182 和本地假 Provider。

1. **删除意图**：确认竞态为 CRDT 图删除先提交、独立元数据 PATCH 后到。浏览器图增量在 ACK 前复用领域删除规则保存 dismissedOutputIds；存储失败不确认删除。迟到 Agent 恢复不再通过工作流节点白名单绕过删除标记。历史 Artifact 不删除。WebSocket 回归覆盖持久基线上的保存失败、原键重试、重启读取和显式撤销；完整页面实际删除→刷新→下载/继续修改通过，未新增生成。
2. **补图**：旧卡按 Run 当前分支及 active Job 判断，复用现有分支重试与幂等身份；已补齐、执行中、已取消与停止待确认时不从旧卡创建独立任务。共享命令防连点。新浏览器测试实际发现下载按钮覆盖补图按钮，两者已分区，补图文字 12px、按钮至少 24px。完整 UI 首轮两次假调用一成一败，补图只新增一次，首图保留、最终两图、刷新后旧卡无补图入口，键盘重复操作不增加请求。证据：`e2e/uat-agent-retry.spec.ts`、`/private/tmp/botanic-four-retry-button.log`。
3. **取消反馈**：丢回包后只读核对同一 Run/Job；合并已确认取消记录，不让缺回执的画布兼容视图抹掉事实。取消共享命令合并并发；已确认任务直接返回，已发送停止但 ACK 未到只继续查询。保留失败重试及费用说明，不改变服务端取消语义。UI 有界自动复查，迟到确认更新 Job 与停止消息。原生整页验证普通丢回包、额外隐藏前三次 Worker ACK、刷新恢复均只提交一次取消、一次原始生成，无第二次点击。证据：`/private/tmp/botanic-four-stop-preserved.log`、`/private/tmp/botanic-four-stop-late-fixed.log`。
4. **阅读位置**：不同面板不再复用同一个 DOM 滚动容器，各自沿用已有位置记录；切换时销毁旧容器，避免旧面板的滚动影响新面板。没有叠加延时或强制滚到底部。严格原有断言（返回位置误差 <2px、草稿/引用保留、输入焦点）多次通过，未改低标准。证据：全量 UAT 第9项及 `/private/tmp/botanic-four-scroll-isolation.log`。

最终验证：

- 18/18 既有 UAT 全新运行，不复用旧绿灯，不跳过、不放宽失败断言。账本 `/private/tmp/botanic-agent-recovery-uat.0NZvAD/four-final-18/outcomes.json`，逐项日志与截图同目录；含删除、阅读位置、确认回包丢失、停止、历史结果、200%缩放、同步恢复。
- 新增旧卡补图专项通过；取消 ACK 迟到变体通过。测试仅在隔离假服务中注入失败/延迟，未改原项目历史图片。
- 全量 2836 通过、2 可选 PostgreSQL 跳过；架构、构建、diff 通过。最后日志均为 `/private/tmp/botanic-four-delivery-*`。
- 原项目 `project-1788499314489`：浏览器重载后任务仍为3项已完成、0进行中、已保存，原有图片仍可见。原本地 API 进程 PID69321 已按原启动命令重启为 PID99285，`/api/health` 返回 ok，file/local-prototype 配置未更换。仅本机开发服务，不是部署。
- 本地四类目标完成；真实指定第二张图片的 Provider 编辑、物理触屏/软键盘、共享服务及生产发布继续单列，不用本轮假 Provider 和本地绿灯替代。原始思维链、鉴权、幂等键、持久化 schema 与主画布布局规则未变。

### CP-34-1 · 2026-09-06 12:12 CST · 命名落地，补齐验收并保留失败

范围：实施已确认的第 3、4 项。沿用现有测试体系，保护开始时 175 个脏文件；不提交、推送、部署或迁移。Provider 配置、超时、持久化命名、Run/Job/Artifact 身份与原始输出未修改。故障注入及限流调整仅位于 `/private/tmp` 独立验收栈，不进入产品默认配置。

#### 第 4 项：命名与布局

- 新增纯 UI `agentDisplayNames.ts`，Task、结果面板、消息附件和修改选择器共用。只替换已知通用占位名，保留其他自定义名称；优先现有计划内容首句，最多 80 个 Unicode 字符，保留英文词间空格。缺内容回落到任务时间，不泄露技术 ID，不新增模型调用。
- 输出编号取固定 output 序号，多分支增加分支序号；补图根据既有 branch.jobIds 标明「补图 1」，不按当前页/到达顺序重新编号。仅替换显示数据，不回写 Artifact label、Plan title、节点名称或指纹。任务标题最多两行，长句允许换行。
- 2 条命名测试先失败后通过，覆盖通用名、固定编号、补图、自定义名、英文及无计划内容；原对象不变。4173 原项目完整刷新后，三条 Task 已分别显示银杏叶内容、英文月球场景和海边插画；聊天结果附件也显示内容名称，画布原名称仍为「新图」。
- 真实 viewport 360×800、768×800、1440×800 的任务名称、按钮和容器宽度检查通过；截图位于 `/private/tmp/botanic-3-4-names-responsive/`。本轮 18 项中原生 200% 缩放与双附件键盘操作通过；实体手机、真实软键盘与触屏仍未验，不能以桌面模拟替代。

#### 第 3 项：18 项隔离 UAT

隔离 API 8789 / PostgreSQL 55433 / 前端4182；规划、图片和媒体服务均为本地假服务，禁止外部 Provider。每例独立测试项目，结果：**16 通过、2 失败、0 跳过**。机器账本 `/private/tmp/botanic-agent-recovery-uat.0NZvAD/current-18/outcomes.json`，同目录保留逐例报告、失败截图及 trace。

| 编号 | 场景 | 本次结果 |
| --- | --- | --- |
| 1–6 | 双图采用与刷新、用时/来源键盘、原生200%、同ID更新/旧页保护、指定第二张假模型编辑、跨项目迟到响应 | 通过 |
| 7 | 实际删除生成节点后刷新，保留历史结果且不重建已删除节点 | **失败：输出被恢复为新的 `-pending` 节点** |
| 8 | 第101项历史分页失败原位重试、缺节点预览/修改准备 | 通过 |
| 9 | 结果面板返回恢复草稿、引用、阅读位置与焦点 | **失败：草稿/引用/焦点保留，阅读位置回到底部，相差约120px** |
| 10–13 | 新项目首发等待保存、保存失败重试、accepted刷新同Turn、执行中Stop | 通过 |
| 14–18 | Run身份迟到/取消回执丢失、确认回包丢失同Run、真实握手重试、仅补未回写产物、同步恢复不重生图 | 通过 |

修正了测试自身三类错误：消息 Session 从实际提交 Turn 取权威 ID；同媒体 URL 的两图按 Artifact 展示身份选择；节点计数检查 Store 实际图而非被虚拟化的可见 DOM。删除通过真实按钮完成，未 force 点击或绕过面板；滚动使用真实 wheel 保留严格位置断言。批量请求导致的429在隔离栈提高限流后重跑，不改产品限流。

失败 7 的独立证据：`project-1788666416323` 的原结果节点确已删除，但刷新后对应输出落在新建 `-pending` 节点上；Artifact 与原 Job 输出尚在。现有删除产生的 dismissedOutputIds 与恢复投影之间疑似缺少持久衔接，具体写入边界尚未完整定位。不能通过隐藏定位按钮、删除历史 Artifact 或全局禁用恢复来掩盖。

失败 9 已记录正确保存/还原的 scrollTop 随后再次移动；尚不能断言是自动跟随单一根因。尝试的滚动/焦点/动画修复未通过复验，已恢复为本轮修改前代码，保留失败测试及用户原有改动。两项均未销项。

#### 第 3 项：真实 Provider R1–R4

隔离文件持久化/API8791/前端4191，不使用原项目；沿用 GPT Image 2 和既有规划模型。转发代理在请求发送前持久记录预算，**实际转发5次单图请求，上限6次，含重试/回退**。记录 `/private/tmp/botanic-agent-real-3-4.ECIY09/requests.json`；部分失败注入发生在转发之前，不计作真实失败响应或付费请求。

| 场景 | 实际证据 | 结论 |
| --- | --- | --- |
| R1 双图 | `project-1788665720084`；两次真实请求200，居中/斜向两个 Job 各一图；Run completed，画布/聊天/索引两图，修改选择器能区分第二张 | 通过主链路 |
| R2 部分失败与补图 | `project-1788666141446`；首图真实200，第二项本地注入400；从Task重试仅增加1次真实单图请求，最终Run completed且两图入聊天/索引，首图输出哈希保持一致 | 通过补图链路；旧画布卡仍显示1/2和「补1张」，UI状态未收口 |
| R3 指定第二张真实编辑 | 明确选中斜向图，Composer仅一引用；发送及「恢复本轮」共两次规划超时，没有创建编辑Run/Job或转发图片编辑请求 | **未完成**；假模型编辑通过不能替代真实编辑 |
| R4 派发后取消 | `project-1788666787970`；1次真实请求已发出，取消后本地abort。原Run/Job均cancelled、0输出、workerReleased=true、signalAcknowledgedAt已记录、billing=possible；未追加生成 | 权威取消通过；首次UI提示「取消未完成」需再次点击，最终聊天已停止、画布已取消，但旧卡仍有「补1张」 |

R2 最初在已有图项目准备的计划仍显示「引用1」，与本次无引用要求冲突，未确认该计划；改到空隔离项目后才提交。不能把提示词里的「不引用」视为已经移除界面中的引用。

结束时隔离真实栈3个Run均终态（2完成/1取消），5个Job均终态（4成功/1取消），没有继续用第6次预算重试超时或掩盖失败。取消是本地停止和丢弃迟到结果，不等于 Provider 免费或远端已退款。补图前已有三份输出的逐项 SHA256 均未变。

原项目仍为30 Turn / 3 Run / 3 Job / 3 Artifact；原两份Job身份、状态和outputs的哈希仍为 `1a707aaba5063b5ceed059fcb1f0daf02ce7218aa20cf57d296dff2204138e67`。浏览器正常访问仍会触发既有保存/对账，不宣称零写入。

门禁：完整npm test 2830通过/2可选PG跳过；最终命名2项、architecture、build、diff通过。**剩余：删除恢复、阅读位置、补图/取消旧卡及取消反馈、真实指定图编辑、实体触屏**。本 checkpoint 不表示全部问题已修复或具备发布条件；此前历史绿灯不覆盖这些新失败。

### CP-I1-REAL-1 · 2026-09-06 11:02 CST · 真实生图与本地上线前检查

- 用户明确授权真实生图，本轮控制为1张、不带私有引用；原项目 `project-1788499314489` 新建验收会话 `agent-session-2d7d6a26-9926-4ebf-9085-b5757d3a8022`。只新增验收对话、任务及结果，没有改产品源码、原始图片、Provider配置或数据库结构；保留原有dirty工作树。
- 真实规划Turn `turn_97ab00e1d374bb45fd2bffc2c19e9b81` 产生可确认计划；浏览器核对GPT Image 2、1:1、1K、1张后只点一次生成。请求为米白背景绿色银杏叶，无历史引用；Job的`referenceBindings=[]`。
- Run `agent_run_fafsJXshnKeQ3BdoR-ygIC0QkF-OxqObsJjV09WNljM` 为completed；Job `job_vDGqXPozXaPn2EDzA_-dJW0y_Zm_ux0JoE2COB_uEuQ` 为succeeded，唯一output和唯一Provider attempt，effectiveModel=gpt-image-2。界面出图用时23秒；内部usage为outputCount=1/costUnits=1，不能当作供应商货币账单或精确费用。
- 画布存在唯一对应result节点，节点媒体与Job输出SHA256一致：`ba9ffc3d4288880dd4d318bdb8d9008da9c1cbfb704ec31c727f28f6cde8c153`。Artifact `generation:job_vDGqXPozXaPn2EDzA_-dJW0y_Zm_ux0JoE2COB_uEuQ:job_vDGqXPozXaPn2EDzA_-dJW0y_Zm_ux0JoE2COB_uEuQ-output-1` 的runId/jobId/sourceNodeIds指向该任务及节点；inline模式索引不持久化图片URL，由现有投影从画布补媒体，未把空URL误判为无结果。
- 原生浏览器检查：聊天、画布和详情图片均实际解码1024×1024；任务→查看结果显示生成结果3/工具0。定位选中本次唯一节点；继续修改只准备本次1张图与草稿，完整刷新后两者保留。随后通过键盘移除本轮引用并改为纯文本验收，未发起第二轮图片编辑。新文本Turn `turn_262f3d79a42ff4aa1d12ec1e17f2cd2b` completed，回复“验收通过。”，未新增Run/Job。
- 真实等待期间出现“正在规划…”且内容到达后消失；当轮用户/生成中Assistant无分隔线，完成后Assistant仅1条1px线，最新Bob仅1个；最终文本有操作区。643×784实际视口无横向溢出。本轮没有在等待短窗口采样到Shimmer渐变帧，动效/减弱动态依据既有CP-H1验证和当前组件接线，不把静态文字截图当作扫光证明。
- 确认所有任务终态后，原API PID66371停止15秒并按原配置启动为69321；界面显示正在重新连接、现有结果仍解码，恢复后已保存。随后完整刷新，检查原图与新图恢复，原任务不重建。最终原项目30个Turn、3个Run、3个Job、3个Artifact；新结果节点仅1个，生图attempt仍为1。原两个Job身份/状态/outputs指纹仍为 `1a707aaba5063b5ceed059fcb1f0daf02ce7218aa20cf57d296dff2204138e67`。
- 代码身份与上一完整门禁相同：HEAD `7810a84ba4be744227fa013c3e5de179441393bc` + dirty，src/server清单SHA256仍为 `107a1d73f0f26854c1a83238e090d66b0c9ce7895e0d7c2820311e39f3613847`；沿用同源码2828通过/2可选PG跳过、architecture/build证据，不重复构建。补跑eval/security/Chromium及diff；原项目正常流程Console error为空。隔离E2E临时4182服务已停止，4173/8787保留。
- **发布未放行**：当前health为configured=true、queue=local-prototype、media=inline-prototype，文件ProductStore不是共享数据库/独立Worker证明。3个未提交SQL迁移（20260904234954确认一致性、20260905004125 JSONB优先级、20260905065929部分输出重试）须按既有兼容矩阵在获授权的staging验证，不能按纯前端发布处理。18个隔离UAT本轮未运行；真实付费多图/失败补图/取消计费/图生图效果、共享服务恢复及跨设备仍不由这1张成功图证明。真实触屏/软键盘未验；未提交、推送、部署或执行共享迁移。
- 非阻塞UI观察：三个任务仍同名“根据文字描述直接生成1张图片”，结果均名“新图”，只能依时间/缩略图辨认；可用但缺少内容辨识度。本轮按验收范围记录，不顺手扩大实现。

### CP-I1-ORIGINAL-2 · 2026-09-06 10:27 CST · 修复1–4并完成原项目恢复回归

- 仅修改4个产品文件：房间物化媒体保留、媒体分类纯展示判断、结果面板缺媒体状态/无效操作保护、HTTP不可读响应文案与错误分类；另扩展2个既有测试文件及本记录。保留全部原有未提交修改，无依赖、协议、Store schema、Provider或权限改动。
- 回归先失败后通过：HTTP权威图谱的inline图片、服务端回写→epoch 2重建→协作移动的inline图片原位保留；同一房间Yjs快照仍不含媒体字段，原有恶意媒体/外链/二进制清洗与幂等测试通过。只在已验证的权威asset/result节点保留现有本地媒体格式，不给客户端CRDT增量开口子，不把图片写入Agent消息/Artifact索引。
- 缺URL的image/video保留媒体类别，列表和详情显示“媒体暂不可用”，不显示Aa、不发起空地址下载/入库/继续修改；无图片的结果节点不能进入下一轮批量操作。该缺地址分支以实际共享分类函数及附件投影回归覆盖，未修改原项目Artifact制造故障。
- 原4173前端载入新构建，确认8787无在途任务后，对原PID59854停止30秒并按同一配置自动启动为66371。期间真实点击历史“恢复本轮”只读核对失败，显示“工作区服务暂时无法连接，请稍后重试。”，验收草稿保留；服务恢复后已保存，两张原图均解码960×1280，没有等待占位。未在服务恢复后重放失败模型请求。
- 原项目 `project-1788499314489`：生成结果2、工具产物0，原Task详情→查看结果→预览→定位选中原Run结果节点；继续改只准备一张所选原图引用及草稿，未发送。随后移除本次测试引用、通过键盘清空本次草稿；没有清理其他会话原有引用。
- 完整刷新后两张画布图仍解码，原生图会话中关联Run的消息内直接显示原图及定位/继续修改按钮；仅最新Assistant有Bob，终态分隔线为1px，用户消息没有线，当前551px视口无横向溢出。截图实际查看；新载入页面控制台error为空。没有用静态历史冒充新生成中的状态，本轮不重复先前三档/200%或假Provider运行态证据。
- 原项目28 Turn/2 Run/2 Job不变；本轮按Job ID/状态/outputs序列计算SHA256前后均为 `1a707aaba5063b5ceed059fcb1f0daf02ce7218aa20cf57d296dff2204138e67`，原图片未变，没有重复生成。正常浏览器操作仍可触发既有保存/对账，非“完全零数据库写入”。
- 21项房间/清洗聚焦及5项附件/索引聚焦通过；全量2828通过、2可选PG跳过；architecture/build/diff通过。当前src/server已跟踪及未忽略文件SHA256清单再哈希为 `107a1d73f0f26854c1a83238e090d66b0c9ce7895e0d7c2820311e39f3613847`。无提交、推送、部署、共享迁移、真实付费生图。

### CP-I1-ORIGINAL-1 · 2026-09-06 09:42 CST · 原项目验收未通过，图片可恢复但不稳定

- 本次只做用户要求的验收与诊断。实际页面为4173原项目 `project-1788499314489`，后端8787、文件持久化与inline媒体；不是隔离PG/假媒体环境。未发送新Prompt、调用真实Provider或修改产品源码。使用浏览器技能实际操作；diagnosing-bugs技能要求先建立失败断言，再以纯内存房间复现，未绕过媒体清洗规则修数据。
- 历史消息通过：当前会话24条消息，只有最新Assistant有Bob；12条用户消息均无分隔线，12条终态Assistant各有一条1px线；正文14px/22.4px，918px当前视口无横向溢出。两段历史执行记录为18秒/9秒，展开后成功步骤默认折叠且显示独立用时。未用静态历史证明本轮未触发的实时生成状态，也未重复已有三档/200%验收。
- **未通过一：inline媒体恢复。** 初次载入与同步后，画布结果变成等待占位；两个已完成Run的结果区显示生成结果0。权威Job的两份 `outputs[].image` 仍在（约2.2M/2.7M字符data URL），不是Provider无结果或原图永久丢失。只读内存复现调用实际 `createCanvasCollaborationRoom`：同源稳定媒体保留为true，inline媒体保留为false，保留图片断言失败。`persistableNode`调用媒体清洗器会移除data URL；Artifact生成投影对inline输出刻意不保存url，再由本地画布补URL，因此这条组合路径存在缺口。不得把图片字节塞进CRDT日志或放宽外部媒体授权来修复。
- **未通过二：缺媒体的分类与反馈。** 索引只读重试成功后，两个kind=image且origin=generation_output的记录被显示为“工具产物2”，预览为Aa；`AgentUtilityPanels.isMediaArtifact`把有无url当成媒体种类，导致“查看结果”落到生成结果0。此时任务还使用“结果整理中”或“正在放到画布”文案，未明确表示媒体暂不可用。应保持生成产物语义，独立表达媒体读取/恢复状态，不重建生成任务。
- **真实断线保护通过。** 演练前原项目28个Turn、2个Run、2个Job全终态。8787原PID58222停止20秒后按原配置自动启动为PID59854。期间点击历史“恢复本轮”，只读核对失败、按钮恢复可操作、未发送的验收草稿保留；服务返回后显示“已保存”，原任务列表身份与状态不变。三类实体数量不变，两个Job身份/状态/输出的SHA256前后均为 `38306f303cbb4eabbd5039a900a31c959638f15054b39895bfad16e717f72b66`，没有重复生成。离线错误当前显示“工作区服务返回了无效响应”，可用但不够准确；未在网络恢复后点击可能触发模型重试的失败回合。
- 完整刷新并重新对账后，两张历史图恢复到画布及“生成结果2/工具产物0”，均实际解码960×1280；结果详情的定位按钮选中原Run对应的既有节点。故准确结论是“协作恢复期间暂缺、刷新可恢复”，不是永久丢图，也不能因为最后显示正常而抹去前面的失败。刷新仍恢复原会话与阅读位置；演练草稿已通过实际键盘清空，未发送。最初等待“已保存”超时是刷新后面板默认关闭，重新打开Bob后正常，不记作服务故障。
- 当前源码指纹仍为 `a019d129043f94926e7f036d2dc4b4964aa1f8e0bdc60047a59a68616c41ca0c`，与既有2826项门禁一致；本轮失败是先前验收未覆盖的本地inline组合边界，不能用旧绿灯销项。没有重跑全量或修改用户数据记录；浏览器正常操作触发既有对账/保存，Job原图始终保留。进度不升为18/18，无提交、部署或共享迁移。

### CP-I1-RUNTIME-1 · 2026-09-06 09:28 CST · 原本地运行栈已加载修复

- 恢复原 `localhost:4173` 构建预览，使用现有已验证的 dist，没有重复构建或启动另一套用户项目。首页 HTTP 200，`4173/api/health` 代理 HTTP 200。
- 重载前核对8787原进程PID95646的命令、工作目录和实际文件持久化路径。仅检查任务状态元数据：3个GenerationJob（2成功、1失败）、31个Turn（25完成、5失败、1取消）、3个Run（2完成、1失败），ReviewTask/Subagent/Activation均为0，无在途任务；没有读取或输出访问令牌、消息正文或其他凭据。
- 对该进程发送SIGTERM并确认监听退出，再以相同 `npm run server` / 原环境启动；新PID58222已监听8787，`/api/health`返回ok，继续使用文件持久化与本地队列。重载后上述实体数量与状态完全一致，没有重新生成或清理历史数据。此前“用户8787尚未载入修复”的运行栈缺口现已关闭；不以隔离8789的证据替代它。
- 内置浏览器原标签完整刷新后，旧“无法连接工作区服务”页面已消失，但仍未登录。保留原项目深链并打开登录入口，已请用户在该浏览器自行登录；不读取浏览器凭据/会话存储、不注入测试身份。原项目Bob/分隔线/用时与恢复组合的最后交互验收因此仍未完成，F1服务中断与任务定位整体验收也未销项。
- 本轮仅调整本地进程并更新此记录，产品源码未改；沿用既有2826项通过、构建与架构门禁，不重复已通过检查。本地实现保持17/18，不宣称整体或发布完成；没有提交、推送、部署、共享迁移或调用真实生成Provider。

### CP-I1-BG-1 · 2026-09-05 20:10 CST · 引用采用与历史执行记录整页收口

- 上轮分类：有实质进展。本轮只补明确缺失的B/G整页证据，没有重新开发已正确的组件、重建本地栈或重复全量门禁。
- 扩展既有 `e2e/uat-agent-results.spec.ts` 两条用例，沿用Playwright和现有登录/项目入口。初次失败分别是测试未打开标题菜单、把首段流式文字当成终态、把弹层链接的标题当成可访问名称；核对实际DOM与独立Turn后修正测试，未将这些测试假设误改成产品缺陷。
- 引用主路径：在隔离 project-1788601140292 新会话实际上传两张图片，真实本地API/Worker/PG与既有假模型完成只读回答。界面两项均显示“请求含图片描述”；独立Turn终态为completed、持久references事件两项submitted，白名单无媒体URL/图片/caption原文；刷新后从历史事件还原，默认折叠且可键盘展开。
- 引用关键失败路径：仅在浏览器历史GET响应把第二项改为network失败，不写数据库。整页从摘要识别一项未采用；点击该项重试，真实 `/agent-references/prepare` 请求只含其节点ID，成功显示“已重新准备 · 未发送”；第一项仍保持本轮已采用，没有新的Turn/Run/Job POST。此失败注入不冒充真实媒体网络故障，也不声称假模型理解了图片。
- 执行记录与来源：完整项目页面经只读消息/Turn事件夹具验证真实事件边界投影为整轮17秒、步骤5秒；删除时间证据后显示“执行记录”/“用时 —”，不使用页面加载时间。成功步骤默认折叠，用户收起后编辑草稿不抢回；无真实恢复标志时不渲染“已恢复”，正文合法 `(role: 商品)` 保留。
- 三条来源记录包含同域不同路径、必要query和重复URL；最终只出现一个引用入口，弹层两条可访问链接保留完整URL。Enter打开、链接可聚焦、Escape关闭且焦点回到原按钮。现有组件/领域的实体定位、并行/分页、失败/确认自动展开和attempt隔离证据继续保留，不用本条静态历史夹具代替实时状态验证。
- 两项整页19.8秒通过；随后增加单项准备失败边界，仅复跑改变的引用用例，17.5秒通过。截图已核查：`/private/tmp/botanic-agent-recovery-uat.0NZvAD/reference-activity-final/` 与 `/private/tmp/botanic-agent-recovery-uat.0NZvAD/reference-reprepare-final/`。测试采用真实本地服务、假外部模型；G与失败状态使用只读响应夹具，用户项目未写入测试消息或图片。
- 产品源码指纹仍为 `a019d129043f94926e7f036d2dc4b4964aa1f8e0bdc60047a59a68616c41ca0c`，对应既有2826项通过、构建/架构通过；本轮只改验收文件与此记录，`git diff --check`通过，不重复已有门禁。
- 原用户预览4173与8787均有真实监听，允许本机网络后health为ok，文件持久化/本地队列。内置浏览器原项目实际停在访问令牌登录页，无法核对原项目当前运行任务或安全重载8787；已明确请求用户在该浏览器登录，没有读取令牌/会话存储或换测试账号绕过。8787原进程未动，不能把隔离8789的验证说成原后端已加载修复。
- 保持17/18，I1等待原项目登录后的本地收口，不计100%；不提交、推送、部署、迁移、真实付费生成或清理数据。共享环境与物理设备仍单列，不作为本地开发拖延理由。

### CP-C1/H1-5 · 2026-09-05 19:50 CST · 大快照握手、几何恢复与停止闭环

- 上轮分类：有实质进展，两项结果修复和失败证据已改变后续工作。本轮沿原“正在同步”阻断检查；未重新搭建环境或重做A–I审计。
- 真实只读协议复现：隔离API发出 `canvas.sync.ready.v2`，frameBytes=944334、updateBase64长度=944176、graphRevision=339；现有 `parseProjectRealtimeEvent` 返回false。握手已到达而UI一直同步，是完整文档误套单次增量700KB上限，不是没有网络连接。
- `realtimeSync.ts` 将完整握手快照限制独立为32MiB，与现有文档请求上限一致；普通增量继续700KB，保留projectId/schema/epoch/Base64验证和握手前禁止Outbox重放。没有修改协议字段、幂等键、持久化形状或权限。944KB有效快照、同大小增量拒绝、超32MiB快照拒绝的既有测试扩展先红后绿。
- 握手恢复后实际停止触发白屏；浏览器记录 `Cannot read properties of undefined (reading 'x')`。定向诊断捕获原节点位置为 `{x:1380,y:-172}`，远端geometryChanged=true但几何段为空；此前投影丢弃了必需position。浏览器和服务端materialize共同保留该节点最后有效位置，仍应用其他几何/配置变化，不添加默认坐标或改变布局。两侧回归先失败后通过，临时 `[DEBUG-sync-position]` 已移除。
- 停止验收改读独立Job API：文档中的generationJobs是可能过期的兼容镜像，不能用running镜像否定实体已cancelled及真实Worker ACK。用例仍要求唯一原Run/Job、实际派发、signalRequired=true、workerReleased与signalAcknowledgedAt、旧节点媒体保留、无重复生成、无pageerror；未放宽为“任意终态就通过”。
- 同源码原项目整页验收：`sync-position-final` 两项26.4秒通过（确认回包丢失恢复；迟到Run+取消回包丢失+两次刷新）；`sync-controls-final` 一项5.3秒通过（故意扣留三次握手后阻断、重试、实际INVALID_UPDATE、双入口重试、保留Outbox至ACK）。截图已核查，Agent头部恢复“已保存”。这些是实际本地API/Worker/PG，图片服务为既有本地fake，不是付费模型效果证明。
- 最终源码：HEAD `7810a84ba4be744227fa013c3e5de179441393bc` + dirty；src/server逐文件SHA256汇总 `a019d129043f94926e7f036d2dc4b4964aa1f8e0bdc60047a59a68616c41ca0c`。62项聚焦、2826项全量通过（2可选PG跳过），architecture/build/diff通过。日志前缀 `/private/tmp/botanic-agent-sync-final-`，浏览器证据在 `/private/tmp/botanic-agent-recovery-uat.0NZvAD/` 对应上述目录。
- 只重启了已核对终态任务的隔离8789 API，以加载服务端修复；PG55433、假图片4797计数和4799媒体均保留。恢复了4173构建预览，首页与原 `/api/health` 代理均200；用户8787进程未重启，不把它声称为已载入服务端修复。没有提交、推送、部署、共享迁移、数据清理或真实生图。
- 进度仍17/18（94%）。本次同步与白屏阻断已销项；I1只保留下方尚未完整证明的应用交互与用户运行栈加载边界，不再重复这三项已通过场景来充当进展。

### CP-A2/E1-1 · 2026-09-05 19:21 CST · 确认身份恢复与输出去重

- 已复现并修复：服务端已完成 Run，但创建回包丢失使计划消息无 runId，刷新不展示图片且仍能看到确认。`mergeAgentMessages` 在展示投影中复用冻结分支身份，或同一唯一权威 Turn 的 Run；有显式其他 Run、Turn 冲突或多候选时不猜测。不改变提交幂等键、Store schema 或数据库数据。
- 已复现并修复：远端已有图但缺 candidateId，刷新投影额外创建 `result-job-output` 节点，聊天又将两个节点当作两个 Artifact。共享 `generationResultOutputId` 仅在同一 Job 内唯一媒体匹配时恢复输出身份；投影复用已有节点；结果合并按 Job+output 身份去重并保留全部节点来源。不按全局 URL 合并、不删除历史节点或媒体。
- 两条既有测试扩展先失败后通过：缺输出 ID 时不得新增重复结果节点；历史别名只显示一个结果，同 Job 多输出共用 URL 时不猜测身份。136 项聚焦检查通过，覆盖消息合并、计划提交、恢复、输出投影与消息持久化既有边界。
- 最终应用源码标识：HEAD `7810a84ba4be744227fa013c3e5de179441393bc` + dirty；`src/server` 文件清单逐文件 SHA256 再汇总为 `79594a99cf1e9c61da8d526f9a5c59e64bb49ecda92bb1c5a9bdd7f7619a8d0e`。全量测试 2824 通过、2 可选 PG 跳过；architecture/build/diff 通过。日志前缀 `/private/tmp/botanic-agent-receipt-final-`。
- 同源码浏览器确认恢复通过：实际 API/Worker/PostgreSQL，只有模型与媒体服务为本地 fake；确认回包503后刷新，同一Run、一张新图、一次生成、原节点/媒体不变，图片可解码。截图已核查：`/private/tmp/botanic-agent-recovery-uat.0NZvAD/receipt-exact-turn-final/uat-turn-recovery-计划确认回包丢失后刷新：恢复原Run结果，不重建任务或重开确认-chromium/plan-receipt-restored.png`。红色图片是隔离假图片内容，不是实际模型出图品质证明。
- 测试修正与失败均保留：反复运行使历史分页增加，`.last()` 曾选中刚载入的旧计划；现按实际 POST 输入与原 Turn 定位，旧图保留由原节点/URL验证，不将当前分页数量误作全历史数量。曾尝试的控件禁用和计划写入改动没有证明该症状，已撤销，不纳入交付。
- 最新停止回归仍失败：`stop-ready-exact-turn` 中隔离项目进入后20秒未出现“已保存”，停在“正在同步”，尚未发起新Turn/Run；早先同源码停止回归13.6秒通过，但不能覆盖这次失败。原因尚未确认，I1 保持部分；不将其武断归因于测试环境，也不修改同步安全门禁来使测试通过。
- 本轮没有提交、推送、部署、共享迁移、真实付费生成或历史数据清理。总体本地实现仍17/18（94%）；后续只需针对上述同步就绪阻断做有界核查，不重复A–I审计和全套环境搭建。

### CP-F2-2 · 2026-09-05 18:39 CST · 停止交接、丢失回执恢复与中性终态

- **实际修复一**：整页复现Run/Job已取消且Worker durable release已确认，但刷新后仍提示「取消未完成」。`cancelAgentRun` 把 `refreshDocumentFromRemote() === false` 当成失败；该布尔值也表示同版本快照无须应用。现在以深取消服务返回的明确空 failures + Run终态确认已处理，不再依赖画布必须更新版本。Worker ACK待定、服务端失败以及旧服务缺少回执的保护保留；不修改画布冲突规则、取消fence或服务端持久化。
- **实际修复二**：截图查到主动取消被映射成红色「出图失败」。Run取消分支现在复用既有中性 aborted 展示；生成显示「已停止 / Stopped」，普通未启动工具仍显示「未执行」，既有成功分支保持成功。可见文案与ARIA状态同步，未新增状态字段或UI库。
- 复用 `e2e/uat-turn-recovery.spec.ts`：真实本地API/PostgreSQL创建Run后扣住回包，明确等假Provider已接到请求，再点击Stop并从独立Message API核对持久停止意图；取消回执持续503覆盖客户端自动重试，恢复网络并刷新后只接续同一Run取消。最终9.7秒通过：创建请求1次、Run身份唯一、取消目标不变、Job取消和要求的workerReleased/signalAcknowledgedAt均成立，历史图片不丢，二次刷新假生成计数不增长，页面显示已停止而非出图失败。
- 两项聚焦断言先红后绿；最终46项相关检查通过，全量2823通过/2可选SQL跳过，架构、构建、diff通过。`AgentConversationMessage.tsx` 仍1442行，没有增加冻结预算。
- 测试准备中纠正了兼容文档不含独立消息、历史未提交计划抢先匹配、空结果节点不等于历史图片、客户端503自动重试，以及Worker未派发时无release回执的前置条件。失败产物保留在stop-handoff系列目录；不把测试前置条件错误记成产品回归，也不降低Worker ACK断言迎合测试。
- 证据：`/private/tmp/botanic-agent-recovery-uat.0NZvAD/stop-worker-ui-final`，其中 `run-handoff-stopped.png` 已查看；最终全量日志 `/private/tmp/botanic-agent-stop-ui-final-tests.log`、聚焦 `/private/tmp/botanic-agent-stop-focused.log`、构建 `/private/tmp/botanic-agent-stop-build.log`。只创建/取消隔离测试任务，保留历史图片与测试记录；未调用真实Provider、部署或提交。
- 本轮2/2完成；整体仍17/18，本地最终集成审查I1尚未全部收口，不宣称全方案或上线验收完成。

### CP-H1-4 · 2026-09-05 18:10 CST · 原生200%浏览器缩放与附件键盘

- 使用已安装Playwright Chromium、新临时配置和仅允许127.0.0.1的最小扩展，通过原生 chrome.tabs.setZoom(2) 操作测试标签；没有修改CSS zoom、缩小截图、安装用户浏览器扩展或修改产品代码。方法依据 [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom) 与 [Playwright扩展测试](https://playwright.dev/docs/chrome-extensions)。
- 最终整页4.0秒通过：getZoom返回2，innerWidth从1440变为720，devicePixelRatio从1变为2；面板与页面无横向溢出，输入字体≥16px，输入栏和移除按钮命中盒≥24px且在面板边界内。粘贴两张本地测试图后，Enter逐个移除引用，焦点依次到相邻移除按钮和添加入口，未提交草稿保持。
- 最初启动失败源于Playwright既有deviceScaleFactor与viewport:null不兼容，改成1440×1000初始视口后仍验证实际原生缩放和重排；没有把设置720视口冒充200%缩放。初次失败保留，不记为产品故障。
- 证据及可复跑扩展在 /private/tmp/botanic-agent-zoom.vHITWo；browser-zoom.log 为1 passed，browser-zoom/uat-agent-results-原生200-浏览器缩放后，输入与双附件可操作且无溢出-chromium/browser-zoom-200.png 已查看。测试位于既有 e2e/uat-agent-results.spec.ts，需显式 UAT_ZOOM_EXTENSION；浏览器上下文已关闭。仅新增隔离测试附件，不删除画布或媒体、不生成、不操作用户浏览器。
- 这里证明本地Chromium原生缩放与键盘，不代表物理触屏、软键盘或系统设置操作。应用代码未变，不重复构建和全量测试；diff检查通过。H本地主链路已验，其他I1恢复缺口仍保留，总进度17/18。

### CP-E2-2 · 2026-09-05 18:10 CST · 同ID更新、旧页保护与首页缓存

- 在隔离项目真实完整页面上，以实际Artifact和两张可读取媒体为基底，受控HTTP响应依次提供旧版、同ID较新版和较旧分页。没有修改数据库、生成状态或Artifact持久化记录。
- 3.1秒通过：较新标题与图片URL被缩略图/预览采用，较旧分页不回退；同ID只有一个条目，两项已加载历史没有重复。关闭并重新打开Agent触发首页请求，首页只返回新版条目，已加载历史仍保留；真实媒体解码通过。
- 用例加在既有 e2e/uat-agent-results.spec.ts，需 UAT_ARTIFACT_UPDATE_FIXTURE=true；普通运行跳过，不创建新框架。两项既有索引逻辑测试通过，diff通过；应用源码无需改动。
- 证据：/private/tmp/botanic-agent-artifact-version.log、/private/tmp/botanic-agent-artifact-version-tests.log；截图 /private/tmp/botanic-agent-recovery-uat.0NZvAD/artifact-version/uat-agent-results-同ID结果更新可见，旧分页不回退，首页刷新保留已载入历史-chromium/artifact-version-retained.png 已查看。此处为整页HTTP版本投影验证，不冒充共享数据库并发更新。

### CP-E3-4 · 2026-09-05 17:57 CST · 指定图片实际提交与原结果保留

- 上一轮 CP-C2-1 属于已验证进展；本轮只补 E3 原先未发送的继续修改路径，沿用 Playwright 和 diagnosing-bugs 的反馈循环，没有改应用源码或扩大全仓审计。
- 首次整页检查在“无法安全读取原目标图片”处停止。查到隔离 start-api.mjs 显式 AGENT_VISION_MODEL=''，而主模型是文本模型；同一媒体 GET 200、Composer 所选 URL 正确。因此是测试环境未配置视觉，不是图片丢失或目标串图，保留产品 fail-closed 校验。核对隔离库全部 Run/Turn/Job 均终态后，仅重启8789测试API，启用既有本地假视觉响应；4799媒体服务、4797假图片服务、数据库及用户4173/8787均未重启。
- 最终完整页面6.2秒通过：在 project-1788601140292 选择对话第二张结果，Composer 只引用其真实 URL；发送续作指令，修改计划输出为1张并实际确认。真实 API/PostgreSQL 的新 Run/Job 完成，结果 generationRecipe.references 与 referenceBindings.mediaId 精确指向所选媒体，contextSnapshot 包含对应节点；所有原节点ID及图片URL不变。假图片调用只增加1次，整页刷新后新旧图片数量正确、逐张 naturalWidth>0，调用数不再增加。
- 测试中另纠正两个断言错误：公开 Job 快照不含 recipe，应核对实际结果的 generationRecipe；消息未载入前的 count() 会返回0，应等待原结果集后比较。不改产品数据形状或放宽断言来迎合测试。
- 在既有 e2e/uat-agent-results.spec.ts 增加一条完整主路径；需要显式 UAT_FAKE_GENERATION、本地服务和隔离项目，普通测试默认跳过。20项现有媒体/消息/索引检查通过，diff检查通过。应用源码未变，不重复构建或全量测试；构建依据仍归上一CP。
- 证据：/private/tmp/botanic-agent-selected-result-final.log、/private/tmp/botanic-agent-selected-result-tests.log；截图 /private/tmp/botanic-agent-recovery-uat.0NZvAD/selected-result-final/uat-agent-results-指定第二张结果提交新版本，原图与历史结果保持不变-chromium/selected-result-submitted.png 已查看。前面的配置/测试断言失败分别保留在 selected-result-submit、selected-result-vision、selected-result-verified。
- 边界：假模型固定返回 initial_generation，本例证明选定图片能进入真实参考生成配方、绑定和结果恢复，不证明真实模型会正确理解每种编辑指令或生成质量。复测新增的本地假版本全部保留，没有删除、覆盖、提交、推送、部署或共享迁移。本地实现仍17/18；E2同ID更新与其他I1缺口继续保留，不借本例宣布整体完成。

### CP-C2-1 · 2026-09-05 17:44 CST · 已完成结果待回写与生成恢复

- 只收口 C2，不重跑全仓审计。先复现：行动已有成功回执、仅等待画布写回，UI 却显示“执行状态待确认 / 确认状态”。在既有消息渲染里按 canvasWritebackPending 区分“结果已完成，等待画布同步 / 等待回写”，按钮改为“继续回写”；同步仍为 reconnecting/syncing/blocked 时禁用。AgentWorkspace 传入现有同步状态，不新增权威状态、网络接口或持久化字段；两个冻结模块行数未增长。
- 第一条完整页面检查通过，修复后单跑6.7秒、随后组合运行再次通过：向隔离项目添加标明 UAT 的文本节点和已完成行动回执夹具，真实生命周期/Store/同步/persistence 运行。同步未恢复时不创建缺项节点，草稿保留；恢复后读取同一回执，仅新增第二项，已写入第一项不重复；整页刷新仍已执行，状态读取共2次、外部行动执行0次。成功回执是受控夹具，不冒充真实外部工具执行。
- 第二条检查通过：新建隔离项目“创意项目10”，真实 API/PostgreSQL 创建双图 Run；暂缓真实 WebSocket ready 回包，Run 仍完成，实际 Artifact Index 有两项。恢复握手和整页刷新后两张本地假图片均可解码，结果节点 ID 集合不变、生成调用数只增加2次且不再增长，草稿保留。未改生成/回写实现，既有权威链路通过验证；本地测试 API 内执行器不等于独立 Worker。
- 第二条首次组合检查停在错误的 execute 请求拦截点；服务端在创建 Run 时已自动提交，假计划固定为双图。修正测试为暂缓真实创建请求和双图计数后通过，没有修改产品逻辑迎合测试。最终运行已结束，generation-writeback-verified/.last-run.json 为 passed、failedTests 为空；不因终端输出丢失重启测试。
- 113项既有行动/消息/画布检查通过，architecture、build（5.77秒）和 diff 检查通过；没有重复全量 npm test。用例保留于 e2e/uat-agent-writeback.spec.ts，普通运行默认跳过；生成用例另需显式本地假 Provider 开关与地址。
- 证据根目录 /private/tmp/botanic-agent-recovery-uat.0NZvAD：writeback-both 下 writeback-awaiting-sync.png、writeback-recovered.png，以及 generation-writeback-verified 下 generation-completed-during-sync.png、generation-after-sync-reload.png 均已逐张查看。红色图片是已解码的本地假图片，不是加载失败占位。日志为 /private/tmp/botanic-agent-writeback-tests.log、/private/tmp/botanic-agent-writeback-build.log；最初失败证据保留在 writeback-red 和 writeback-both。
- 本地实现仍17/18（94%），本轮两个回写场景2/2已验；I1其他未验项不虚报完成。仅新增隔离测试项目/文本节点/假图片，未删除或清理用户数据；用户4173服务未重启。无提交、推送、部署、共享迁移或真实 Provider 调用。

### CP-C1-3 · 2026-09-05 17:20 CST · 重试保留失败原因与真实同步确认

- 上一轮结果链路已有代码、浏览器与 checkpoint 进展，本轮补 C1 未验主链路，不重新全仓审计。使用既有 Playwright/diagnosing-bugs 流程；仅连接隔离 4176/8789/55433 及 project-1788596122078，未触碰用户原项目。
- 无故障真实握手基线2.2秒通过。随后在测试 WebSocket 代理暂缓真实 ready 回包，以 Playwright 时钟推进既有三次30秒截止（不是实等90秒、也未修改产品超时）；头部显示可操作超时原因，点击重试后真实握手恢复，2.9秒通过。
- 完整流程首次两次中断分别是测试按钮名称错误、画布新增节点正常关闭 Agent 后未重新打开；已修测试，不作为产品故障。随后证明“收到第一条 ACK 仍 blocked”是队列还有第二条失败项，保留 blocked 正确；真正缺陷是共同重试入口先清空具体错误，而相同失败状态被正常去重，不再补回原因。
- 在已有 canvasRealtimeRetry 测试锁定发起重试即丢原因的失败，再仅删除共同入口对 realtimeRetryError 的提前清空。现在由实际协作状态更新清除已恢复的错误，或由新的 reject 覆盖为新原因；保留双入口去重与项目/实例隔离。不改变 Outbox 一项一项恢复、mutation 身份、ACK、epoch、持久化或权限协议。
- 最终浏览器用例3.8秒通过：新增一个未执行空白节点；测试代理损坏传输包，由真实服务端返回 INVALID_UPDATE，原有效增量留在 IndexedDB；错误未恢复时重试仍保留具体原因和草稿。恢复代理后通过 Agent/Canvas 两入口接续原 mutation，多条失败项全部恢复前不假成功。暂缓真实 durable ACK 时，API 已能读到新节点、Outbox 仍非空、头部为保存中；放行 ACK 后 Outbox 为0、头部已保存，草稿不变。没有点击生成或删除任何节点。
- 16项已有同步状态、共同重试、Outbox 检查通过；build 5.68秒、diff检查通过。不重复全量测试或架构审计，应用仅一行本地交互状态变更。测试为 e2e/uat-agent-sync.spec.ts，需 UAT_ACCESS_TOKEN、UAT_SYNC_PROJECT_ID、UAT_SYNC_MUTATION=true 与本机 URL，默认跳过。
- 最终截图位于 /private/tmp/botanic-agent-recovery-uat.0NZvAD/sync-ack-fixed/uat-agent-sync-Agent-同步状态跟随真实握手和待确认增量，不因点击重试假成功-chromium/：sync-awaiting-ack.png、sync-recovered.png，均已实际查看；失败队列证据在 sync-ack-evidence 同名用例的 trace.zip。构建日志 /private/tmp/botanic-agent-sync-checkpoint-build.log。隔离项目保留复测新增的空白节点，未自动清理。
- 边界：实际握手/API/PostgreSQL 与服务端拒绝已运行；网络故障由代理注入、截止时间由测试时钟加速，不是共享网络或真实权限变更。生成结果延迟写回、跨项目完整同步竞态仍待验，本地实现维持17/18。无提交、推送、部署、共享迁移或真实 Provider 调用。

### CP-E3-3 · 2026-09-05 17:02 CST · 迟到页隔离、删除后恢复与更多结果入口

- 跨项目浏览器验证通过：取得 A 的真实 Artifact API 响应后延迟交付，切换至空索引的 B 再释放；B 无 A 的结果、无索引错误，返回后草稿保留。现有 abort/作用域保护有效，无需修改应用逻辑。
- 实际删除链路在本机隔离项目 project-1788590724487 通过（5.5秒）：定位一个假生成节点，聚焦后使用节点原有删除按钮，等待 API 确认删除并整页刷新。原 Artifact 与图片仍保留，详情无失效定位按钮；下载文件成功，“继续改”恢复为素材引用且媒体 URL 一致，假生成次数不变。移除的是测试画布节点，未删除图片或历史 Artifact；恢复的是素材能力，不声称原节点 ID 被恢复。
- 发现并先复现另一处 UI 遗漏：消息已载入少量结果、索引尚有历史页时，“查看更多结果”不显示。仅修改 AgentConversationMessage 两行条件/文案，复用已有结果面板及分页入口；未知总数不显示虚假精确数量，索引读完后沿用“查看全部 N 项”。没有新增状态或 API，冻结行数预算不变。
- 最终改动验证：20项消息/索引/导航检查通过；三项非删除浏览器用例8.8秒通过（迟到页隔离、第101项失败重试、返回上下文及更多入口）；build 5.96秒、architecture、diff检查通过。没有重复全量 npm test；最近完整2823项结果仍归 CP-C1/F1，不拼接成新一轮全量结果。
- 删除验证发生在这次两行 UI 修复之前。修复后的再次删除复跑被权限审查拒绝，未执行，也未换方式绕过；后续如需重复删除，须先获得覆盖具体隔离节点及恢复后果的明确授权。最终三项检查不含删除，不能合称最终构建四项全通过。
- 证据目录 /private/tmp/botanic-agent-recovery-uat.0NZvAD：result-delete-focused.log 及同名截图/下载/trace目录、result-more-red.log、result-safe-final.log 及同名trace目录；单元与构建日志为 /private/tmp/botanic-agent-result-closure-tests.log、/private/tmp/botanic-agent-result-closure-build.log。未将截图存在等同于额外人工视觉验收。
- 保留17/18本地实现口径与未验项；本机假服务验证不代表真实 Provider、独立 Worker 或共享环境通过。没有提交、推送、部署、共享迁移或付费生成。本地收尾不再重复审计或扩大到发布流程。

### CP-E3-2 · 2026-09-05 16:35 CST · 返回阅读位置、历史分页与缺失节点继续修改

- 上一轮首次消息修复是实际进展，本轮沿 E 的未验结果链路推进，未重做全仓审计。使用 Playwright 与 diagnosing-bugs 的现有反馈流程，先复现“滚动结果列表后返回聊天偏移257px”；只打开再立即返回的简化场景原本通过，未用其冒充完整返回验收。
- 根因：聊天和所有工具面板共用滚动容器，面板滚动还进入聊天阅读锚点/跟随判断。既有 agentWorkspaceNavigation 新增仅内存的面板阅读位置记录，按项目/会话隔离；切换后在布局阶段恢复各自位置。工具面板滚动不再触发聊天跟随或历史消息分页。没有增加持久化字段、状态机或依赖；AgentWorkspace 保持3920行冻结预算。
- 最终结果返回 UAT：填入未提交草稿、选择第二张结果作为引用、滚动聊天、打开并实际滚动结果列表，再返回；原阅读位置误差<2px，草稿、引用媒体URL与输入焦点全部保留。
- 历史分页 UAT：只向隔离项目 project-1788590724487 添加 uat-history-page-1..101 测试记录。前100条文本、第101条为已有本地假媒体的历史图片，sourceNodeIds 指向不存在的测试节点；读取使用实际 API/PostgreSQL，只有更多页故障通过503注入。首次读取未包含第101项；更多页失败保留已有结果，重试请求复用同游标，载入后图片实际解码。详情没有空定位按钮、下载可用，继续改复用既有画布素材能力并准确引用该媒体，假生成计数前后不变。
- 完整结果用例保留在 e2e/uat-agent-results.spec.ts：无 UAT_ACCESS_TOKEN/UAT_RESULTS_PROJECT_ID 默认跳过；历史项另要求 UAT_HISTORY_FIXTURE=true 和 UAT_IMAGES_FAKE_ORIGIN。种子 SQL 位于 /private/tmp/botanic-agent-recovery-uat.0NZvAD/seed-history-page.sql，仅限定上述本机测试项目；测试记录保留供复跑，没有覆盖既有 Run/Job/Artifact。
- 最终两项浏览器用例6.6秒通过；20项导航、Artifact分页与消息投影检查通过；build 5.59秒、architecture、diff检查通过。本轮仅本地导航逻辑，不重复上一checkpoint已经通过的全量2823项测试。截图与trace在 /private/tmp/botanic-agent-recovery-uat.0NZvAD/result-checkpoint；预览及继续改截图已查看。
- 验证边界：历史“节点缺失”来自明确测试夹具，不声称已实际删除原生成节点并验证持久化；下载仅验证入口可用，未验证落盘；继续改验证到恢复所选图与草稿，没有发送新的修改生成。跨项目迟到页、真实Provider、独立Worker及共享环境的剩余项仍保留。无提交、推送、部署、共享迁移或付费生成。

### CP-C1/F1 · 2026-09-05 16:17 CST · 新项目首次发送与失败原位重试

- 本次按“当前只是本地开发”的要求限定到首次消息链路，不重做全仓审计。空白项目延迟保存原本正确，但独立 Message、Session 和引用媒体写入未等待首次项目保存，隔离真实 API 的慢 PUT 已复现 Message 返回 PROJECT_NOT_FOUND。
- 复用 db 写队列增加可选 projectId：先等待本地草稿入队，只冲刷该项目；首次保存失败后可重新提交已有 IndexedDB 草稿，确认项目存在才放行实体写入。仍不存在时给出 PROJECT_NOT_DURABLE/409，不误判成“Turn 已接受后的断线恢复”。不改为创建空白项目即写云端，不改版本冲突、媒体权限或独立实体权威。
- 同链路浏览器发现两个空 ID 被当成“计划重试中”，导致 Composer 重试永久禁用；已要求真实计划 ID 才置忙。当前未接受的失败指令，消息处重试复用已有 retryLastInstruction，同时释放原消息交付队列，保留原 Message/request 身份；历史同步、已接受 Turn、澄清确认仍走各自既有入口。
- 回归保留在现有 e2e/uat-turn-recovery.spec.ts 的两条用例，无 UAT_ACCESS_TOKEN 默认跳过，未添加测试框架。最终 13.9 秒通过：慢保存不再出现 Message 404；失败时消息保留、重试按钮可用，点击一次后得到回答且用户消息仅一条。测试源中的临时重复文件已删除，正式用例可复跑。
- 仅使用隔离 4176/8789/55433 的前端、真实 API/PostgreSQL 与本地 fake Provider；未调用真实模型或生图。截图和 trace 位于 /private/tmp/botanic-agent-recovery-uat.0NZvAD/new-project-checkpoint，已查看恢复后截图。测试验证到第一段回答可见，本次不把它声称为整轮完成/刷新或跨设备验收。
- 门禁：最终完整 npm test 为 1988 + 835 = 2823 通过、2 可选 SQL 跳过；生成处理器 24 项聚焦复跑通过；build 6.54 秒、architecture、diff 检查通过。首轮完整测试暴露上一 checkpoint 的旧 failed 断言，本轮已改为 partial，并保留 Artifact 尚未完成不得提前推进的断言。
- 保护已有脏工作树；没有提交、推送、部署、共享迁移。17/18 本地实现口径不虚增；剩余本地综合验收与独立共享环境账本继续分开记录。

### CP-E4/F1 · 2026-09-05 15:14 CST · 部分完成、缺图重试与成功结果保留

- 已复现三个同链路问题：Job 的 missingOutputCount 未进入 Run 投影，导致部分成功误报完成；重试沿用原张数与成功 variants；真实长 Run/branch 拼接的幂等键超过接口 128 字符限制，返回 INVALID_IDEMPOTENCY_KEY。
- 共享修复：缺图 Job 投影为可重试 failed 分支，含成功输出的 Run 为 partial；新 Job 仅请求缺少张数、仅预留对应额度，清空旧候选/取消/执行 token，不改原 Job。成功画布节点与旧 Job 记录保留，新补图沿现有 370 间距错开。短幂等键不变，仅原本不合法的超长键做 SHA-256 确定性压缩。
- Supabase CLI 新建本地迁移 20260905065929_agent_partial_output_retry.sql：更新已有 unbound 合并函数与 Job 投影 RPC，不覆盖幂等绑定 wrapper，不增加字段、权限或后台回填。临时 PostgreSQL 实际函数验证部分状态、合并、错误绑定保留与 owner 拒绝通过；事务回滚，未执行共享迁移。
- 验证：37 项现有相关测试通过；最终浏览器 1 项 6.4 秒通过，含两张实际解码与同键重放；Run agent_run_CuBGZW10Ml_l8M7fo2x_Pa7s9mzLURpSBI6auUQBSCM 完成，attempt=1，两 Job 分别 batchCount=2/1、各输出 1，Artifact=2。构建 6.60 秒通过；最后节点位置调整后额外服务端类型检查、架构与 diff 检查通过。没有再次全量 npm test。
- 证据保留于 /private/tmp/botanic-agent-recovery-uat.0NZvAD/partial-verified（前后截图及 trace）、partial-verified.log、check-partial-rpc.mjs；可复跑 UAT 归档为 uat-agent-partial.spec.ts，依赖隔离 4176/8789/4797/4799/55433 服务与已保存测试项目。临时 e2e 文件移出工作树，未新增测试框架。
- 未混淆的限制：新项目刚创建时可先收到 404、尚未可靠保存，首轮复测因此中断；随后复用已保存的隔离项目，仅验证补图，未顺手修项目初始化。旧版已误记 completed 的历史 Run 未自动回填；本轮无提交、推送、部署或付费生成。其余本地未验项目仍保留，不以此 checkpoint 宣称全目标完成。

### CP-E3/I1-4 · 2026-09-05 14:38 CST · 双图、指定媒体与索引重读本地闭环通过

- 上一目标轮已修复参数误作变体并留下失败 UAT，本轮继续该反馈路径。按 diagnosing-bugs 区分测试媒体配置、旧画布覆盖和错误血缘，没有再做全仓审计。
- 查明上轮“图片消失”的隔离环境原因：未配置对象存储，mediaService 返回 data URL；Artifact 转换明确不保存 inline URL，协作清洗明确过滤 data URL。两条 Artifact 的 runId 关联正确，不是重复卡片或结果错绑。未修改或放宽产品媒体授权、协作清洗、Artifact 持久化规则。
- 只在 /private/tmp/botanic-agent-recovery-uat.0NZvAD 的测试服务补本地 S3 HTTP 行为与 dummy 凭据，使原 createObjectStore → mediaService → PostgreSQL 媒体元数据 → /api/media 路径实际运行。测试图片保存在该假服务内存，能覆盖整页刷新，不等于 S3 服务重启后的持久性或生产对象存储验收；没有安装新库或调用外部服务。
- 原双图流程 6.1 秒通过；补精确媒体身份后首次因 img 选择器同时命中模型图标/悬浮图而失败，仅将测试定位器限定到引用缩略图，随后 6.6 秒通过。没有因此修改产品选择逻辑。
- 最终同一 UAT 9.3 秒通过：确认前 0 次生图；Plan/Run 为 2 张、3:4、2K、无伪变体；两图解码；选择第二项后托盘媒体 URL 与该项完全一致；刷新后两图仍解码；随后模拟 Artifact 索引 GET 503，结果面板保留已有两图并显示重试；恢复真实 API 后重读成功，生图调用数仍为 2。
- SQL 读回最终 Run agent_run_H2LmQ1fTb-Z90bundLN8qWoKSKTS3GOxehx_rZrygR4 的 Job job_MZVnkqcbYkoDDCVNkyraAf5-1OHWySlRFawg-dD2xpQ 为 succeeded，输出 2 项，实际 settings 仍为 gpt-image-2 / 3:4 / 2K；两条关联 Artifact 均持有 /api/media URL。
- 最终日志 generation-index-final.log、截图与 trace 在同目录 generation-index-final；已查看刷新、指定媒体、失败及重试后截图。测试源移回同目录 uat-agent-generation.spec.ts；需从仓库 e2e 临时运行，PLAYWRIGHT_BASE_URL=http://127.0.0.1:4176。原用户 4173/8787 服务保持不动。
- 本轮没有应用源码修改，不重复已通过的构建/46 项变体测试/架构门禁；diff 检查通过。更新 E/D/I 的证据，但部分完成、分页竞态、已删节点完整页面、独立 Worker 与共享环境仍缺证，不将 17/18 或 0/9 改成虚假全完成。

### CP-D1-2 · 2026-09-05 14:25 CST · 输出规格误作变体修复；双图结果验收未通过

- 按用户“只是本地开发、耗时过长”的反馈，本轮限定为当前双图流程，不重开审计、不重复全量测试、不展开发布/共享环境工作。
- 隔离浏览器和真实本地 PostgreSQL 复现：输入“生成两张白底植物插画，3:4、2K。”后，计划把 34 与 2K 写入 custom 变体，并污染分支提示词。不是单纯图片标题问题。先扩展现有前后端共用夹具，实际得到 ready/34/2K 与预期 none 的失败。
- 只修两侧既有变体解析：原始 token 截短前排除比例/清晰度；模型已判定生成时，不再仅凭 N 张强制要求创作变体。真实场景枚举与明确批量/确认取值仍保留。未改全局意图识别、生成接口、计费确认和持久化结构；898 行冻结预算未增加。
- 前后端变体相关 46 项通过；构建、架构和 diff 检查通过。新增行为仅通过既有镜像夹具的一个主路径和一个真实枚举保护路径验证，没有新测试框架。日志 /private/tmp/botanic-agent-variation-specs.log、botanic-agent-variation-build.log、botanic-agent-variation-architecture.log。
- 重跑隔离全页面 UAT，确认之前 imageCount 为 0；创建的 Run 无 variation，output.count=2，settings 为 3:4/2K，真实 Job 为 succeeded 且输出数组长度为 2。仅使用本地假图片 Provider，不产生外部费用。
- UAT 未通过：对话结果短暂出现后消失，最终“未找到结果”；画布两个节点显示“等待生成结果”。因此没有执行到本次刷新断言，不能宣布双图结果/刷新恢复已通过。对应 Run 为 agent_run_unar0Quom-Df7Ovil3tf4UpMbzJnRn3TwCwqg-6ayRo，Job 为 job_vIfrhek6PdF1li-qdi5te5mUfxp-cg5uwuJCnHUvdcU，临时项目 project-1788589464566。数据库仍有两条关联 Artifact；媒体回写/读取差异待精确定位，未推断为 Provider 故障或删除数据。
- 失败截图已查看，日志和 trace 保留在 /private/tmp/botanic-agent-recovery-uat.0NZvAD/generation-fixed；测试源移至同目录 uat-agent-generation.spec.ts 保留，不让硬编码隔离服务的临时 UAT 混进常规测试。测试 API 8789、Vite 4176、假 Provider 4799 与临时数据库保留；用户 4173/8787 未重启。
- 进度仍为本地实现 17/18、完整验收 0/9，明确保留结果稳定性失败。未提交、推送、部署或迁移共享数据库。

### CP-I1-3 · 2026-09-05 14:09 CST · 本地真实刷新/停止闭环与 SQL 补验

- 前一目标轮为实际修复/验证进展。本轮不重跑全仓测试，复用现有移动 WebKit 两项与 UAT 两项；移动 WebKit 在当前 4175 local 包上 2/2 通过，日志 /private/tmp/botanic-agent-mobile-webkit-final.log。
- Docker daemon 未运行，既有 smokeLocalStack.sh 会删除固定容器，因此没有执行它。使用已安装 PostgreSQL 17，在全新 /private/tmp/botanic-agent-recovery-uat.0NZvAD/data 启动隔离库 55433；独立 API 8789、Vite server 模式 4176、fake Provider 4799。API 用干净环境启动，不读取仓库 .env；fetch 拒绝非 127.0.0.1 地址。临时测试身份与真实用户无关，无真实模型/共享数据库/容器重建。
- UAT 首轮刷新通过、停止失败。截图明确显示测试用 /停止|Stop/.first() 点开了包含“停止”的会话标题，服务端未收到取消。仅将旧测试定位器改为 Agent 输入表单内的精确“停止”按钮；另补 Provider 初始调用数必须为 1 的断言和两张成功截图。没有修改产品取消逻辑或弱化 ACK 条件。
- 最终现有 UAT 2/2，24.3 秒通过：真实 API/Turn 执行器/PostgreSQL，fake Provider；运行中刷新通过 durable observer 恢复，调用数保持 1；Stop 后没有最终回答。独立 SQL 读回最近对应 Turn 为 completed/cancelled，API 日志存在 cancel_observed 与 cancel POST 200。这里是本地 API 内 Turn 执行器，不是独立生成 Worker 或跨机器验收。
- 最终日志 /private/tmp/botanic-agent-recovery-uat.0NZvAD/browser-final.log；同目录 browser-final 内 turn-restored.png、turn-stopped.png 已逐张查看。可重跑环境：PLAYWRIGHT_BASE_URL=http://127.0.0.1:4176，UAT_ACCESS_TOKEN 使用临时 start-api.mjs 中的测试值；执行现有 e2e/uat-turn-recovery.spec.ts。临时服务与库保留供后续本地验证，不覆盖用户 4173/8787 服务。
- 遵守原 SQL 测试的 socket 路径/55479 约束，另用新隔离库 /private/tmp/botanic-agent-sql-6NJQyo 补跑 6/6（无跳过），包含真实 SQL/JS 合并一致性、完整 PUT/sync RPC、不同答案冲突与执行权限；事务回滚，测试库已停止，日志 tests.log 保留。未放宽隔离限制、未迁移共享库。
- 应用源码与 CP-H1-3 相同，本轮只修改既有 UAT 的定位器/断言/截图及本记录；diff 检查通过。仍 17/18（94%），完整生成结果/恢复、多设备、共享 Adapter 和缩放触控缺口继续保留，不宣称 I1 或整体完成。

### CP-H1-3 · 2026-09-05 13:53 CST · Shimmer 真实隐身根因修复与结果异常交互验证

- 上一目标轮仅交付状态，分类为无进展；本轮续作后复现实际缺陷并修复，不重开全仓审计。真实 Message + 项目样式的 Chromium 检查发现普通动画下 background-image 为 none、文字为透明。补齐验收页主题容器后仍失败；DOM 证明 --background 有值而 --color-background 缺失。根因是 @theme inline 仅提供编译期别名，没有运行时变量。
- 只在既有 .botanic-agent-shell 补 --color-background 与 --color-muted-foreground 两个运行时映射，覆盖 Message、Plan、Reasoning 的共用 Shimmer；不改组件库、状态权威或 Provider。现有 runtime-feedback 测试文件增加一个小型契约检查防止别名再次只留在编译期。
- 同一真实 Message 浏览器检查：普通模式渐变存在且背景位置实际变化；prefers-reduced-motion: reduce 时无渐变且字色非透明；工具/正文到达后占位消失；等待、流式正文、运行 Run 无完成线；终态只有一条，用户前无线，只有最新 Bob。截图已逐张查看。媒体偏好由 Chromium emulateMedia 驱动，未冒充操作 macOS 系统设置或真实触屏。
- 第二条异常路径通过：notice 关联 completed Run 时显示可重试索引错误，重试只触发 index-read，恢复两张可解码缩略图；已删节点打开结果、另一张定位 node-2，多图选择第二项只提交 Artifact 2 给继续修改回调。此处父层使用 mock，不等于真实 HTTP/Worker/Provider UAT。
- 两项 Chromium 检查 2.3 秒通过；聚焦检查 5/5、architecture、build、diff 通过。未重复全量测试。临时验收页及测试已移出仓库，保存在 /private/tmp/botanic-agent-activity-evidence.lOxH7s；日志和截图在 /private/tmp/botanic-agent-local-activity-final，诊断失败证据在 /private/tmp/botanic-agent-local-shimmer-probe。src/server 源码指纹为 622536461b421e0ca24fa2197fc2f2ca06fe0f65a7f6f6e2511e1193f3677acc。4175 local 包已更新，先前 bundle hash 仅代表 CP-I1-2。
- 本地实现仍 17/18（94%），I1 不提前完成；200% 原生缩放、触屏/软键盘、完整应用恢复及共享服务缺口保留。未提交、推送、部署、迁移或调用付费生成。

### CP-I1-2 · 2026-09-05 13:39 CST · 实际视口、旧回归修正与打包隐身修复

- 上一目标轮有实际修复与门禁证据，本轮分类为继续推进。沿用仓库 E2E，没有创建新框架；临时配置已删除，既有 playwright.config.ts 增加显式 PLAYWRIGHT_BASE_URL 两行支持，指定时不再误复用用户 4173 服务。
- 双图片真实粘贴用例在 Chromium 1440×900、768×900、360×800、360×400 验证面板不横向溢出、主要按钮留在面板、移除按钮 ≥24px 且留在各自缩略图内、输入字体符合 14/16px；逐张键盘移除后聚焦相邻/添加入口。检查实际截图，不是裁切或 iframe。开发页通过，最终打包产物再次通过。
- 旧 Agent 回归先出现 4 个失败：交付 mock 不返回权威回执；3 个直接注入 Store 的用例使用无版本 URL，而应用加载的是带 HMR 时间戳的另一实例。捕获实际模块 URL 后统一使用页面已加载的 Store；回执 mock 与结果断言更新为真实结构；Bob 旧头像期待改为唯一最新头像；执行记录名称跟随已批准文案。大头像断言等待真实动画尺寸，不降低阈值。七项现有用例最终通过，调试输出已移除。
- 最终 local 包另外复现欢迎快捷按钮逐渐隐身、无法点击。DOM 显示 GSAP 遗留 opacity/visibility，Button 的 transition-all 同时处理这些属性；只将现有 Agent starter CSS 的 transition 限于颜色/边框，原打包进入→点击→刷新场景即可完成。不改 GSAP 全局、主画布或新增动画系统。
- 打包控制台 404 经 trace 逐条核实只来自 /_vercel/insights/script.js 与 /_vercel/speed-insights/script.js；测试仅对这两个本地缺失端点返回空脚本，应用 console/page errors 仍严格检查。真实 Vercel 统计端点未在本地验证，不将该隔离作为部署证明。
- 7 项开发页 Agent 回归、3 项最终打包回归及单独可重跑的附件路径通过；69 项 intent eval 通过。CSS 修复后最终 npm test 2821 通过、0 失败、2 可选 PostgreSQL 跳过；architecture/build/diff 通过。应用源文件指纹（src/server 排序文件哈希的 SHA256）：96354ce071c44c20c6356c8179e73d17746855779e5d64167f1d26564c3b65c4。local 包入口 index-B4EMAluB.js SHA256 1a986e7211219b77c8f7ac1dd227d452648bbfe130fea332c82b4ccfff8b15ae，CSS index-CB2yWSd4.css SHA256 1247636b1b6f4e7c4786fbecf8c75be6549841643ff52ec5c8cd91717a733ab8；基线仍 HEAD 7810a84 + dirty。
- 可重跑：PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test e2e/paste-media.spec.ts --project=chromium --grep '截图粘进对话框' --output /private/tmp/botanic-agent-bundle-attachments。截图保留在该输出目录，打包综合证据在 /private/tmp/botanic-agent-bundle-final-ui；日志 botanic-agent-bundle-final-ui.log、botanic-agent-existing-ui-verified.log、botanic-agent-bob-ui-verified.log。4175 是隔离 local 包，4798 伪健康/拒绝写入；不等于用户 4173 的服务端项目环境。
- 仍为 17/18（94%），I1 未整体通过。尚缺 200% 原生缩放、真实触屏/软键盘、系统 reduced-motion、共享服务恢复和真实 Worker/Provider UAT。既有 UAT 所需 4799 fake Provider/55432 PostgreSQL 当前无监听；未执行会删除重建既有容器的 smokeLocalStack.sh，也未用真实 Provider 填补缺口。没有提交/推送/部署/共享迁移。

### CP-I1-1 · 2026-09-05 13:24 CST · 本地最终门禁通过，验收边界保留

- 最终 npm test 首轮唯一失败来自旧静态契约，仍要求已移除的浏览器失败分支自动重试。核对 F2 的已批准 Worker 单一归属后，只修改该断言为禁止第二套入口；没有恢复浏览器重试或改 Worker。聚焦通过后完整复跑最终 npm test：2821 通过、0 失败、2 个可选 PostgreSQL 跳过。
- 最终架构检查、TypeScript/Vite build、git diff --check 通过；Vite 6.58 秒，存在已有大包告警。应用源码在构建后未再变更，仅修正测试契约与记录。日志位于 /private/tmp/botanic-agent-final-test-verified.log、botanic-agent-final-build.log、botanic-agent-final-architecture.log。
- 实际 4173 新标签页核对：图片 naturalWidth > 0、消息内定位画布/继续修改可见、历史确认卡只读且有查看任务、一个 Bob、正文 14px、用户贴右与 Assistant 同左边线、当前 1280×720 无页面横向溢出。4173 实测仍是 Vite 开发服务（含 @vite/client 与 src/main.tsx），不是 dist；不把构建成功与开发页验证合称打包产物 UAT。未发送/生成或修改该用户项目。
- 真实协作连接仍出现超时并保留同步受阻重试；本地 UI/契约修复不等于远端握手已恢复。真实 360/768/1440、200% 缩放、软键盘、系统减少动态效果、既有 Playwright 附件焦点路径、打包页面和共享服务仍未完成。没有使用裁切截图或容器宽度冒充响应式验收。
- 本地实现 17/18（94%），I1 保留部分、完整验收仍 0/9；不扩大本次本地收尾到部署、付费 Provider 或共享迁移。未提交/推送，工作树保留用户与既有改动；临时 UI 验证文件已清理。

### CP-H1-2 · 2026-09-05 13:21 CST · 附件焦点与等待文本可见性

- 实际本地页面复现：按 Enter 移除中间附件后 activeElement 变成 BODY。共享 AgentAttachmentRemove 现在在原按钮卸载且用户未移走焦点时，将焦点移到相邻附件；最后一项回到现有添加入口。补齐 tooltip，图标 16px，命中盒保持 24px，未扩大到相邻缩略图。
- Shimmer 的 reduced-motion 分支显式使用可见文字颜色，移除等待段落统一透明的冲突声明，正常动画仍为渐变扫光。无 hover 的网格附件不隐藏移除按钮；输入工具区允许必要换行，不通过 overflow:hidden 裁切模型或焦点。
- 实际 4174 完整页面：移除后焦点先到相邻附件，最后到添加入口；默认 Composer 119px，Bob 1 个，918×784 当前视口页面无横向溢出。这里只验证已有本地隔离项目，不调用 Provider，不修改原 4173 项目。
- 14 项既有附件/Composer/粘贴/队列检查、TypeScript 和 diff 通过；在现有粘贴 e2e 主路径补入两张图片逐个键盘移除和焦点断言，尚未运行其 Playwright 自动化，不计作通过。无需新框架或新测试套件。
- H1 本地代码收口，进度 17/18（94%）。真实 360/768/1440、200% 缩放、软键盘及系统 reduced-motion 浏览器验证仍是未完成项，不把当前尺寸或容器裁切冒充响应式验收；最后一轮集成门禁开始，未提交/部署。

### CP-A1-6 · 2026-09-05 13:17 CST · 确认卡初次核对与缺页任务定位

- 确认卡展示与提交共用原 Turn/问题身份判定；初次只读核对期间不提供提交，取消、旧问题、缺原请求设置时保持只读，不借用当前 Composer。原请求不在当前页时复用现有消息 API，最多 10 页，重复游标、项目/会话切换及时停止。已有 Run 优先显示查看任务，不要求执行快照。
- 核对重试不卸载确认选择，网络失败后保留已选答案；提交端仍重复核对，初次 UI 核对不代替授权或可靠交付。没有新增 HTTP/数据库字段或自动修补历史消息。
- 查看未载入 Run 复用项目任务 GET，严格匹配 Run/项目，迟到或跨项目结果不应用。任务出现并实际获得焦点后才消费定位请求；加载失败显示重试，不误报空列表或提前清除目标。
- 实际组件隔离页验证：初始核对、取消只读、2K 选择在重试后保留、缺原快照只读、已有 Run 直达任务、缺任务失败后重试并聚焦 article。提交计数保持 0；未调用真实 Provider、未修改用户项目。临时文件已删除，标签已退出。
- 50 项确认/消息/Composer/历史/可靠队列检查通过，0 失败/跳过；TypeScript、架构及 diff 通过。Workspace 3920/3920，未抬预算；没有重复全量构建。A1 本地完成，进度 16/18（89%），H1/I1 留待最终收口；共享环境与跨设备不以模拟替代。

### CP-F2-4 · 2026-09-05 13:00 CST · 普通任务停止意图可靠交付

- 实际 useAgentRunOperations 私有验证页先复现：普通任务取消在请求到达服务器前断网，已存意图为 0；整页刷新后“待确认”消失，且不再接续取消。与旧计划路径相比，普通 Run 取消没有调用任何消息持久化入口。
- 普通取消现在先将唯一 notice Message 交给既有消息队列，再调用现有取消接口；记录只使用已有 runId、turnCancellationRequestedAt、status、时间戳，无新增数据库字段、HTTP 资源或取消状态机。刷新按明确 Run ID 接续同一取消，失败重试复用原 Message，不创建生成/分支重试。
- Message pending/answered 只表示该停止请求待处理/已处理；仍须 onCancelRun 同时确认取消和状态刷新成功后，才持久化 answered。false、网络异常、ACK 未定或处理回执保存失败均保留未处理请求和重试入口，不用 Message 状态代替 Run/Job 终态或费用证明。
- 已处理请求不再作用于后续显式 attempt；新一次停止创建独立请求，旧回执不能结清新请求。旧计划在关联 Run 已存在明确停止处理回执时不再依赖客户端与服务器墙钟比较，避免旧意图误停后来的分支重试。
- 原消息队列的同步入队失败现在可返回给关键调用方，其他普通消息调用保持原有错误展示方式。停止意图保存失败会报错且不发取消；版本按当前 Message 的 updatedAt 单调推进，避免期间的运行文案更新把 ACK 回执盖回 pending。项目切换后不把晚到处理回执写进新项目。
- 4174 实际 hook 私有页最终验证：取消断网→整页刷新后仍只有 1 条待处理意图、请求计数 2、分支重试 0；确认 ACK 后同条意图已处理；新 attempt 再刷新请求计数保持 3。再次停止新 attempt 会产生第二条独立请求，刷新仍接续该请求；保存故障时请求计数为 0 且显示明确错误。私有数据和临时文件已删除，标签已退出，未修改用户项目或调用真实 Provider。
- 57 项客户端消息/操作/恢复/Store/离线队列检查、37 项现有服务端取消/fence/ACK/费用契约检查通过，共 94，0 失败/跳过；TypeScript、架构、diff 通过。Workspace 3916/3920 行，未提高冻结预算。未重复全量测试/构建，未提交、推送、迁移或部署。
- F2 计入本地已实现，进度 15/18（83%）；A1/H1/I1 仍未收口，完整验收 0/9。真实 Worker ACK、跨设备恢复与完整应用 UAT 不以隔离模拟替代。

### CP-F2-3 · 2026-09-05 12:53 CST · 旧计划停止交接与刷新恢复

- 旧计划缺少 Turn 时，原 Stop 分支只结束本地等待，返回的 Run 仍可继续执行。本批沿用 Message 的 turnCancellationRequestedAt 保存计划停止意图，迟到提交回执/异常处理保留最早停止时间，不改幂等键、Run/Job 权威、取消 fence/ACK 或数据库结构。
- 新增小型纯领域投影 agentPlanCancellation：先按明确 runId，否则按现有 Message+冻结 Plan 提交键所派生的第一分支 ID 匹配；没有或出现多个匹配就不猜“最新 Run”。计划停止后即使整页刷新，实际 useAgentRunOperations 也只补取消，不调用创建/执行/分支重试。单次加载自动尝试一次，失败留给重试停止，不循环请求。
- 媒体准备后、创建请求前核对同一计划停止意图；已经停止则不再 POST。收到 Run 后接到已有取消入口；尚缺 Job 或 ACK 不显示已停。已确认取消的历史 Job 证明旧停止意图已经兑现，不拿它去取消用户后来显式发起的新 attempt。
- 停止计划移除生成/授权继续入口、锁定设置；执行端同时阻止再次确认，自动提交 selector 排除已停止计划。停止后的失败分支不留下点击无效的“重试原计划”，也不追加“任务未启动”冒充已知结果。
- 4174 临时页面使用真实 useAgentRunOperations、纯投影与页面自身的私有模拟数据：Stop→整页刷新保留意图，Run 迟到后取消计数 1；直接调用重试仍为 0。ACK 未确认时再刷新只补一次取消，允许模拟 ACK 后重试停止解锁；显式下一 attempt 再刷新取消计数保持 3。未连接 Provider、未改用户项目；验证私有数据和临时页面已清理。
- 133 项消息、取消、Turn 恢复、Store 与离线队列聚焦检查通过，0 失败/跳过；TypeScript、架构、diff 通过。Workspace 3916/3920、Message 1444/1467 行，未提高冻结预算。没有重复全量测试或构建，没有提交、推送、部署、迁移或付费调用。
- F2 仍为部分：普通任务列表的取消，在请求尚未到服务器即断网时，仍只有操作 hook 内存错误状态，不能用本批“计划停止”的持久化证明覆盖该路径。完整应用/真实 Worker ACK 也未验。本地进度保留 14/18（78%），完整验收 0/9。

### CP-G1-2 · 2026-09-05 12:43 CST · 整轮边界、并行时间与历史冻结

- 既有测试明确复现两种错误：整轮在最后工具结束处停表，漏掉末段答复（应 5000ms，实为 4000ms）；尚未读完的历史 running 事件用读取时刻计时（应未知，实为 899000ms）。另核对 MCP/quiet read 聚合直接相加，以及终态 plan calls 接受 start 后仍按当前时间增长。
- 时间线增加仅 UI 内存的 timing 投影，读取已有 Turn/Run createdAt/updatedAt，不新增 HTTP/Store/数据库字段。accepted/handoff 只更新真实起点，不再落入 done；SSE、observer 以及一次性结果路径保留已有 runtimeTurn 时间；重复收口不推进终点。同 Turn attempt 重启保留原起点、撤销旧阶段终点，等待确认时冻结阶段，不称作思考时长。
- 整轮包含工具后的答复阶段；Run 投影延续 Turn 最早起点并使用 Run 权威终态时间。Hydration 与先到 Run 合并时保留运行步骤和时间边界；未被实时观察的历史记录不使用 now 补结束，缺页/缺时间显示未知，不伪造成功或开始时间。连续聚合搜索追加结束时间不会停在前一个网页结束处。
- 真实单步起止保留；并行 MCP/quiet read 汇总改为最早开始到最晚结束，不相加重叠区间，任一步缺时间则汇总未知。没有结束证据的历史计划调用不继续计时。Run/Job 的时间字段补齐纳入工作区订阅和投影比较，状态没变化也能重绘；未抬冻结文件预算。
- 实际 Message 定时器跟随整轮 live 标记：所有工具完成而答复仍流式时继续计时，历史标记禁止用系统时钟增长。done/error 清空当轮原始 reasoning 文本，保留安全工具 why；不会写入 Message、Plan、Run 或 Artifact Index。
- 4174 隔离页使用实际 AgentConversationMessage：工具已完成时总用时从 10 秒到 26 秒；模拟服务端整轮结束后固定显示其 8 秒边界，多次读取不增长；缺页历史显示“用时 —”，后续读取保持未知。未操作用户项目、未调用 Provider；临时页面已删除、标签已退出。此证据不是共享服务断线/时钟和完整应用 UAT。
- 76 项 timeline、hydration、stream、event reader、observation 聚焦检查通过，0 失败/跳过；TypeScript、架构和 diff 通过。本批没有重复全量测试或构建；timeline 648/662、API 1394/1402、Workspace 3910/3920、Message 1443/1467 行，均在冻结预算内。未提交、推送、部署或迁移。
- G1 计入本地已实现；进度 14/18（78%），完整验收仍 0/9。剩余本地子项 A1/F2/H1/I1 不以此批完成代替。

### CP-G1-G2-1 · 2026-09-05 12:33 CST · 引用共同入口与单层执行记录

- 找到三处同源丢页：服务端 presentationWebSources、客户端安全清洗和时间线合并均按 hostname 去重；统一改为已有校验后的完整 URL 身份，无 URL 才用 hostname。不同路径/必要查询保留，HTTP、带凭据、主机不匹配与私网出网保护不放宽，数量上限不变；历史已经丢弃的来源不猜测回填。
- AgentWebSourcePills 复用既有安全来源函数，删除第二套宽松 URL 清洗；引用卡复用已安装 Radix Popover，支持点击/Enter、可聚焦链接、Escape/关闭及焦点返回。补齐中英文名称、12px 元数据、最小点击区、弹层内部滚动、长链接换行与 reduced-motion；不依赖 hover，不新增 UI 库。
- 项目来源仅在匹配真实 catalog 实体时规范化 ID，实体 ID 与 @ID 合并为一枚标签；名称和定位参数来自 catalog，未知字符串/项目本体保持不可定位文本，正文不按 role/provider 正则删除。
- 执行步骤删除重复的 why/Tool 双标题，统一一行图标、动作、状态、用时和展开按钮；步骤来源在展开内容中，key 使用 URL；参数/输出仅开发模式“技术详情”，错误保留 alert。只有 row.recovered 才显示“已恢复”，不把 reexecute 策略当恢复记录。没有增加原始数据读取或 reasoning 持久化。
- 外层 disclosure 按实际阶段而不是每次工具 ID 重置：手动折叠后普通下一步骤保持折叠，转入失败/确认才按状态展开；相邻步骤只留短连接线，末尾无尾线，去掉额外横线及 Tailwind space-y 与 grid gap 的重复间隔。
- 4174 隔离页使用实际 Activity、InlineCitation、MarkdownSources 组件；已验上述折叠/失败行为、两页来源不重复、Enter/Escape、退出后 dialog 为 0 且焦点回引用按钮、实体定位回调 node-1，并检查截图。此证据不是完整项目/真实触屏验收；临时页面已删除，标签已退出，未动用户原项目数据。
- 63 项客户端 timeline/来源/observation/hydration、7 项服务端 Web 来源、2 项相关 ToolRuntime 检查通过（共 72，0 失败/跳过）；TypeScript、架构、diff 通过。按本地开发节奏没有重复全量 npm test/build，留至最终整合。Workspace 3920、Message 1442 行未增长；无提交、推送、迁移、部署或付费 Provider。
- G2 计入本地已实现；G1 保持部分，完整 Turn 时长与并行时间不在此批冒充完成。本地进度 13/18（72%），整体验收仍 0/9。

### CP-F1-F2-2 · 2026-09-05 12:22 CST · 原位核对结果与取消交接

- 复用原 Turn 只读恢复入口：明确的 Tool/Action/Review outcome unknown 不再进入普通重放，也不只在 Composer 报错；对应失败消息显示核对提示、可展开的安全操作名称与“刷新状态”。成功结果替换失败消息后不再显示旧提示。关联 Run 优先采用已有 Turn GET 返回的 linkedRunIds，不另建关联或人工重试协议。
- 既有 Store 测试先复现 `GENERATION_JOB_CANCEL_ACK_PENDING` 仍返回取消成功；取消命令现在将 ACK 待定、其他取消失败和文档状态刷新失败均保留为未确认，刷新返回后再次检查当前项目，避免晚到错误污染新项目。没有改变服务端 fence、ACK 或费用判定。
- 对话、任务面板与底部任务卡共用同一停止投影；在途/失败的取消操作未核对前，不画完成分隔线、不进已完成筛选、不开放分支重试/参数/换模型。调用端也有阻止重试的检查，不仅靠 disabled；拒绝重试不会覆盖原取消错误并误解锁。已有成功分支和结果保持不变。
- Stop 的目标解析增加 Run POST 交接：当前 Turn observer 已退出但计划正在提交时，使用该计划的原 Turn；停止意图仍写回原用户 Message，再走已有深取消。Composer 在提交计划期间保留 Stop。无原 Turn 的旧计划不猜测关联，仍列为 F2 待补；本批不宣称取消后整页刷新恢复全部通过。
- 4174 隔离页使用实际 AgentTaskPanel/useAgentRunOperations：取消未确认时显示“正在停止/重试停止”，失败分支按钮禁用，直接调用重试函数也不触发生成；确认停止后，重试只调用第二张失败分支，第一张成功分支保留。实际 Message 组件验证原位未知结果提示与原生 details 展开。模拟回调不作为真实 Worker/费用/整页恢复证据；临时页已删除、标签已退出。
- 最终 56 项现有取消、恢复、输入队列和 Store 聚焦检查通过，0 失败/跳过；TypeScript、架构、diff 通过；本批构建通过（Vite 6.33 秒，后续两处小 guard 调整已复跑聚焦检查/TypeScript）。全量门禁只在最终整合执行；Workspace 3920、Message 1442 行，未抬预算，无新依赖、Schema、SQL、共享服务写入或付费生成。
- F1 计入本地已实现；F2 保持部分。本地进度 12/18（67%），完整验收仍 0/9。未提交、推送或部署。

### CP-A1-5 · 2026-09-05 12:14 CST · 旧确认提交前核对与已有任务收口

- 既有测试先复现旧格式卡关联的 Turn 已取消仍保存答案。确认入口现在读取原 Turn；独立规划核对当前问题和原指令，生成决策核对原 prompt/mediaKind，取消或不匹配时拒绝接续。读取失败保留重试，不借用当前 Composer，不改变原请求快照或幂等身份。
- 复用现有 GET 返回的 linkedRunIds；发现已有 Run 时只可靠保存现有 runId 关联，不再次规划或生成。消息投影依据明确 runId 关闭旧卡，即使 Run 暂未在当前列表中。HTTP 写入同步核对旧格式 Turn；已有 Run 的关联写入不误作再次回答规划问题。未新增 HTTP 字段、Store schema、SQL 或第二套状态机。
- 本地隔离页使用实际确认组件和提交函数：已取消卡选择 2K 后提交，保存 0 次、接续 0 次，显示失效提示；“重新填写”只回填原指令。模拟已有任务时保存 1 次、接续 0 次，“查看任务”回调收到确切 Run ID。该证据是组件路径，不冒充真实服务端/任务面板分页定位。两份本任务临时验证页已删除，验证标签已退出，未修改用户项目。
- 13 项客户端聚焦检查和 78 项服务端路由/规划检查通过。构建通过（Vite 6.08 秒）、架构通过；最后补齐规划关联写入 guard 后复跑 78 项服务端检查及 diff 检查通过。未重复全量门禁；Workspace 保持 3920 行，未提高预算。
- A1 保持部分：失效旧卡目前在提交预读后变为只读，未宣称所有历史卡首次显示已完成权威状态刷新；未载入 Run 的完整任务定位、跨设备闭环仍待验。本地进度 11/18（61%），完整验收 0/9；无提交、推送、共享迁移、部署或付费生成。

### CP-A1-4 · 2026-09-05 12:01 CST · 确认答案排序与历史失败入口

- 先用既有提交测试和消息读模型复现：答案缺少原操作关联，原位更新的结果仍按创建时间排在答案前。新确认沿用现有 `turnId` / `sourceMessageId` 记录原操作；用户输入的追加入口保留该关联。服务端源信息仍由现有权威规则过滤，未放宽客户端 provenance 写入权限、改请求键或新增字段。
- 共同读模型只根据确切操作关联，将回复放在同操作已保存答案之后；不改 createdAt/updatedAt，不按正文或相邻位置猜关联。没有身份的旧答案保留原顺序，不自动回填。既有消息去重、Run 投影、分页游标和实体写入规则不变。
- 确认答案关联原 Turn 但不是原始请求：刷新恢复排除 `agent-answer-*`；按 Turn 回找原输入的三个既有入口只接受携带原请求快照的用户消息，原请求在更早页时继续分页，不能拿“2K”答案代替原图/要求。
- 已标记 failed 的历史确认使用已有只读/重新填写 UI，不再显示继续提交；直接调用提交入口也返回明确错误，不保存答案、不接续。缺关联的历史卡仍保留重新填写草稿出口及既有草稿替换确认。旧格式 pending 卡对应的权威 Turn 是否已经结束仍需单独核对，未将本批标成 A1 全部完成。
- 在既有 4174 local/mock 预览真实输入“蜡烛 Prompt”，选择“社媒种草”并确认：答案在前、唯一 Prompt 在后，没有重复确认入口；完整页面刷新后顺序、Prompt 与生成按钮保留，截图已核查。未点击生成，未访问真实 Provider。修复前测试留下的无关联香水/口红记录未猜测排序或删除。
- 83 项现有提交、读模型、消息 DTO、恢复、快照与路由聚焦检查通过；TypeScript/构建通过（Vite 6.38 秒），架构/diff 通过。Workspace 3920 行，未提高冻结预算；未引入依赖、Schema、SQL 变更或第二套状态机。
- 本地进度仍 11/18（61%），完整验收 0/9；本批是 A1 的已验证 checkpoint，不冒充整个包完成。没有提交、推送、迁移、部署或付费生成。

### CP-A1-3 · 2026-09-05 11:52 CST · 规划问题身份与 Prompt 确认收口

- 复现并修复确认后修改参数仍复用确认前规划键而触发意图冲突：接续使用既有答案 Message ID 构成稳定规划请求键；重试同答案仍复用，初次请求不变，没有改服务端幂等算法。
- 独立规划 Turn 使用已有 question.id 记录 `plan-clarification:<turnId>`；客户端提交前与 HTTP 写入时核对该 Turn 的项目、waiting_user、原问题 ID/指令。没有新增字段、表或回填历史身份；根 generation Turn 不被错误要求为 waiting_user。既有集成测试验证参数变化不能重用旧键、新答案键只执行一次、取消的规划不能保存旧答案。
- 整页本地走查复现 Prompt 生成后旧确认仍能“继续处理”，刷新也保留。最终 Prompt 现在更新原确认 Message，统一 upsert 保留 prompt 并清除 question；服务端共同合并、前端读模型和本任务未发布的 SQL helper 同步防止迟到旧题重新打开结果。原失败、来源、请求快照和取消保护保留。
- 使用已经核实的 `VITE_PERSISTENCE_MODE=local`、4798 只读 mock（除 health 外全部 405）的 4174 预览。旧卡接续后消失；新“口红 Prompt → 杂志氛围 → 继续规划”只产生一份 Prompt，完整页面重载后仍无确认按钮且保留生成操作，原生截图已核查。修复前试验遗留的重复香水结果未删除；答案消息仍排在原位更新后的结果下方，作为 A1 显示顺序缺口保留，不宣称全部完成。
- 20 项消息/确认聚焦检查、78 项服务端路由/规划检查、36 项客户端/请求快照检查通过（部分重复，不累加为独立用例）；既有隔离 PostgreSQL 中 6 项 SQL/RPC 检查通过、0 跳过，只使用临时事务。最终 TypeScript/构建通过（Vite 6.51 秒），架构/diff 通过；全量门禁留到最终集成。
- 按用户对本地开发耗时的反馈收紧节奏：小批修复只跑直接相关检查并记录 checkpoint，不把共享迁移、发布或真实 Provider 验收放入本地循环。A1 仍部分完成，进度 11/18（61%）；无提交、推送、共享迁移、部署或付费生成。

### CP-A1-2 · 2026-09-05 11:37 CST · 当前题目答案保护与失败接续身份

- 两个既有测试增加断言后先红：同一消息已进入新问题时，旧题答案仍可按客户端时间覆盖；本地提交也没有在保存前检查题目是否变化。提交入口现在比对当前消息的 kind/question.id；服务端共同合并规则对不同题目的 answered/submitted 返回既有 409 答案冲突码，新问题正常 pending 流程不受影响。
- Local/PostgreSQL 沿原共同合并函数生效；同步更新本任务尚未提交、尚未应用到共享环境的确认一致性迁移，Supabase PUT/sync RPC 在原行锁合并处同样拒绝旧题答案。没有改已发布迁移、表结构、Adapter 接口或创建第二套状态机。前端读模型也不再用本机旧题答案盖住远端当前问题；原有同题答案、终态、来源和取消保护保留。
- 已确认后规划失败的重试命令保留确认消息 ID、question.id、原 sourceMessageId、sourceTurnId 和执行快照；原请求优先于追加的答案消息。重试确认时回到同一可靠提交入口，使用已保存答案，不误走整轮 ToolLoop 重试；题目已经变化则停止，不自动回答新题。普通未知结果/失败 Turn 的核对路径不放宽。删除该入口原本不可达的 terminalTurn 分支，Workspace 3916 行，低于原冻结预算。
- 按实际代码澄清 A1 前提：设置卡可能来自已完成的 generation Turn 或后续独立 plan Turn，不等同模型 ask_clarification 的文本追问。本批没有错误地强制要求根 Turn 为 waiting_user；独立规划 Turn 与当前问题的完整关联仍需补验，不宣称已经实现所有 Turn 问题匹配。
- 12 项前端提交/快照/读模型、19 项服务端合并/派生字段/Supabase 契约通过。先只读检查既有隔离 PostgreSQL：沙箱内无响应，权限允许的同一 socket 检查确认仍运行，未重启；随后 6 项迁移/RPC 检查通过、0 跳过，含真实临时事务中的 PUT 和 sync 旧题冲突及角色权限。合计 37 项不同检查通过；最终 TypeScript/构建通过（Vite 6.33 秒），架构/diff 通过，既有大包告警保留。
- 浏览器隔离加载实际 AgentClarificationCard 与 submitAgentClarification：选 2K 后提交显示“提交中…”并禁用；保存失败仍选 2K；保存成功后规划失败，只读已保存设置并提供继续；重新挂载组件后继续仍用同一答案 Message ID、原请求/问题/模型/2K；切会话后迟到保存没有后续执行。原生截图已核查，临时页面已删除；不将组件重新挂载当成整页刷新、真实 API 或生成验收。
- A1 保持部分完成，整体本地进度仍 11/18（61%），完整验收仍 0/9；下一步核对独立规划 Turn 的问题关联与整页未完成确认恢复。无提交、推送、共享迁移、部署或真实 Provider 调用。

### CP-B2-5 · 2026-09-05 11:28 CST · 原目标远端恢复与接续隔离

- 原目标解析改为可等待的统一判断，返回节点必须与冻结快照的 targetNodeId 完全一致。先读取当前文档和原 Job 的确切结果；仅服务端持久化模式下本地目标缺失时，才使用既有远端文档预览 GET。不会改用当前选中的旁图，不从历史 Artifact 伪造当前目标，不覆盖本地文档、草稿、Job 或 Outbox。
- 远端读取前后检查 pendingSync/Outbox，读取完成后核对当前已知项目 revision 与 graph revision。Canvas 桥同时检查项目、节点和 Job 引用、已保存状态及协作状态；有未确认写入、版本倒退或期间变化就停止接续。权限与执行目标最终仍由原服务端路径校验，不改变目标绑定或授权语义。
- 独立准备 hook 只管理本次只读准备的取消与重复提交，不建立第二套 Turn 状态。输入快照在等待前冻结；停止、卸载、切项目/会话后丢弃迟到结果，不创建后续 Agent 请求。沿用原 GET 和超时：停止不会中止既有 GET 的底层网络读取，但不阻塞新会话，也不会继续执行。
- 准备失败保留原请求选项供再次读取；已经得到生成参数、尚未执行的预检失败不会被错误归类成整轮 ToolLoop 重试。服务端生成接续也经过同一原目标判断及项目/会话检查；不重跑成功生成，不更改 Run/Job 幂等与取消规则。
- 异步目标缺失回归先失败后通过。46 项前端/领域/读取协调检查与 51 项服务端 Turn/视觉检查通过，覆盖原目标、错误节点、读取期间未确认删除与取消。最终 TypeScript/构建通过（Vite 6.29 秒）；架构与 diff 检查通过，既有大包告警保留。全量门禁留给最终集成。
- 浏览器隔离加载实际准备 hook，当前选择固定为旁图：恢复只读取并接续原目标；重复按钮禁用；停止或切会话后迟到成功均无后续执行；返回错误节点失败。截图已核查，临时页面已删除。未调用真实 Provider、Run 创建或共享远端写入，不把隔离验证计为完整应用/共享环境验收。
- B2 本地实现收口，进度 11/18（61%）；完整验收仍 0/9。没有提交、推送、部署、共享迁移或付费生图。

### CP-B2-4 · 2026-09-05 11:16 CST · 失败引用独立准备重试

- 增加窄用途 `POST /api/projects/:id/agent-references/prepare`，复用现有项目权限、限流、媒体归属读取和原生视觉/caption 准备。只接受受限节点 ID 与可用规划模型，不接受图片 URL 或 Provider 参数；不进入 ToolLoop，不创建/恢复 Turn、Run、Job，不重试成功生成。不改现有 4 张/16 MiB 上限，返回的只是准备状态白名单，caption 与图片留在原有当轮/内存边界。
- 消息中只有失败引用提供逐项“重试”。准备中禁用重复操作；成功显示“已重新准备 · 未发送”，不修改原 attempt 的采用记录，也不自动再次发送。准备失败保留可重试入口；切换项目/会话/attempt/模型时 abort 请求并丢弃旧响应，卸载也中止。新请求仍按原规则重新校验全组引用。
- Agent 路由已到冻结上限：新入口由独立资源 handler 拥有；将旧媒体 URL 校验原样移到它唯一的行动路由消费者，删除未用 import，不提高预算。Agent 路由 1841 行、Workspace 3903 行、Message 1436 行，均在原预算内。没有新增状态表、Store 接口或生成语义。
- 两个新 HTTP 回归先红后绿：只读取所选失败节点（403 后恢复），没有 Turn/Run 创建；无权限/任意媒体 URL 在读取前被拒。服务端路由/视觉/Turn/Chat 共 131 项、前端流/时间线/恢复 40 项通过；架构与 diff 通过。TypeScript/构建通过；全量门禁仍留给最终集成，不调用真实 Provider。
- 浏览器隔离加载实际 UI 和可控准备回调：默认折叠，只有两个失败项能重试；期间按钮禁用；成功显示未发送且原成功引用不被重跑；失败有 alert；切会话记录 abort，晚到成功不污染新会话。按钮实测 24px，360px 容器内各行 scrollWidth=clientWidth=328px；实际视口 1280px，不冒充三档响应式验收。原生截图已核查，临时页面已删除。
- B2 仍未整体完成：剩余原目标仅远端可读时的安全恢复，需要同时保留本地删除、Outbox、revision 和会话隔离。进度保持 10/18（56%），完整验收 0/9；没有提交、部署、共享迁移或付费生图。

### CP-B2-3 · 2026-09-05 11:05 CST · 准备失败明细与失败消息保留

- 两个既有回归先失败：目标媒体 403 和 Chat 引用总字节超限均在建立 attempt 前退出，完全没有引用反馈。现在沿现有安全事件通道先建立当前 attempt，再发逐项原因，最后保留原错误；主模型调用仍为 0。caption 分支及 Turn 字节超限复用同一入口，不扩大媒体上限或授权。
- 提前终止仅报告有证据的准备结果/失败；不把尚未完成准备的其他图片伪报为不可读。目标失败而旁图准备成功时，旁图只标记 prepared，不标 submitted。切换 caption 准备前清掉废弃原图记录，避免致命错误沿用上一个 attempt 的采用模式；事件不含图片或描述内容。
- 首次请求与恢复请求的错误出口，现在先将已收到的时间线/引用投影保留到同一 Assistant 消息，再移除 live 占位；不再依赖下一次网络 hydration 才找回明细。不新增 Message/Run/Job 字段，也不改变任务终态。
- 70 项 Turn/Chat/视觉、45 项 Runtime、59 项前端时间线/恢复检查通过；架构、协议生成物检查、TypeScript/构建、diff 通过，Vite 5.80 秒。没有重跑全量门禁，没有真实 Provider 或浏览器故障注入；完整 UI 恢复验收仍单列。
- B2 还剩远端独有目标恢复、失败引用单独准备重试。远端恢复必须区分缓存缺失与本地删除/未确认同步，不能直接放宽目标检查；本批没有实现不受保护的远端读取。进度保持 10/18（56%），完整验收 0/9。无提交、发布或共享迁移。

### CP-B1 · 2026-09-05 10:56 CST · 引用实际请求反馈、安全事件与恢复

- Turn/兼容 Chat 的视觉准备记录与主模型采样接通；在传给 Provider 的实际消息上检查原图或描述是否存在，位置在 ToolLoop 上下文裁剪之后。准备成功仅显示“准备完成”，实际传入请求显示“请求含图片/请求含图片描述”；不声称模型已经理解图片。上下文裁掉的引用显示未进入请求，失败与超出 4 张的引用不再静默消失。
- 通过同一协议 catalog 增加 `references` 事件及 stage/mode/reason 枚举，生成 TS/JSON Schema 并检查一致性。只传/存 attemptId、最多 32 个引用 ID、状态/模式/原因；节点标签从现有 UI catalog 读取。服务端持久事件和实时 envelope、浏览器 SSE 与 GET 都白名单清洗，不保存 caption、图片、私有 URL、Provider body；没有新增表、Message/Run/Artifact 字段或模型请求参数。
- 复用已有 Turn Event，读取同一事件恢复历史引用反馈。核查发现 GET 原先不还原 attempt 切换，新的 text 引用可能被当作 stale 丢弃；现在从已有 `turn.output_preview.updated` 的空预览重置证据还原切换。实时旧 attempt 反馈不能覆盖新 attempt，Run 时间线合并及终态保留引用投影，历史仍不制造执行起止时间。
- 消息内使用原生 details 默认折叠，摘要只显示引用数和未采用数；展开显示每项简短状态，可定位当前存在的节点，已不在画布的节点不提供伪定位。图片与描述两种请求明确区分。此反馈区不是工具、Reasoning 或第二个“来源”区，也不承担重试生成。
- 为遵守冻结模块上限，将原有严格 overflow 重试整段原样移到 `agentOverflowRetry.mjs`，不改预算/分组/重试次数；流事件映射归还现有 `agentChatStream.ts`。Turn 主模块 1143 行、Timeline 640 行，均低于原冻结预算；没有提高 architecture 预算、引入依赖或建立新的任务状态机。
- 117 项服务端（Turn/Chat/视觉/Runtime/协议）与 74 项前端（实时/历史/时间线/读取器）聚焦检查通过。新增主路径核对实际请求中的三张图片与失败/超限状态、上下文裁剪不误标采用；恢复检查覆盖原图→描述、旧 attempt 晚到及白名单清洗；扩展既有 Runtime 测试锁定事件持久化和实时隐私。架构、协议生成物、TypeScript/构建、diff 检查通过；全量门禁留在最终集成。
- 浏览器隔离加载真实引用反馈组件，不连接 Store/API/Provider：默认收起；展开后显示 5 项，其中无权读取与超限各一项；模拟请求切换到图片/描述文案；定位回调准确为 ref-0。实测按钮高 24px、summary 可键盘聚焦（tabIndex 0），360px 容器内各行无溢出；原生截图已核查。浏览器实际视口为 1280px，未冒充整页 360/768/1440 或触屏验收。临时验证页已删除。
- B1 本地实现计入完成，进度 10/18（56%）；完整验收仍 0/9。B2 保留：目标只在远端时的恢复、准备阶段直接终止的逐项明细、失败引用单独准备重试；真实取消/切换会话和完整 UAT 仍待验。无提交、部署、共享迁移或付费生成。

### CP-B2-2 · 2026-09-05 10:44 CST · 缩略图缺失与原 Job 输出恢复（部分）

- 两个回归先失败：确认提交因引用托盘没有 image 抛出“原目标图片已不可用”；节点 image 暂缺、原 Job 仍有确切候选输出时，目标图片解析返回 undefined。
- 删除确认流程按托盘 image 判定原媒体不存在的重复预检查。继续保留原请求快照的 targetNodeId；实际接续仍经过既有 `resolveBotanicAgentContinuationTarget`，无法解析时停止，不降级为新图生成，不采用当前选中图片。确认答案先保存，不因显示缓存缺失而要求用户重新填写。
- 在现有 `agentMedia.ts` 增加只读结果图片解析，供 Canvas Agent 目标、对话媒体准备与执行前素材准备共同使用。节点 image 存在时沿用；暂缺时只接受唯一匹配的成功 Job 及确切 candidateId，缺候选身份只允许该 Job 恰有一张输出。不回填或修改节点/Job/Artifact 状态，不读取历史 Artifact 冒充当前目标。
- 排除已删除节点、缺失原 Job、模糊多图、非图片输出和已移除结果。服务端已有 Job 图片恢复路径同步保留这些排除条件；新增移除结果断言先失败后通过。权限仍由原媒体服务检查，没有额外媒体请求、网络超时调整或 Provider 调用。
- 41 项前端/领域与 50 项服务端 Turn/视觉聚焦检查通过；架构、TypeScript/构建、diff 检查通过。Vite 构建 5.73 秒，既有大包告警保留；本批未重跑全量集成门禁。本地预览现有项目画布正常挂载；项目恢复期间首次打开 Agent 未保持打开，再次打开后最终出现历史对话、已引用 3、模型与输入框，载入占位消失。未把挂载 smoke check 计为目标恢复 UAT，首次打开未保持的问题留待同构建交互验收核对。
- B 尚未完成：仅存在远端而当前文档/Job 都缺失的目标仍需通过安全读取恢复；实际发送引用的模式/失败反馈、部分引用准备重试尚未接通。本地进度仍 9/18（50%），完整验收仍 0/9；未提交、部署、迁移或付费生成。

### CP-B2 · 2026-09-05 10:39 CST · 目标读取失败时停止原生视觉请求（部分）

- 通过现有 Turn 测试复现：原生视觉模型 `gemini-3.7-flash` 的指定目标媒体读取返回 403，旁图读取成功时，主模型仍被调用，未抛出预期的 `AGENT_TARGET_VISION_UNAVAILABLE`。仅使用模拟媒体读取和 Provider，没有真实网络/付费请求。
- 原因：原生视觉分支只检查是否存在任意图片，虽将 `targetVision.ready` 设为 false，却只在后续生成工具中拦截；主模型的普通文字响应绕过该保护。现在在发出原生视觉请求前复用既有目标错误函数，caption 分支也复用同一函数；未变更模型能力目录、视觉上限、Provider 参数、媒体权限或持久化。
- 关键回归明确断言目标错误且主模型调用数为 0；既有目标不可读/caption 保护继续通过。已运行 Turn 与视觉模块的聚焦测试、架构及 diff 检查；无前端代码修改，本批不重跑构建或全量测试。
- 继续保留待修：前端确认流程仍以缩略图判断可用性，目标解析还要求本地图像和 recipe；需要接通权威恢复，不能仅删除前端检查。实际采用状态、部分引用失败与恢复也未完成。因此 B2 不计为完整完成，本地进度仍为 9/18（50%），完整验收 0/9。

### CP-A0 · 2026-09-05 10:33 CST · 项目加载重入与退出闭环

- 使用实际 `CanvasWorkspace` 加隔离的可控读取端口复现：一个项目导航出现两次读取，读取 resolve 后仍显示“载入项目”，浏览器断言报错。稳定回调后复测仍发现 `popstate`/`hashchange` 重复入队，未将第一次局部修改冒充修复完成。
- 根因：`setWorkspaceView` 随恢复状态改变导致导航 effect 清理；两套初始化/导航队列又对同一 hash 重复读取，串行等待阻塞后续项目，旧超时只改显示而没有使旧读取失效。
- 在现有 `canvasWorkspaceNavigation.ts` 内统一冷启动、列表打开和历史导航；同位置事件共用一次读取，新位置立即使旧读取失效，不等旧 Promise。沿用 45 秒上限；失败显示“项目读取失败 / 重试 / 返回项目”，不清数据、不假设项目不存在、不创建新会话或任务。
- Store 的 `openDocument` 增加可选 AbortSignal，只抑制过期读取对当前文档的应用及后续恢复动作；同时校验已有 latest-operation 身份。后台远端刷新也经过相同门闩。没有中断持久化写入、清除 IndexedDB/Outbox 或修改网络/同步协议。
- 稳定导航回调读取最新的展示状态；恢复失败或文档身份不一致时不启动错误项目的协作。返回列表与删除当前标签使用共同退出入口。`CanvasWorkspace.tsx` 从本批开始前 2930 行降至 2852 行，未提高旧模块预算；未新建运行时模块或依赖。
- 14 项既有/新增聚焦检查通过；仅新增一个去重/切换主路径测试和一个挂起超时/返回列表关键失败测试。架构、TypeScript/构建、diff 检查通过，最终 Vite 构建 6.50 秒；既有大包告警保留。最终集成全量门禁尚未运行。
- 浏览器：实际隔离组件的读取记录由重复变为一次，完成 A 后进入 A；A 挂起时 B 可完成，晚到 A 不抢回；真实等待超过既有上限后出现错误及操作，重试仍进入 A；深链冷载也可完成。另在未注入读取端口的 localhost:4174 项目列表打开“创意项目 1”，完整深链重载后素材/文本节点仍显示。截图与 DOM 已核对；临时 HTML 已删除。隔离端口不代替真实服务端慢读/协作证据，也不把 Dev 预览当最终构建验收。
- A0 本地实现计入完成，本地进度 9/18（50%）；完整 A–I 验收仍 0/9。未提交、部署、迁移或调用真实生成 Provider。

### CP-F2 · 2026-09-05 10:24 CST · 取消/重试反馈与停止确认投影（部分）

- 任务面板和对话卡共用 `useAgentRunOperations`，同 Run 的取消/重试互斥；Store 返回 false 与抛错都显示错误并释放操作入口。请求反馈不改 Run/Job 终态，跨项目旧回调由作用域隔离。
- 取消 API 保留现有响应中的 `cancellation.failures`；Store 先应用权威 Run，再区分部分失败和仅等待 ACK，避免 HTTP 200 被当作完整取消成功。没有改变服务端取消协议、权限、幂等键或持久化结构。
- 从当前 branch.activeJobId 对应 Job.cancel 投影停止状态；需要信号确认但未收到 ACK/Worker 未释放时显示“正在停止…”，计入进行中筛选，禁止重新生成，不显示本轮完成分隔线。已确认的部分取消保留成功结果数与可能计费说明。旧 attempt 的回执不参与当前判断。
- 删除浏览器端“auto 模式首个失败立即再试”的重复入口和失效测试，自动重试仍由现有 Worker 错误分类、预算及退避策略拥有。未修改 Worker 策略或扩大自动执行权限。
- 聚焦测试 110 项、服务端既有取消/分支重试测试 38 项通过；架构检查、TypeScript/构建和 diff 检查通过，本批 Vite 构建 6.19 秒。没有重复运行全量集成门禁；构建有既有大包告警，无编译错误。
- 浏览器使用临时隔离入口加载实际 TaskPanel 与操作 hook，回调不连接 Store/API/Provider：false 与异常均显示 alert，取消失败保留按钮，待 ACK 时任务留在进行中且恢复操作禁用，确认后重新开放分支操作并显示保留结果/费用。操作记录仅有 failed 分支重试与取消，没有 successful 分支请求；原生截图已检查。临时 HTML 已删除。
- 局限：模拟 ACK 不是实际 Worker 确认；真实 accepted→Run 停止交接、刷新失败缺 Job 回执、刷新后取消恢复仍未验。操作失败回执目前保留至下一次操作，需结合真实重新观测验证是否及时消除；停止期间底层分支详情仍按持久分支状态显示。F1 未知结果入口也未完成，因此进度仍为 8/18、完整验收 0/9。无提交、部署、迁移或付费生成。

### CP-F1 · 2026-09-05 10:12 CST · 原 Turn 核对与整轮重放保护（部分）

- 已复现读取器遗漏：服务端返回的 Turn 状态未随事件读取结果返回，新增实际读取测试先失败（`undefined !== completed`）再修复。只增加本地只读投影，不修改 HTTP 响应或持久化结构；同时保留“是否存在非只读/缺风险声明的工具”证据，不能把展示清洗器默认 `read` 当成安全重试依据。
- 历史消息恢复及 Composer 中带 Turn 身份的重试不再直接新建请求。新协调 hook 复用现有 GET Turn Events / Run 列表，身份校验和原 observer；已有 Run 打开任务，运行/取消中/等待确认/已有完成结果只观察原 Turn。原快照及取消意图沿用，不覆盖当前输入草稿。
- 只有已证实失败、完整读取历史、无非只读工具、无已有结果且错误属于明确的 Provider 瞬时失败才保留新请求重试。`AGENT_TOOL_OUTCOME_UNKNOWN`、不可重放、未知错误、写/计费/外部工具、缺风险证据及分页未读完均禁止重放整轮。此保护不替代服务端授权或幂等校验。
- UI 改为“恢复本轮”，预读期间“正在核对…”且禁用；同一发送锁防连点，切换项目/会话中止读取并丢弃旧响应。协调模块没有新增任务权威状态；手动观察请求只复用现有恢复 effect。
- 43 项 Turn/恢复/事件读取/hydration 聚焦检查通过，额外 Composer 既有检查通过；TypeScript、架构、diff 检查通过，最终构建 6.35 秒。新增两项分流/关键禁止路径检查，未引入测试框架。
- 浏览器两个现有页曾同时停在“载入项目”；4174 模块 GET 实际 200，无 Vite 错误覆盖层。隔离页完整刷新后恢复，Agent 可打开，上一批海边人像计划及参数仍在。仅证明挂载与计划保留，不是失败任务恢复的端到端证明；热更新载入停滞归 A0 继续处理。未点击真实失败任务恢复或触发 Provider。
- F1 仍有任务面板取消/重试失败反馈、未知结果专用操作等工作；F2 的 accepted/Run 交接与刷新取消未完整验收，因此本地完成比例维持 8/18，完整验收 0/9。没有提交、部署或共享数据库变更。

### CP-D1 · 2026-09-05 10:04 CST · 默认参数不等于执行授权

- 修改现有 `agentCreativeBrief.ts` 及两份既有测试，未增加模块。普通生成在手动模式也补齐所选模型支持的比例、清晰度和保真方向，直接进入计划；单独 Prompt 优化的追问逻辑不变，执行决策仍走原来的 manual confirmation。
- 明确比例不再被“小红书”等推断用途覆盖；用户已确认的清晰度在换模型后不支持时明确失败，不静默降级。选择“自定义比例”时清除既有默认比例，仍要求填写，不把默认值冒充用户确认。
- 聚焦检查 152 项通过，包含默认生成仍需确认、明确比例优先及不支持清晰度的关键失败路径；架构、diff 检查通过，本批构建 5.95 秒通过。不重复跑全量发布门禁。
- 隔离本地预览 localhost:4174 实际输入“生成一张海边人像”，无前置用途/清晰度问卷，直接显示可编辑 GPT Image 2 / 3:4 / 2K / 1 张及原提示词；“生成”按钮保留且未点击。DOM 与原生截图已核对，当前 1158px 视口 `scrollWidth === clientWidth`，不冒充三档响应式验收。
- 本批不调用生成服务、不写共享环境。Plan → GenerationJob 的关联参数、刷新原设置、批量/外部行为及模型标识的完整 UI 仍按 D/I 留待验收；本地实现 8/18，完整验收仍为 0/9。

### CP-G1/H1 · 2026-09-05 10:00 CST · 历史时间证据与单层分隔线

- 历史工具 hydration 不再调用 `createAgentTimeline(Date.now())` 或在每页读取后补 done；首读、续页共用同一事件处理。只有真实 running 事件提供开始时间，终态事件提供结束时间；只有成功回执而缺少开始记录时用时保留未知，不把成功时刻同时当开始。
- 缺少完整时间证据时折叠标题显示“执行记录”，步骤仍可显示“—”；有真实起止事件时跨页计算时差。没有修改持久化或运行权威状态。
- 分隔线改为显式 `data-settled` 投影：用户消息、流式回复、等待确认/计划、运行/取消中及缺 Run 快照时均不画完成线；终态回复最多一条。去掉原来所有消息额外的 12px 顶部 padding，只在实际分隔线后保留它；正文 Markdown hr 不受影响。
- 工具展开区移除额外横线，折叠标题元数据从 11px 调整为 12px。38 项相关检查、架构、diff 检查通过；本批构建 6.23 秒通过。按用户要求不在这两个局部修复后再跑全量测试；最终集成门禁仍保留。
- localhost:4173 当前页面 DOM 验证：9 条用户消息前的伪元素均为 none，历史确认卡前为 none，执行记录标题下边框为 0px；仅 1 个 Bob，无页面级横向溢出，原生截图已附对话。
- 页面部分工具仍显示 `<1秒`；不能单凭该文案断言错误或声称已证明全 Turn 总用时。新检查只证明实际事件起止 1000→4500 显示 3500ms，分页未结束不制造终态，缺时间不造数。完整 Turn 总时长、并行记录、等待用户文本消息、三档宽度和触控仍待后续验收。
- 进度改为“18 子项本地实现 / 9 大包完整验收”双层记录，未缩减原目标。没有提交、部署或触发生成。

### CP-A4 · 2026-09-05 09:52 CST · Run 恢复丢失 Turn 关联

- 已定位根因：服务端 Run 的权威关联在顶层 `turnId`，安全 `plan` 不包含该字段；前端快照类型和恢复映射遗漏它，而确认卡使用现有 `plan.turnId` 查找已接续任务。不是缺少新身份字段，不需要按正文/时间猜测或回填历史记录。
- 先扩展已有恢复测试并新增一条同时间戳失败路径，两项实际断言均因 `undefined !== turn-original` 失败。修复后首次恢复映射顶层 Turn 到已有浏览器计划字段；已缓存 Run 在相同/较早时间戳下也可补齐缺失关联，但不回退进度、不更换既有关联，不覆盖完整执行计划。
- 按既有 Run 快照行为边界迁出 merge/upsert 到 `agentRunSnapshot.ts`（86 行），Store 直接使用；不保留造成循环依赖的反向 re-export。`agent.ts` 从 2228 降为 2147 行，架构预算未调整。Store 仍只更新只读投影及本地缓存，不反向写服务端图谱。
- 聚焦检查 113 项通过。首轮全量有 20 项本机监听 EPERM（1962 通过、20 失败、2 跳过）；获准本机测试端口后完整重跑：1982 服务端/脚本 + 810 前端/领域 = 2792 项通过，0 失败、2 项可选 PostgreSQL 跳过。日志 `botanic-agent-a4-tests-verified.log`；构建 6.26 秒、架构、diff 检查通过，保留既有体积警告。
- 原项目 localhost:4173 先完整刷新再打开 Agent：DOM 实测 `继续规划` 为 0、历史设置卡为 1、完成加载的消息图片为 1；点击历史卡的“查看任务”打开 9/4 21:12 的已完成任务，没有重新规划或生成。返回对话后卡片和两项引用仍在；未把这个操作计为阅读锚点完整验收（旧卡不在返回后的当前视口）。
- A 仍待验/待修：对应 Turn 当前问题的提交前核对、未完成确认刷新接续、跨设备完整链路、浏览器缩略图暂缺的目标校验、A0 冷启动/失败出口。同步超时、历史工具用时 `<1秒` 等其他包问题仍保留；总进度不虚增。
- 本轮没有提交、推送、部署、共享数据库迁移或真实生成。

### CP-E3 · 2026-09-05 09:41 CST · 精确结果入口与当前门禁

- 消息内“继续修改”改为调用既有单 Artifact 入口，移除整组输出/旧上下文回退。单项直接绑定，多项使用已有 BotanicSelect 展示带缩略图的选项，只提交用户选中的 Artifact；没有新增选择器库或复制领域状态。
- 定位仅使用当前存在的节点；历史媒体没有节点时仍提供结果面板入口。继续入口在项目已切换或无法建立目标时返回 false，调用方不再用成功话术覆盖草稿。
- 消息、已提交计划两处结果操作统一可见文字；Workspace 3910 行、消息 1422 行、执行桥接 803 行，均未提高架构预算。
- 聚焦既有领域、消息、索引、附件检查：106 项通过。最终 npm test：1982 服务端/脚本 + 809 前端/领域 = 2791 项通过，0 失败、2 项可选 PostgreSQL 检查跳过（本轮临时 PostgreSQL 未启用）。构建、架构、diff 检查通过；构建仍有既有分包体积警告。
- 浏览器使用当前 localhost:4173 原项目：DOM 断言对应消息含 1 张完成加载（naturalWidth > 0）的真实图片和“定位画布 / 继续修改”；点击定位后实际选中对应结果节点，原生截图已附本轮对话。仅改变视口/节点选择，没有发送或生成，也未点击会改变原会话引用的继续操作。
- 尚未验收：多图选择键盘/触屏、已删节点重新引用、真实历史分页 HTTP 竞态、辅助面板返回上下文与指定结果实际接续。旧确认卡仍有“继续规划”，历史时间仍见“<1秒”，同步仍有超时/同步中，不能把当前门禁通过当作完整目标完成。
- 本轮未提交、推送、部署、共享数据库迁移或真实生成。总进度仍为 0/9 包全部验收，不缩减 A–I 目标。

### CP-C1/C2 · 2026-09-05 09:41 CST · 共同同步重试与保留回写

- 补记此前已实现的 Canvas/Agent 共同重试入口：在途去重、无实例拒绝、安全失败文案、项目/实例切换隔离。同步状态仍由协作握手与 Outbox ACK 决定，不在 retry resolve 时设置 synced。
- 本轮把 Agent 已完成结果的提前保留分支扩展到 Store 已有的 reconnecting / syncing / blocked 三种写入受限状态；保留 canvasWritebackPending 与既有回执，不重新执行生成。
- 同步领域与共同入口 13 项检查已通过，并包含在本轮 2791 项通过的全量测试中。当前浏览器可见“协作连接超时，请重试”，重试/自动恢复过程仍有“正在同步”，没有获得真实 durable ACK 成功证明。
- C 尚未完成：网络恢复、权限未恢复、写回续接不重复与跨项目真实交互还需验收；不能把 UI 错误提示修复说成服务端连接问题已经解决。

### CP-E2 · 2026-09-05 09:37 CST · 分页合并与失败读取范围修复

- 从旧执行桥接移出的同 ID 忽略算法实际触发断言失败：较新的 savedToLibrary 未进入读模型。改为接受相同/较新 updatedAt，迟到旧页不回退；首次刷新与历史加载共用合并，保留已加载历史。
- 新 useAgentArtifactIndex 只拥有索引请求、游标和取消：在途请求去重；项目/刷新变化取消旧请求；失败分为首页 error 与更多页 error-more；重试使用对应读取范围。首页刷新重新使用该次返回游标，不拿缓存数量冒充历史穷尽。
- 消息与结果面板识别更多页失败；保留现有图片，不同时显示读取失败和“没有结果”。本地模式无远端索引时不永久停在 idle 等待态；关闭面板不主动清空已读缓存。
- 验证：结果索引与消息工具共 12 项通过，0 失败、0 跳过；架构、diff 检查通过。完成分页迁出及首轮合并后的构建通过；随后读取范围判断的最终集成构建仍须重跑。
- 新测试仅一条合并主路径、一条失败读取范围路径，复用 node:test。异步取消的实际 HTTP 竞态、真实第 101 项以后结果及浏览器完整验收仍待补证，E 暂不计入总完成数。
- 没有改服务端索引权威、HTTP 接口、数据库或生成语义。

### CP-E1 · 2026-09-05 09:32 CST · 结果读取范围判断已接入消息

- 上一轮方案复核取得当前测试无法加载的新证据，本轮先闭合在途实现，没有重新执行已经通过的旧方案步骤。
- 修复前再次运行消息工具测试，确认缺少 botanicAgentRunResultReadState 导出导致加载失败；这不是分页行为断言红灯，不将其包装成完整运行时复现。
- 已在现有 agentMessageUtilities 补齐读取投影，并由 AgentWorkspace 将 artifactIndexHasMore 传入 AgentConversationMessage 的实际结果区域。仍有历史页时显示“结果尚未载入 / 加载结果”；索引失败、读取中、范围已穷尽分别展示；已有媒体结果不被读取状态遮住，非媒体任务不强制显示缺图。
- 验证：node --experimental-strip-types --test src/domain/agentMessageUtilities.test.ts：10 项通过，0 失败、0 跳过；check:architecture、git diff --check 通过。未新增第三套结果状态或 API，加载入口复用已有 Artifact 读取。
- 仍需 E2 修复首次/更多失败区分、分页更新合并及刷新保留历史；E3 修复单张目标与已删节点。浏览器真实历史分页和最终构建验收未完成，E 不计入总完成数。
- 技能：TDD 沿既定消息展示判断 seam 完成红/绿并接线；Ponytail 复用现有模块。没有提交、推送、部署、共享数据库迁移或真实生成。

### CP-A2 · 2026-09-05 08:43 CST · 回执边界、历史快照与 SQL 同步路径修复

- 上一轮复核取得两项真实契约断言失败的证据；本轮继续实施，没有把方案文档当作修复完成。
- 已修复：恢复仅使用原请求的模型、模式、引用与技能；必要快照不完整时拒绝借用当前设置。原消息不在当前页时按现有接口最多读取 10 页，重复游标或会话切换停止，不无界扫描。
- 新增确定性回归实际复现“缺失回执仍删除队列项”。共享队列交付现在验证消息 ID、作者角色、正文与创建时间；无效回执保留原消息，不标记已送达，不放行 Turn。现有成功测试改用真实形状的回执，未保留 void 假成功兼容。
- 两项失败的静态契约已核对当前行为归属：确认接续改为检查已保存的 acceptedQuestion；Supabase 冲突翻译检查共同 fail 入口。确认测试同时验证实际服务端采用的生成意图，而非只检查源码文本。
- 完整 RPC 测试发现并复现此前 helper 测试未覆盖的两个数据库错误：8 参同步函数的 JSON 锁键拼接导致 22P02；10 参函数提取 payload 后删除字段导致 42725。CLI 新建本地纠正迁移 20260905004125_agent_entity_sync_jsonb_precedence.sql，仅为这三处表达式加括号，保留原函数体、签名、权限和合并规则，不改已发布历史迁移。
- SQL 验证通过：真实 7 参 PUT → 6/5 参写入、11 参 sync → 10/9/8 参写入；较早时间确认可推进，旧 pending 不回退，不同答案两条入口均拒绝，viewer 不可写，缺 capability 拒绝，anon/authenticated 无 execute 权限。仅连接级临时对象，事务回滚；不是共享 Supabase/PostgREST 线上证明。
- 聚焦 40 项通过；含临时 PostgreSQL 的迁移/Adapter 契约 8 项通过且无跳过。全量 npm test：1984 + 803 = 2787 项通过，0 失败、0 跳过。此前端口 EPERM 的实时测试已在允许本地端口的环境复跑通过。构建、架构检查与 diff 检查通过。
- 新增 SQL 后仅测试/迁移发生变化，应用构建已验证；浏览器同版本闭环、实际三个 Adapter 端到端和多设备交互仍待完成，A 暂不计入 9 包完成数。
- 本轮未提交、推送、部署、执行共享数据库迁移或调用真实生成 Provider。Supabase 技能促使验证完整 RPC/执行权限，而不是只依赖 helper 与源码断言；权限原则已对照 [官方函数文档](https://supabase.com/docs/guides/database/functions)。

### CP-A1 · 2026-09-05 08:14 CST · 确认交付与旧状态回退已修复，A 继续验收

- 本次推进依据：上一轮聚焦测试 14 项中 1 项失败，实际复现“另一设备的旧答案覆盖服务端已确认内容”；不是重复执行计划。
- 已修复前端读模型：同一问题的已确认答案，以及同一稳定 Turn 的 Plan/Run/失败终态，不被旧问题和领先客户端时钟回退。
- 消息队列现在返回本次权威回执；发送中被新快照取代的旧回执不参与投影，不持久化第二份回执状态。
- 确认接续使用服务端实际采用的答案 Message 内容与时间；已演进为 Plan 的回执不重复接续。原请求快照与稳定答案身份保持不变。
- 修复后台 deliveryStatus 抢切当前会话；不推高领域时间、不回写云端文档。Supabase 直接写与兼容同步共用已有错误入口，移除重复翻译，架构行数门禁恢复通过。
- 验证：消息合并/确认/队列 31 项通过；Store 与 Supabase 写入口契约 10 项通过；临时 PostgreSQL 实际 SQL 与 JS 对照及迁移契约 7 项通过（未跳过）。`check:architecture` 通过。
- 验证中：构建发现一个回执 sessionId 的 TypeScript 收窄问题，已修正，待重跑构建与全量测试。
- A 尚未完成：真实多设备/刷新浏览器闭环、完整 RPC/Adapter 写路径验证、历史原请求分页加载与旧快照恢复边界仍需完成；不计入总体已完成进度。
- SQL 只在本机隔离临时 PostgreSQL 中验证 helper；没有对 staging/生产执行迁移，没有提交、推送、部署或调用真实生成 Provider。

### CP-00 · 2026-09-05 06:59 CST · 基线已记录

- HEAD：`7810a84ba4be744227fa013c3e5de179441393bc`，工作分支 `feat/agent-elements-p1-p2`。
- 起始工作树：43 个 tracked 修改（含用户更新的 AGENTS.md），12 个 untracked 文件。本进度文件不计入起始基线。
- 已读取当前 AGENTS.md、产品/模块所有权及相关持久化 ADR；实现沿用既有消息交付、恢复与权限边界。
- 当前动作：为 A 建立旧确认卡仍可提交的可复现检查；尚未认定具体持久化根因。
- 本地开发起点，不代表任何功能包已完成；未提交、未推送、未部署。
