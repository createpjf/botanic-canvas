# PR-1：修复蒙版基准图错配 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 局部重绘的蒙版按**供应商实际收到的第一张图**定尺寸，而不是按未排序的 `references[0]`。这是一个已存在的缺陷，今天就在影响用户。

**Architecture:** 一行修改：蒙版物化点改用 `orderCompositionReferences(references)[0]`，与 `generateImages` 构造 `inputImages` 时用的是同一个排序函数。该函数已在本文件 `:3` import，`name` 字段在整条链路上未被剥离，因此不需要任何结构调整。真正的工作量在那条**必须在修复前变红**的回归测试。

**Tech Stack:** 原生 `node:test`。**不新增任何依赖。**

**Spec:** `docs/superpowers/specs/2026-08-26-local-edit-design.md`（本计划实现其「问题 4 · 冲突 ③」，并作为独立可发布的 PR-1）

## Global Constraints

- **回归测试必须在修复前是红的。** 一条不会红的测试等于没测。实施时要**实际删掉修复跑一遍**确认它会红，把输出写进报告。
- 不改 `parent` 优先语义 —— 有 `parent` 时行为必须逐字不变。
- 不改 `normalizeCustomGenerationSize`、不改 `resolveGenerationOutputSize`、不碰输出尺寸链路。本 PR 只动蒙版基准图这一处。
- 不新增运行时依赖。
- 注释用中文，解释**为什么**。
- 门禁全绿：`npm test`、`npm run check:architecture`、`npm run check:security`、`npm run build`、`git diff --check`。

## 缺陷说明（控制者已亲手复现）

`server/generationProvider.mjs` 的 `resolveGenerationInputMedia` 在物化选区蒙版时：

```js
const base = parent ?? references[0]
```

而 `generateImages`（`:511-514`）实际发给供应商的第一张图是：

```js
const orderedReferences = orderCompositionReferences(job.references ?? [])
const inputImages = job.parent ? [job.parent, ...] : orderedReferences
```

`orderCompositionReferences`（`server/generationComposition.mjs:15-25`）会把**标识类参考图挪到队尾**。两者在特定条件下不是同一张。

**实测复现**（控制者直接调 `resolveGenerationInputMedia`）：

```
refs = [{ name: '品牌 Logo.png', 64×64 }, { name: '棚拍人像', 20×10 }]
maskRegion = { x: 0.5, y: 0, width: 0.5, height: 1 }

orderCompositionReferences 重排后首图 → 棚拍人像
蒙版实际尺寸               → { width: 64, height: 64 }   ← 按 Logo 生成
```

供应商收到的 `image[]#1` 是人像 20×10，蒙版却是 64×64。**全仓没有任何蒙版-首图尺寸校验**（`:529-535` 只是 `form.append` 与 `form.set`），这对无效组合会原样发出去，整单被供应商判非法。

### 触发条件（六条同时成立）

| # | 条件 | 依据 |
| --- | --- | --- |
| 1 | 走 `maskRegion` 路径（非用户直传 PNG 蒙版） | `generationProvider.mjs:347-348` |
| 2 | **没有 parent** | `:350` parent 优先；`:512` 也把 parent 顶到首位，有 parent 则两边同一张 |
| 3 | `references.length >= 2` | `generationComposition.mjs:16` 的 `length < 2` 短路 |
| 4 | marks 与 bases 同时非空 | `generationComposition.mjs:23` |
| 5 | **`references[0]` 本身是 mark** | 分桶稳定，队首没被换掉就不出 bug |
| 6 | 两张图像素尺寸不同 | 否则生成的 PNG 逐字节相同，零残留 |

**第 5 条是要点**：「会重排」不等于「会动到队首」。

### 标识图的判定规则

`generationComposition.mjs:7-13` — 取 `reference.name`，trim 后非空，用无锚点子串匹配：

```
/logo|wordmark|word[\s-]?mark|标识|徽章|勋章|胸针|领针|袖标|臂章|商标|标志|标牌|emblem|badge|crest|monogram|insignia/iu
```

命中示例：`品牌 Logo.png`、`胸针特写.jpg`、`badge-front.png`。
不命中：`棚拍人像`、`参考素材 1`（这正是 `:201` 的默认名，所以未命名的 logo 素材永远识别不出）。

---

## 文件结构

| 文件 | 改动 |
| --- | --- |
| `server/generationProvider.mjs` | 一行：蒙版基准图改用排序后的首张 |
| `server/generationProvider.test.mjs` | 新增 2 条测试（1 条回归钉子 + 1 条守护） |

---

### Task 1：回归钉子 + 一行修复

**Files:**
- Modify: `server/generationProvider.mjs`（`resolveGenerationInputMedia` 内 `maskRegion` 物化处）
- Test: `server/generationProvider.test.mjs`（追加）

**Interfaces:**
- Consumes: `orderCompositionReferences`（已在 `generationProvider.mjs:3` import，无需新增）；`imagePixelSize` 来自 `./mediaFormats.mjs`；`regionMaskAlphaAt` 来自 `./regionMaskPng.mjs`
- Produces: 无新导出，行为修正

