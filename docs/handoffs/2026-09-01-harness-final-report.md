# Bob Agent Core 可靠性升级 — 最终交付报告(2026-09-01)

## 阶段与实施基线

- 实施基线 SHA:`a05e564`(本地 origin/main;`git fetch` 因本机代理 127.0.0.1:1082 不可用,维护者批准以此为基线)
- 工作分支:`harness-reliability-20260901`
- 交付范围:H0→H7 全部 change set;H8 按计划不实施(未有指标证明串行读取是瓶颈)
- H3C Provider retry:按进入条件**未启用**——H0 没有 transport/429/5xx 失败样本;retry 相关计数口径已随 H7 落地(`providerRetryCount` 恒 0 直到有真实样本)

## 提交清单(每 change set 一个中文提交)

| 阶段 | 提交 | 摘要 |
|---|---|---|
| H0 | fcb64ce | 基线同步与九项红灯复现证据 |
| H1 | d55ee1a | 挂载 Skill 契约 fail-closed(16 上限/依赖 closure/预算,无截断) |
| H2 | d9448d6 | 根取消信号贯穿工具循环、web 工具与子任务 |
| H3A | 5c27cab | Turn 顶层 deadlineAt、恢复代际上限、Planner 单次调用超时 |
| H3B | 333ddba | durable submission waiter 有界退避 + 503 收口 |
| H4 | b33289b | 工具错误三分法、整批配对、无进展环检测、final synthesis |
| H5 | 26e2978 | Skill Loader V2:Turn 冻结 catalog 与恢复版本 pin |
| H6G+H6A | 50381e7 | ADR 0004/0008 修订(维护者批准)+ Checkpoint V2 reader |
| H6B | 16fffc4 | 外部读取逐 call journal,恢复复用结果、禁止盲目重放 |
| H7 | 6645d2c | harness lifecycle 语义事件与运维指标口径 |

## 已验证行为(本地,全部通过)

- 九项 H0 红灯全部转绿(probe 验证,不提交 probe)
- 每 change set ≤1 主路径 + 1 关键失败路径新测试,复用现有 seam
- 仓库门禁:`npm test`(756 pass)、`npm run check:architecture`、`npm run build`、`git diff --check` 每阶段通过
- ADR:0004(deadline/三分法/final synthesis/H6G V2 规则)、0008(envelope 例外)、0010(fail-closed 与冻结 catalog)已增补
- `docs/ARCHITECTURE.md` 新增 Bob Agent Core 一节:与 codex core 不变量逐项映射

## Definition of Done 核对(§0)

| 条目 | 状态 |
|---|---|
| Skill 无静默丢失/截断/依赖降级/漂移 | 完成(H1+H5) |
| 根取消到达 Provider/工具/子任务 | 完成(H2) |
| 四类 timeout 独立且错误码可区分 | 完成(H3A;retry deadline 项随 H3C 未启用,现约束为 0 次 retry) |
| 每个 tool call 恰好一个终态,副作用最多一次 | 完成(H4+H6B) |
| 三类错误不互相伪装 | 完成(H4) |
| budget 耗尽后一次禁用工具综合 | 完成(H4) |
| 崩溃恢复不盲目重放已派发调用 | 完成(H6B;unknown 禁止自动重放) |
| 指标可按版本比较 | 完成(H7,harness 族) |
| 聚焦/全量/架构/构建/diff | 完成 |
| staging 多实例故障注入 | **未执行**(需 staging 环境,见下) |
| 真实 Provider 小流量 | **未执行**(不得用真实 Provider 做普通开发测试;需授权) |
| 浏览器刷新恢复 UAT | **未执行**(需人工浏览器验证) |
| 生产灰度零容忍指标 | **未执行**(需部署) |

## 证据分层(§9.3)

1. 本地单元/契约测试:**绿**(756 pass)
2. 分支与 commit:`harness-reliability-20260901` @ 6645d2c(基线 a05e564)
3. 数据库/迁移:**无迁移**;`deadlineAt`/`skillCatalogSnapshot`/Checkpoint V2 全部走既有 JSON payload,三 Adapter 契约测试证明 round-trip
4. staging 多实例故障注入:未执行——需要维护者提供 staging 环境
5. 真实 Provider 小流量:未执行——需要授权与凭据
6. 浏览器 UAT:未执行
7. 生产 cohort:未执行

**某一层绿色不能替代下一层。当前只能宣称本地验证完成,不能宣称生产可靠性已交付。**

## 数据库/部署状态

- 无新迁移、无部署、无推送(遵守交接规范:未经维护者要求不推送/不建 PR)
- 发布顺序约束:H6A reader 必须先于 H6B writer 全量部署(journal call 进入 pendingStep 即写 V2 checkpoint,旧实例读不懂 V2 会拒绝恢复)

## 残余风险

1. `git fetch` 一直不可用:若真实远端已超前 a05e564,需重跑 §4 短审计后 rebase
2. H6B writer 与 H6A reader 同版发布:单实例开发无影响;多实例滚动部署必须先全量 reader(见上)
3. 真实 Provider 的流式/重试行为只被 fake 覆盖;H3C 待生产失败样本再决定启用
4. `skillCatalogSnapshot` 使 durable request 略增大(内置 snapshot ≈4.4KB);监控 Turn payload 尺寸
5. 零容忍指标(started_after_cancel 等)目前只有本地口径;staging/生产窗口未建立 baseline

## 下一阶段建议

1. 代理恢复后 fresh fetch,确认远端与 a05e564 的关系
2. 维护者审阅分支后推送到远端工作分支
3. staging 双实例故障注入(§10.2 六项)
4. 真实 Provider 小流量 + 浏览器刷新/取消/恢复 UAT
5. 生产灰度按内部→5%→25%→100%,任一零容忍指标 >0 即停
