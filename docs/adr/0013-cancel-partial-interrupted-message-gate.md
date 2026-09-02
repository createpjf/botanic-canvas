# ADR 0013：Cancel Partial / interrupted Message 进入门槛（未采纳）

## 状态

Gate，未采纳。先收集 ADR 0012 TurnOutputPreview 的生产事实；未满足样本与产品证据前，取消继续只保留 notice，不持久化 partial answer。

## 背景

TurnOutputPreview 让运行中的用户可见 answer 可以跨刷新恢复，但所有终态都会清除。Cancel Partial 会进一步把取消时的不完整文本升级为长期 Agent Message，并影响线程上下文、Memory、反馈、搜索、导出与保留策略。该变化难以回滚，不能仅凭“技术上已有preview”自动启用。

## 已部署指标

### 服务端 semantic / OTel

每个 Turn 终态最多写一条 content-free summary：

- `preview_settled`：completed / waiting_user / failed。
- `preview_cancelled`：cancelled finalizer首次胜出时。
- `writeCount`：该Turn preview revision/写入次数。
- `maxCharCount`：终态前最大preview字符数；取消样本为取消时当前字符数。
- `nonEmptyCount`：取消时preview是否包含非空正文(0/1)。

Operational/OTel 指标：

- `previewWriteP50Count / P95Count`
- `previewMaxCharP50Count / P95Count`（非取消终态的运行期峰值）
- `previewCancelCharP50Count / P95Count`（取消当时的当前正文大小）
- `previewCancelSampleCount`
- `previewCancelNonEmptyRate`
- `botanic.agent.preview.write_count`
- `botanic.agent.preview.max_char_count`
- `botanic.agent.preview.nonempty`

所有事件不含正文、Prompt、URL、Tool参数或实体ID。

### 浏览器 Sentry

- `agent_turn_preview_observer_started`：GET observer首次看到active Turn。
- `agent_turn_preview_recovered`：该observer首次把durable preview replace到UI。

恢复命中率：

```text
count(agent_turn_preview_recovered)
----------------------------------
count(agent_turn_preview_observer_started)
```

事件只带固定 `component=agent-preview` 与 `operation=turn_observer` 标签。

## 进入评审的最低样本

同时满足：

1. 连续观察至少14天。
2. 至少1000个有preview summary的Turn。
3. 至少100个cancelled Turn。
4. 至少50个active observer sessions。
5. terminal Turn残留preview、Event正文泄漏、旧attempt恢复错误均为0。
6. Preview写入未造成Store延迟或失败率可见回归；P95写入次数建议不高于24，超过则先调节flush节奏。

## 接受 interrupted Message 的产品证据

以下条件同时满足才进入“接受”评审：

- `previewCancelNonEmptyRate >= 25%`，说明取消经常发生在已有可读正文后。
- Sentry恢复命中存在稳定样本，证明用户确实跨刷新消费preview。
- 用户访谈、支持工单或可用性测试明确显示“Stop后文字消失”造成损失；技术比例不能替代产品证据。
- 安全评审同意不完整模型文本进入长期数据保留、导出和删除边界。

若取消非空率低、没有用户证据或写入成本未稳定，维持现有cancel notice。

## 若未来接受

另起实现变更：

- Message新增 `status: interrupted`，稳定ID仍由Turn派生。
- interrupted Message不进入模型线程上下文、Memory、Plan/Run/Artifact、反馈或自动执行。
- 可复制和显式重新执行；重新执行创建新Turn。
- Server cancellation terminal transaction负责冻结preview并upsert Message；客户端不得自报partial。
- Preview为空时继续使用现有cancel notice。

## 当前决策

本ADR只建立数据采集和Gate，不改变Message schema或取消后的产品展示。