- [ ] **Step 1：写会红的回归测试**

追加到 `server/generationProvider.test.mjs` 末尾：

```js
test('无 parent 且标识参考排在首位时，蒙版按重排后的底图定尺寸', async () => {
  // 缺陷：物化点按 references[0] 定尺寸，而供应商收到的首图是
  // orderCompositionReferences 重排后的 —— 标识图会被挪到队尾。
  // 两者不一致时，发出去的是「蒙版尺寸 ≠ image[]#1 尺寸」这对无效组合。
  const { validateGenerationInput, resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')
  const { regionMaskAlphaAt } = await import('./regionMaskPng.mjs')

  const references = [
    { name: '品牌 Logo.png', mediaId: 'media_logo' },      // 命中标识正则，会被排到队尾
    { name: '棚拍人像', mediaId: 'media_portrait' },        // 真正的底图
  ]
  const input = validateGenerationInput({
    projectId: 'project-mask-order',
    kind: 'generation',                                    // 不能是 refinement：那会在 :251 要求 parent
    prompt: '把右半边换成纯色',
    batchCount: 1,                                         // 注意：batchCount 在 body 顶层，不在 recipe 里
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references, maskRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  }, {
    models: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], supportsMask: true }],
    maximumBatchCount: 4,
    maximumReferenceBytes: 8 * 1024 * 1024,
  })

  // 按 mediaId 分发不同尺寸 —— 常量返回会让两张图尺寸相同，测试永远绿。
  const bytes = { media_logo: pngOfSize(64, 64), media_portrait: pngOfSize(20, 10) }
  const resolved = await resolveGenerationInputMedia(input, async (mediaId) => ({
    mimeType: 'image/png',
    buffer: bytes[mediaId],
  }))

  // 主观察点：蒙版尺寸必须取自人像（20×10），不是 Logo（64×64）。
  assert.deepEqual(imagePixelSize(resolved.mask.buffer), { width: 20, height: 10 })
  // 辅观察点：右半透明（重绘）、左半不透明（保持）。
  // 正确基准宽 20，右半从 x=10 起，列 15 应透明；错误基准宽 64，右半从 x=32 起，列 15 会是不透明。
  assert.equal(regionMaskAlphaAt(resolved.mask.buffer, 15, 0), 0)
  assert.equal(regionMaskAlphaAt(resolved.mask.buffer, 5, 0), 255)
})

test('标识参考不在首位时行为不变', async () => {
  // 守护用例：修复前后恒绿，锁住 orderCompositionReferences 的稳定分桶 ——
  // 底图本来就在队首时，重排不该改变任何东西。
  const { validateGenerationInput, resolveGenerationInputMedia } = await import('./generationProvider.mjs')
  const { imagePixelSize } = await import('./mediaFormats.mjs')

  const references = [
    { name: '棚拍人像', mediaId: 'media_portrait' },
    { name: '品牌 Logo.png', mediaId: 'media_logo' },
  ]
  const input = validateGenerationInput({
    projectId: 'project-mask-order-2',
    kind: 'generation',
    prompt: '把右半边换成纯色',
    batchCount: 1,
    settings: { model: 'gpt-image-2', aspectRatio: '1:1', resolution: '1K' },
    recipe: { references, maskRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } },
  }, {
    models: [{ id: 'gpt-image-2', provider: 'openai', mediaKind: 'image', aspectRatios: ['1:1'], resolutions: ['1K'], supportsMask: true }],
    maximumBatchCount: 4,
    maximumReferenceBytes: 8 * 1024 * 1024,
  })

  const bytes = { media_logo: pngOfSize(64, 64), media_portrait: pngOfSize(20, 10) }
  const resolved = await resolveGenerationInputMedia(input, async (mediaId) => ({
    mimeType: 'image/png',
    buffer: bytes[mediaId],
  }))
  assert.deepEqual(imagePixelSize(resolved.mask.buffer), { width: 20, height: 10 })
})
```

**关于 `pngOfSize`：** 该文件顶部已有这个辅助函数（PR-A 时上提为模块级）。**先确认它存在再用**；若不存在，在文件顶部加一份，不要在测试体内重复定义。

- [ ] **Step 2：跑测试，确认第一条是红的**

Run: `node --test server/generationProvider.test.mjs`
Expected: **第一条 FAIL**，报 `{ width: 64, height: 64 } !== { width: 20, height: 10 }`；第二条 PASS。

**如果第一条通过了，停下来告诉控制者。** 那意味着触发条件没搭对（六条里少了一条），测试没有测到缺陷，加上去也是自欺。

- [ ] **Step 3：一行修复**

`server/generationProvider.mjs` 的 `resolveGenerationInputMedia` 内，`maskRegion` 物化那段：

改前：
```js
    // 选区矩形在这里落成位图：蒙版必须与基准图（parent 优先）同像素尺寸。
    const base = parent ?? references[0]
```

