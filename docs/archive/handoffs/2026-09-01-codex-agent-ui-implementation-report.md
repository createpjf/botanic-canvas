# Codex Agent UI 对照升级 — 最终交付报告

日期:2026-09-01。分支:`harness-reliability-20260901`。参考源码:Codex `rust-v0.152.0@316795b3`。

## 交付提交

| 提交 | 内容 |
| --- | --- |
| `3b766c0` | Composer完整transient state按project/session隔离;sessionStorage恢复instruction+caret;dismissed mention token |
| `f0a3006` | 当前Session用户消息派生Up/Down输入历史;中文友好fuzzy建议 |
| `511891f` | queue-after-turn(最多3条)、chips/弹回/FIFO、冻结UI执行快照;Workspace队列实现下沉hook |
| `65d5408` | 本地read/read_skill 300ms reveal + 600ms linger +「已读取N项」可展开摘要 |
| `e10d645` | Timeline从nextAfter安全继续GET并单调合并;聊天消息“更多活动” |
| `512f840` | Subagent fanout启动/完成通过同一toolCall ID投影到root Turn/聊天时间线 |
| `ad37cac` | `/new/history/skills/tasks/results/memory`本地命令;≥1000字paste placeholder,发送前展开 |
| `82e17f4` | UAT发现立即reload在debounce前丢草稿→pagehide同步flush;React Doctor render-ref错误修复 |

## 产品逻辑

### Composer

- 草稿、错误、重试状态、队列均按Agent Session隔离。sessionStorage只保存展开后的文本+caret;Context/Skill/错误/恢复快照不入存储。
- Esc关闭同一`/`/`@` token后保持关闭;编辑token恢复菜单。
- 空输入Up召回最近用户指令;只有未修改召回文本且caret在边界才继续遍历,不劫持多行编辑。
- `/`菜单命令与Skill分组,共用fuzzy/方向键/disabled-skip;本地命令不提交模型。
- 大粘贴显示placeholder;删除placeholder清映射;send/queue/session draft使用展开原文;Terminal PasteBurst未移植。

### Queue-after-turn

- 运行中Enter或队列图标入队,最多3条;不提前创建User Message,不触发并发Turn。
- 入队冻结model/mode/mounted Skill IDs/session context IDs/Context items/target/group/intent/generation overrides。
- 只有当前阶段completed才FIFO发送;failed/idle且输入空时弹回第一条;waiting confirmation/clarification保持chips。
- 队列在内存中,不把图片或执行快照写sessionStorage。

### Timeline

- 仅本地read/read_skill降噪;external/write/costly/error/aborted/web source永远可见。
- Subagent进度只含角度count/完成数/状态;不含子任务Prompt/raw output。
- 继续加载只走`GET /api/agent-turns/:id?after`;不进入POST/observer执行;详细轨迹仍只含安全presentation。

## 验证

- 全量:773 tests / architecture / Agent Protocol artifacts / TypeScript+Vite build / diff check 全绿。
- React Doctor:初扫发现2个render-ref错误并修复;最终扫描见本轮会话日志,无新增error。
- Chromium Composer V2 UAT 1/1:
  - Esc dismissed token
  - `/skills`本地命令
  - 1100字paste placeholder
  - 慢Turn期间第二条入队,FIFO产生2个durable completed Turn
  - reload恢复第二条回答
  - Up召回最近输入
  - 立即reload恢复草稿(pagehide路径)
- 既有Turn UAT 2/2:accepted后reload恢复且Provider不重跑;执行中Stop不产出最终回答。
- 桌面1280×720与移动390×844截图检查:queue chip/count/Stop无重叠、溢出或裁切;Agent面板移动sheet正常。
- 专用`analyze_image`模型未配置;截图改用当前模型直接读取检查。

## 未移植(有意)

raw tool output/reasoning transcript、mid-turn steer、thread fork/backtrack、Terminal PasteBurst/Vim/外部编辑器、shell审批、可见快捷键教学行。它们分别违反Botanic隐私/durable Turn/Artifact血缘/产品受众/UI文案边界。

## 数据与部署影响

- 无数据库schema/migration/ProductStore/Supabase Adapter变更。
- 前端状态与安全Turn Event presentation为additive;Railway正常build/deploy即可。
- Queue不持久化为Message直到真正flush;原幂等、恢复、深取消语义不变。
