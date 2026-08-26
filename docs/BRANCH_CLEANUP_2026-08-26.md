# 分支清理记录 2026-08-26

删除了 38 个远端分支，清理后服务端剩 10 个。

## 判据

本仓库使用 **squash merge**，因此已合并的分支相对 `main` 仍显示「领先若干提交」——
`git branch --merged` 与 `git branch -r --contains` 在这里都会给出错误答案。
本次判据是 PR 的实际合并状态（`gh pr list --state all`），外加对可疑分支实测
`git diff origin/main...<branch>` 是否为空。

## 恢复方法

```bash
git push origin <SHA>:refs/heads/<分支名>
```

远端分支删除在 GitHub 执行 GC 之前可逆。下表保留了每个分支删除前的 tip SHA。

| 分支 | tip SHA | 判据 |
| --- | --- | --- |
| `claude/agent-canvas-audit-round2` | `e8104080f8d61fa2aaf8f73c6554a0cda7d55f07` | PR 已合并 |
| `claude/agent-panel-canvas-audit-xlj873` | `ab3817b564dd97d35ddb4ba0f7668c4728cae53f` | PR 已合并 |
| `codex/agent-clarification` | `b6431dac22bd959bc1bcc6122a0db81fd505198e` | PR 已合并 |
| `codex/agent-confirmation-ui` | `e6a22aacd3480cacfffc6e5a455c710415a37cbf` | PR 已合并 |
| `codex/agent-runtime-v2` | `3362abbc72166879bc48f77610906f0c73da210a` | PR 已合并 |
| `codex/agent-runtime-v3` | `fce7dd38a822df7919ab1c12ddc6a35d25b52f5e` | PR 已合并 |
| `codex/interaction-concurrency-fixes` | `d0f6280b16f1d0d0388a24a38cebbb0b1fbd27af` | PR 已合并 |
| `codex/product-usability-complete` | `f5f9d62d6b48fc3d23ec495b137607b1e3f72156` | PR 已合并 |
| `codex/product-wide-i18n` | `3663d130f9aea9418b5cbe942cf1537ab2c8c4ca` | PR 已合并 |
| `codex/seventh-round-canvas-coordinators` | `2b0740c8eb91d6410952fb7c0fce1117a95dc7b8` | PR 已合并 |
| `cursor/agent-artifact-skill-ui-dfcd` | `1b89ac46d833368c8f4ed477d67e466086152bcc` | PR 已合并 |
| `cursor/agent-bob-launcher-0f90` | `664c5cf1a2d6252bed7644b877d1bf31b27c5a1e` | PR 已合并 |
| `cursor/agent-clarification-layout-dfcd` | `ac83f1b943ced164465e14bfbd4c702d3b7adb05` | PR 已合并 |
| `cursor/agent-confirm-card-layout-dfcd` | `b0c4d39b3de3bb89330f9fb3c5999053a6c6963f` | 与 main 零差异 |
| `cursor/agent-confirm-pending-dfcd` | `879087f8f675ec58bbd05c164fbddf59ef53babc` | PR 已合并 |
| `cursor/agent-confirm-skill-title-dfcd` | `d8686c7210714b263052f410afd78f919a89934e` | PR 已合并 |
| `cursor/agent-harness-upgrade-dfcd` | `aa5dbd29a053b7b6de53add6b292488dd4019a69` | PR 已合并 |
| `cursor/agent-layout-alignment-dfcd` | `ca2a2bdd1c901b3e079190de8dc374f9975a6c4c` | PR 已合并 |
| `cursor/agent-markdown-prompt-copy-dfcd` | `ba99ac88bd9ba36b8204eca0d1212373809cff32` | PR 已合并 |
| `cursor/agent-panel-copy-nav-dfcd` | `3922cf09f10cd5e6846e90d0838bd55156d5c932` | PR 已合并 |
| `cursor/agent-panel-quiet-spacing-1437` | `5ebf2ef5140889c0b37dc24e233b66499c8ff30c` | PR 已合并 |
| `cursor/agent-panel-top-clearance-dfcd` | `2b63bb8fccad02af88d79119833c29aab9745346` | PR 已合并 |
| `cursor/agent-receipt-layout-0f90` | `b5518a5d3532bd29fb60b4da7f4e112317466cb2` | PR 已合并 |
| `cursor/agent-sources-fold-0f90` | `d07e602c82cb35966dfaf94b7f9d0b92c03926ce` | PR 已合并 |
| `cursor/agent-sse-keepalive-dfcd` | `e8226a2b85696a4a4f38528d864dfaa103bf27ca` | 与 main 零差异 |
| `cursor/agent-thinking-web-search-dfcd` | `baa93372aebde17e8e4a7aa489475201509534df` | PR 已合并 |
| `cursor/agent-tool-calling-planner-05ff` | `2eb2141213154da015418c90eed817e50cfd6b04` | PR 已合并 |
| `cursor/agent-tool-orbs-0f90` | `f805daba33444f6aa2ef638553ed2f3051c47795` | PR 已合并 |
| `cursor/agent-unified-review-dfcd` | `68834a13829186d8aa5c0da530c77e1105f4f5cd` | PR 已合并 |
| `cursor/agent-variation-batch-dfcd` | `d53426b3443c5232d9d51c7186b74937677816e8` | PR 已合并 |
| `cursor/agent-variation-plan-branches-dfcd` | `1cca3e077aee73e0cd8010c1ae77bf54acbcf1bc` | PR 已合并 |
| `cursor/generation-dots-snake-33c3` | `50376c48fbbce3f52387e08064614fa577aa3835` | PR 已合并 |
| `cursor/marketing-production-layers-db44` | `2d736ba5b99faa07cc49fe7ae57f3d23b984eda7` | 与 main 零差异 |
| `cursor/metalforge-motion-33c3` | `b180799ec4557f47346d1ad6cc1d855c7bcaaeec` | PR 已合并 |
| `feat/agent-skills-mentions-composition` | `5d7c30271c76ef1bda746f33e852a68d8b08a8ff` | PR 已合并 |
| `fix/agent-panel-stop-and-i18n` | `1862b5018ede11e14e7c7168e363b95cf21fb6d7` | PR 已合并 |
| `fix/runtime-v3-followups` | `f723c70b55ebba4769d228eefc2d0f590463aa59` | PR 已合并 |
| `vercel/install-vercel-web-analytics-ijl8y4` | `84ef49e779747c2ef53a604e005f4d074d11ff4e` | PR 已合并 |

## 保留

| 分支 | 原因 |
| --- | --- |
| `main` | 默认分支 |
| `docs/agent-instructions-sync` | PR #73 开着 |
| `cursor/agent-bob-readability-0f90` | PR #69 草稿 |

另有 7 个分支 PR 关闭未合并或从未开 PR，且相对 `main` 有独有改动，本次保留待评估：

| 分支 | 独有改动（上限估计） | PR |
| --- | --- | --- |
| `cursor/agent-variation-channel-design-dfcd` | 40 文件 / +1581 | #42 关闭未合 |
| `cursor/workflow-run-authority-753d` | 25 文件 / +1434 | #28 关闭未合 |
| `cursor/product-code-deep-review-143e` | 2 文件 / +418 | #30 关闭未合 |
| `cursor/agent-aigc-workflow-review-b851` | 2 文件 / +373 | #29 关闭未合 |
| `cursor/agent-harness-confirm-pending-0761` | 9 文件 / +227 | #46 关闭未合 |
| `codex/botanic-agent-p0` | 2 文件 / +176 | 无 |
| `codex/fix-refinement-result-connection` | 7 文件 / +95 | #1 关闭未合 |