改后：
```js
    // 选区矩形在这里落成位图：蒙版必须与**供应商实际收到的第一张图**同像素尺寸，
    // 也就是 generateImages 里 inputImages[0] —— parent 优先，否则是
    // orderCompositionReferences 排序后的首张。标识类参考会被那个函数挪到队尾，
    // 直接取 references[0] 会在「无 parent 且标识图排首位」时按错误的图定尺寸，
    // 发出「蒙版尺寸 ≠ image[]#1 尺寸」的无效组合。
    const base = parent ?? orderCompositionReferences(references)[0]
```

`orderCompositionReferences` 已在 `server/generationProvider.mjs:3` import，**不要新增 import**。

空数组安全：`generationComposition.mjs:16` 对 `length < 2` 返回浅拷贝，取 `[0]` 得 `undefined`，下一行的 `base ? ... : null` 与随后的 400 已经处理。

- [ ] **Step 4：跑测试确认转绿**

Run: `node --test server/generationProvider.test.mjs`
Expected: 全部 PASS，包含既有的 29 条。

- [ ] **Step 5：确认这条钉子真的会红**

把 Step 3 的修复临时改回 `const base = parent ?? references[0]`，重跑：

Run: `node --test server/generationProvider.test.mjs`
Expected: 第一条 FAIL

然后改回修复版本，再跑一次确认全绿。**把这两次的输出都写进报告** —— 这是这条测试有价值的唯一证据。

- [ ] **Step 6：全量门禁**

```
npm test
npm run check:architecture
npm run check:security
npm run build
git diff --check
```
Expected: 全部 PASS

- [ ] **Step 7：提交**

```bash
git add server/generationProvider.mjs server/generationProvider.test.mjs
git commit -m "fix(generation): 蒙版按供应商实际收到的首图定尺寸

物化点按 references[0] 定蒙版尺寸，而 generateImages 发出去的首图是
orderCompositionReferences 重排后的 —— 该函数会把标识类参考图挪到队尾。
无 parent 且标识图排在首位时两者不是同一张，发出的是「蒙版尺寸 ≠ image[]#1
尺寸」这对无效组合，而全仓没有任何蒙版-首图尺寸校验会拦下它。

实测复现：refs=[Logo 64x64, 人像 20x10] + maskRegion，蒙版按 Logo 生成 64x64，
供应商收到的首图却是人像 20x10。

现有两条测试各覆盖一半 —— :459 那条有 parent 且 references 为空，:423 那条锁了
排序但完全没有 mask，交叉点零覆盖，正是缺陷藏身处。新增的回归钉子在修复前会红。"
```

---

### Task 2：人工确认与残留项记录

**Files:** 无改动

- [ ] **Step 1：确认改动面**

```bash
git diff --stat HEAD~1
```
Expected: 恰好两个文件，`generationProvider.mjs` 只有注释与一行代码改动。

- [ ] **Step 2：把同源第二处记进 PR 描述**

`server/imageOverlay.mjs` 的 `composeOverlayImages` 有**同一形状**的问题：

```js
const base = job.parent ?? job.references?.[0]
const mark = compositionOverlayReferences(job.references).at(-1)
  ?? (job.parent ? job.references?.[0] : job.references?.[1])
```

无 parent 且标识图排首位时，`base` 与 `mark` 会取到同一张标识图。该分支由 `server/generationService.mjs` 的 `jobRequestsPixelOverlay(job)` 抢在 `generateImages` 之前接管，**是一条独立路径，本 PR 不改**。

写进 PR 描述，不要顺手改 —— 它有自己的触发条件与测试面，混进来会让这个「一行修复」的 PR 变得难以评审和回滚。

- [ ] **Step 3：PR 描述必须写明**

```
本 PR 修复的是已存在的缺陷，不是新功能的一部分。

未覆盖：
- server/imageOverlay.mjs 的 composeOverlayImages 有同一形状的问题
  （无 parent + 标识图排首位时 base 与 mark 取到同一张），属独立路径，另开。
- 标识图判定是无锚点子串匹配，「标志性建筑背景」「视觉标识系统」这类底图会被误判
  为标识图并排到队尾。这是既有行为，本 PR 不改，但值得单独评估。
- 未命名的 logo 素材（默认名「参考素材 N」）永远识别不出，因此也永远不会触发本缺陷。
```

---

## 自查

**规格覆盖：** spec 的「冲突 ③」要求两件事 —— 蒙版基准图改用与 `:511` 同源的排序结果（Task 1 Step 3），以及一条在修复前会红的回归钉子（Task 1 Step 1-2，Step 5 强制验证它真的会红）。两件都有对应步骤。

**类型一致性：** `orderCompositionReferences(references)` 收数组返回数组，取 `[0]` 与原 `references[0]` 同类型；`imagePixelSize` 返回 `{width,height} | null`，测试用 `deepEqual` 比对对象；`regionMaskAlphaAt(png, x, y)` 的签名取自 `regionMaskPng.mjs:73`。

**起草时纠正的一处：** 取证材料把 `batchCount` 写在 `recipe` 里，实测 `validateGenerationInput` 从 **body 顶层**读它（`generationProvider.mjs:136`），放错位置会抛 `INVALID_BATCH_COUNT` 而不是跑到蒙版逻辑。计划里的测试代码已按实测修正 —— 控制者亲自跑通过这段构造。
