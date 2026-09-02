# P0-6 迁移上线与真实环境验收

验收日期：2026-08-04（Asia/Shanghai）

## 上线范围

- 业务数据继续以 Railway PostgreSQL 为唯一生产存储；Supabase 项目仅承担 Auth，不执行重复的业务表迁移。
- API 启动事务创建并回填 `agent_sessions`、`agent_messages`、`agent_memory_items`、`agent_artifacts`。
- Worker 使用同一套持久化与 Artifact Index 写入路径，持续索引新生成结果。
- Vercel 前端启用服务端 Artifact Index 消费、历史结果定位、下载、入库与继续修改入口。

## 发布记录

| 组件 | 结果 | 发布标识 |
| --- | --- | --- |
| Railway API 首次迁移 | 已失败并自动回滚 | `449a2c5e-5e4b-46f1-8e87-575da885bb99` |
| Railway API 修复后迁移 | SUCCESS | `f4e10cb5-2991-4268-ac8e-a686570d15e5` |
| Railway Worker | SUCCESS | `c1113808-bc75-4248-a036-4699f99ef174` |
| Vercel Production | READY | `dpl_CasCMfJ4xTis6jfSyLvfPQnPJseW` |

首次 API 启动失败原因是 PostgreSQL 运算符优先级把 Artifact ID 拼接解析为 `text ->> 'id'`。迁移事务未留下任何新表；修复为先执行 `(output->>'id')` 再拼接，并增加 Railway 与 Supabase 两条迁移路径的回归断言后重新发布。

## 数据迁移对账

迁移前：

- `projects=13`
- `agent_runs=4`
- 新独立表均不存在
- 旧项目文档中可回填 `agent_sessions=4`、`agent_messages=22`、`agent_memory_items=0`

迁移后：

- `agent_sessions=4`
- `agent_messages=22`
- `agent_memory_items=0`
- `agent_artifacts=40`
- Artifact 期望数 `40`、缺失数 `0`、畸形 payload 数 `0`
- 当前历史 Artifact 均来自 `generation_output=40`；生产数据中暂没有可回填的 `agent_action` Artifact

## 验收结果

- Railway API `/api/health`：HTTP 200，`persistence=postgres`、`auth=supabase`、`queue=redis`。
- Vercel 代理 `/api/health`：HTTP 200，与 Railway 返回一致。
- 未登录访问 Artifact Index：HTTP 401，返回 `AUTH_REQUIRED`，未暴露项目存在性或 Artifact 数据。
- 新 API 最近 15 分钟无 5xx；新 Worker 无 error 日志，启动并发为 3。
- 真实 Chromium 打开生产域名成功，标题与登录页渲染正常；控制台 0 error、0 warning。
- 发布前全量门禁：服务端 175 项、客户端 116 项测试通过；生产构建、架构检查、安全检查和 `git diff --check` 通过。

## 尚未宣称通过

- 未使用真实 Owner、Editor、Viewer 凭据执行线上角色矩阵与已登录 Artifact UI 操作。
- 未触发真实图片或视频生成，因此没有消耗生产额度，也未验证“新任务完成后索引从 40 增至 41”的在线写入样本。
- Supabase Auth 安全顾问仍提示 leaked password protection 未启用；该项不属于本次业务数据迁移，但应进入后续安全收口。

## 回滚边界

- API/Worker 可回滚到上一成功部署；本次表结构为加法迁移，旧版本不会读取新表。
- 数据库迁移由单事务和 advisory lock 保护；首次失败已验证会完整回滚。
- 已完成的历史回填为幂等 upsert。重复启动不会重复增加 Artifact；不应直接删除新表作为常规回滚手段。
