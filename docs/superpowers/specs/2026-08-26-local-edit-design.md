# 局部编辑：移除物体 / 替换背景 / 外扩

> 设计规格。本轮只定方案，不改运行时代码。
> 取代 `2026-08-26-local-edit-decisions.md`（那份只记已定取向，本文是完整设计）。

**Goal:** 用户涂选画面里的一块区域，选一个操作（移除 / 换背景 / 外扩），得到一个**新的 Artifact 版本**而非覆盖原件。界面行为跨模型一致，翻译由各供应商适配器负责。

**Architecture:** 领域层新增**操作词表**，界面产出 `EditIntent { operation, maskPng, prompt?, expandTo? }` 随配方提交；翻译在服务端各适配器里，提示词模板是可穷举测试的纯函数。模型能力从布尔 `supportsMask` 改为四值 `maskSupport`，因为三个目标模型的编辑接口形状根本不同。

**Tech Stack:** 现有 `server/generationProvider.mjs`（OpenAI）、`server/imageOverlay.mjs`（`decodeRgbaImage`/`encodeRgbaPng`/`composeMarkOverlayPng`，靠 `jpeg-js`）、`server/regionMaskPng.mjs`、`server/generationOutputSize.mjs`。**不新增运行时依赖。**

## Global Constraints

- **能力先于模型。** 界面呈现「移除物体」，不呈现「gpt-image-2 的 mask 字段」。模型差异由适配器吸收。
- **意图必须落库。** `editOperation` 随任务持久化，否则换模型重试拿不到重新翻译所需的信息，血缘上也看不出这一版是什么操作。
- 服务端是唯一强制边界；客户端校验是体验，不是信任边界。
- **提示词模板只在服务端。** 客户端只需要三个操作 id 与自己的中英文标签，因此**没有词表重复，不需要契约测试**（与 `mediaFormats` 的两份副本 + 契约测试不同）。
- `src/domain/` 不得导入 `server/`（`check:architecture` 强制）。
- 浏览器原语（`<canvas>`、`toBlob`）必须可注入或以普通数值为入参，否则 `src/domain/*.test.ts` 覆盖不到。
- 全量中英双语，`{ 'zh-CN', en }` 形状由 TypeScript 强制。
- 注释用中文，解释**为什么**。
- 空蒙版/满蒙版在**客户端**拦下，不发请求 —— 发出去就是白花一次生成的钱。

---

## 前置事实（已实测，非推断）

对 gpt-image-2 打三次真实调用，逐张肉眼确认：

| 能力 | 结果 |
| --- | --- |
| Object Remove | ✓ 目标干净消失，背景均匀无痕 |
| Background Replace | ✓ 主体原样保留，背景整片替换 |
| Expand / 外扩 | ✓ 接受「基准图自带透明区」并在其中作画，接缝不可见 |

因此升级方案原文「这些是 Provider 能力，当前模型不提供，**写不出来**」**不成立**。六项里只有两项真被模型能力挡住：**可编辑文本层**（光栅模型不产出文本图层）与 **Object Move**（需分割+补洞+合成三步编排）。**Upscale** 不在这条链上，需独立超分服务。

**限定**：实测用的是合成图（纯色底 + 硬边方块）。真实照片里**蒙版质量才是决定成败的东西**。另：Background Replace 是换背景，不产出带 alpha 的透明图。

## 三个模型的编辑接口不同

| 模型 | 蒙版怎么传 |
| --- | --- |
| gpt-image-2 | multipart 里一等的 `mask` 字段（已接入，已实测） |
| Seedream 4.x | 独立 inpaint / outpaint 模式 + 蒙版；参数名随供应商而变 |
| nano banana（Gemini） | **没有 mask 参数**，语义蒙版（自然语言描述区域） |

---

## 现状（不要重做）

| 能力 | 位置 | 现状 |
| --- | --- | --- |
| 任意 PNG 蒙版 | `generationProvider.mjs:222-232` `recipe.mask` | 已支持，要求带透明通道 |
| 矩形蒙版 | `recipe.maskRegion` + `regionMaskPng.mjs:40` | 服务端按矩形生成 PNG |
| 蒙版编辑器 | `RegionMaskEditor.tsx`（129 行） | **只能拖矩形**，产出 `{ rect, prompt }`；两个调用点：`AgentWorkspace.tsx:2834`、`CanvasWorkspace.tsx:2537` |
| 能力声明 | `generationModels.mjs:38` | `supportsMask: true` 布尔 |
| 输出尺寸 | `generationOutputSize.mjs:111-120` | 两条分支：自定义像素 / 查目录，查不到即抛（`:118`） |
| 像素守卫 | `generationProvider.mjs:296` | 上限 8,294,400，派生自 `gptImage2CustomSizeLimits` |
| 合成原语 | `imageOverlay.mjs` `composeMarkOverlayPng` | 已存在，**目前零调用方** |
| 精修强度 | `RefinementMode = 'faithful' \| 'explore'` | 与操作类型正交 |

---

## 问题 1：意图词表与配方

配方能表达「改哪里」，表达不了「做什么操作」。新增一个与既有两项正交的字段：

```
maskImage       改哪里        （已有，任意 PNG）
refinementMode  改得多像原图   （已有，faithful | explore）
editOperation   做什么操作     （新增，remove | replace_background | expand）
```

**不复用 `refinementMode`**：它是忠实度这个连续量，`editOperation` 是离散操作类型。塞进同一枚举会让 `explore` 与 `remove` 互斥，而它们本该能组合。

**外扩多一个字段** `expandTo: { top, right, bottom, left }`，单位是**源图像素、非归一化**。理由：目标 W×H 能从源图与四边推出，反过来推不出锚点；16 对齐的余数需要显式摊到指定边。外扩的 `maskImage` 由**服务端生成**（透明区即新增的边），不是用户涂的。

---

## 问题 2：蒙版笔刷

### 替换而非并存

`RegionMaskEditor` 两个调用点共用 `onSubmit({ rect, prompt })`，Agent 侧只多传 `hidePrompt`。笔刷严格比矩形更有表达力，**两个调用点都迁移**，契约改为 `{ maskPng, prompt }`。留两个编辑器等于留两套状态与撤销逻辑，也让 `maskRegion` 与 `maskImage` 两条服务端路径长期并存 —— 而后者能表达前者的全部。

### 三件必须做对的事

1. **蒙版导出为基准图的真实像素尺寸。** 画布在屏幕上是 CSS 尺寸，基准图可能是 2048×2048；OpenAI 要求蒙版与图逐像素同尺寸。搞错则请求被拒，错误信息来自供应商、对用户毫无意义。
2. **空蒙版与满蒙版在提交前拦下。** 没涂就确认 → 模型什么都不改，白花钱；涂满 → 等于重新生成。
3. **撤销。** 存笔画列表、撤销即弹出末项、重绘由列表推导 —— 撤销是纯的，光栅化才是机制。

### 拆法

| 纯函数（可测） | 薄机制（`node:test` 无 canvas） |
| --- | --- |
| 笔画列表增删、撤销 | `<canvas>` 指针事件与描边 |
| 导出尺寸推导（显示尺寸 → 真实像素缩放比） | `toBlob` 光栅化 |
| 蒙版有效性判定 | 读回像素统计 alpha |

第三行的判定**收「不透明像素占比」这个数**，不收画布本身 —— 这样阈值可穷举测试，取数那步薄到没有逻辑。

---

## 问题 3：三个适配器的翻译

### 能力声明从布尔改成形状

```
supportsMask: true   →   maskSupport: 'field' | 'mode' | 'pointer' | 'none'
```

| 值 | 含义 | 谁 |
| --- | --- | --- |
| `'field'` | 蒙版是一等请求字段 | gpt-image-2 |
| `'mode'` | 先选 inpaint/outpaint 模式再传蒙版 | Seedream 4.x |
| `'pointer'` | **无蒙版字段**，蒙版转视觉指针 + 描述性提示词 | nano banana |
| `'none'` | 不支持局部编辑 | MiniMax image-01 |

**`'pointer'` 与 `'none'` 必须分开。** `generationProvider.mjs:224` 现在是「不支持就抛 `INVALID_MASK` —— 当前模型不支持局部重绘蒙版」。对 nano banana 这句话是**错的**：它支持局部编辑，只是不吃蒙版字段。布尔表达不了这个差别。

### 三条翻译路径

```
EditIntent { operation, maskPng, prompt?, expandTo? }
        │
  ┌─────┴──────┬──────────────────┐
'field'      'mode'            'pointer'
gpt-image-2  Seedream          nano banana
  │            │                  │
mask 字段    模式 + 蒙版      composeMarkOverlayPng 合成高亮副本
                                → 当第二张参考图
                                → 提示词描述「高亮标出的区域」
```

**`'pointer'` 的代价要让用户知道**：它把精确边界降级成视觉提示，边界精度必然不如另两条。界面上该在模型旁标注「该模型按描述定位区域，边界为近似」。

提示词模板按 `(operation, maskSupport)` 二维产出，九个组合可穷举测试，**不需要真实调用** —— 测的是模板产出，不是模型效果。

---

## 问题 4：外扩

外扩不是「再加一个操作」，它撞上三处既有机制冲突，其中一处是**已存在的 bug**。以下均经并行取证 + 对抗核查 + 控制者复验。

### 唯一通道

目标尺寸只能走 `settings.outputWidth/outputHeight`。目录只有 6 个比例、12 组像素（`generationOutputSize.mjs:11-30`），2:3 / 5:4 / 21:9 都不在内，加一个要同改 `src/domain/generationOutputSize.ts` 的副本。

### 冲突 ①：尺寸被静默改写

实测：

```
4096x2048 → {"width":3840,"height":2048,"snapped":true}   ← 边被砍 256px
2048x4096 → {"width":2048,"height":3840,"snapped":true}
2048x3072 → {"width":2048,"height":3072,"snapped":false}  ← 合法
```

而 `resolveGenerationOutputSize:115` **只 `return normalized.size`，把 `snapped` 丢了**。外扩语义要求「输出画布严格等于原图 + 指定 padding」，边被悄悄砍掉则铺好的基准图与输出尺寸对不上。

另：`generationOutputSize.mjs:73-75` 的边长拒绝分支是**死代码** —— `snapEdge:59-62` 已夹取过，条件恒为假。超限输入实际由 `:80` 的像素窗挡下。

### 冲突 ②：比例声明自相矛盾

实测 `inferAspectRatioFromPixels(1024,1536)` → `'3:4'`，而真实比是 0.667（2:3）。该改写值经 `generationProvider.mjs:166-169` 落库（`:261`），再被 `generationComposition.mjs:143-144` 拼进提示词 —— **请求里 `size=1024x1536`，提示词却说「画面比例：3:4」**。

### 冲突 ③：蒙版基准图错配（已有 bug，本轮一并修）

`generationProvider.mjs:350` 按 `parent ?? references[0]` 定蒙版尺寸，但 `:511-514` 实际发出去的首图是 `orderCompositionReferences` **重排后**的，而它会把标识类参考图挪到队尾（`generationComposition.mjs:15-25`）。

**触发条件**：无 `parent`，且 `references` 第一张是标识图。此时蒙版按错误的图定尺寸。**与外扩无关，今天的局部重绘就会撞上。**

现有测试只覆盖 `parent` 存在 + `references: []`（`generationProvider.test.mjs:460-480`），正好绕开触发条件 —— 所以修它不会让任何测试变红，但也说明**今天没有任何测试钉住蒙版按哪张图定尺寸**。

### 面积天花板

输入守卫阈值与输出像素上限**同为 8,294,400**（`mediaFormats.mjs:54` 派生自 `gptImage2CustomSizeLimits`），故合法输出的垫图必过输入守卫 —— 这是 PR-A「凡是我们能生成的就必须能被重新接收」不变量的红利。

但 2048² 起最多外扩到 **1.98 倍面积**：`2048×3072` 余量 24%，`2048×3840` 是极限。**界面要提前硬拦**，不能等提交才失败。

### 落地位置

服务端算出 W/H 后**必须跑 `normalizeCustomGenerationSize` 并断言 `snapped === false`**，否则报错或回填 padding —— 把「输出尺寸 == 铺好的基准图尺寸」立成新不变量（今天两者完全解耦）。

蒙版生成放在 `generationProvider.mjs:348` 的 `maskRegion` 物化点旁加 `expandTo` 分支，**且基准图改用与 `:511` 同源的 `inputImages[0]`** —— 顺带修掉冲突 ③。

---

## 问题 5：错误与测试

### 三层

| 层 | 内容 | 可测性 |
| --- | --- | --- |
| 纯函数 | 提示词模板（3×3=9）、蒙版有效性、`expandTo` → W/H、笔画撤销、导出缩放比 | 全测，穷举 |
| 服务端（假适配器） | 三条翻译路径、`expandTo` → 垫图 + 蒙版、`snapped === false` 断言 | 全测 |
| 浏览器机制 | `<canvas>` 描边、`toBlob`、读回 alpha | **测不了** |

### 冲突 ③ 的回归钉子

新增：无 `parent`、`references` 第一张是标识图 → 断言蒙版尺寸取自**重排后**的首图。**这条在修复前必须是红的** —— 实施时要实际删掉修复跑一遍确认，否则它没证明任何东西。

### 错误码

| 码 | 用户看到 | 拦在哪 |
| --- | --- | --- |
| `EDIT_MASK_EMPTY` | 你还没有涂选任何区域。请涂抹要修改的部分 | 客户端 |
| `EDIT_MASK_FULL` | 涂选区域覆盖了整张图，这等同于重新生成。请缩小涂选范围 | 客户端 |
| `EDIT_EXPAND_TOO_LARGE` | 外扩后 2048×4096 超过面积上限。当前图最多可扩到 2048×3840 | 客户端（提前硬拦） |
| `EDIT_EXPAND_SIZE_MISMATCH` | 外扩尺寸需为 16 的倍数，已调整为 2048×3840。请确认 | 服务端 |
| `EDIT_OPERATION_UNSUPPORTED` | 当前模型不支持局部编辑，请切换模型 | 服务端 |

### 必须写进 PR 描述的未验证项

**① `'pointer'` 路径完全未验证。** 实测过的是 gpt-image-2 的 `mask` 字段路径。**nano banana 的视觉指针一次都没试过** —— 该模型尚未接入，仓库无 Gemini key。「合成高亮副本 + 描述性提示词能让模型准确定位」是**推理，不是证据**。接入后第一件事就是打真实调用验它。

**② 真实照片效果未验证。** 探路用的是合成图。

**③ Seedream 请求形状未验证。** 只查到有 inpaint/outpaint 模式，参数名随供应商而变，接入时按实际文档校准。

**④ 三处取证未覆盖：** 垫大后 PNG 字节量是否撞上传/参考字节上限；仓库是否已有「补透明边」实现（本方案前置）；自定义尺寸下 `resolution` 还驱动哪些消费方（计费、评审门槛）。

---

## 推荐落地顺序

**PR-1：冲突 ③ 的独立修复 + 回归钉子**
仅修蒙版基准图错配。今天就在影响局部重绘，与新功能无关，**可独立发布、独立回滚**。

**PR-2：意图词表 + `'field'` 路径 + 笔刷**
`editOperation` 落库、`maskSupport` 四值词表、笔刷编辑器替换 `RegionMaskEditor`、gpt-image-2 的翻译。**移除与换背景两项此时即可用**（已实测）。

**PR-3：外扩**
`expandTo`、服务端垫图与蒙版生成、`snapped === false` 不变量、界面面积上限硬拦。

**PR-4：Seedream 与 nano banana 适配器**
`'mode'` 与 `'pointer'` 两条路径。**接入前先各打一次真实调用验形状**，不要按文档直接写。

## 明确不做

- **可编辑文本层** —— 光栅模型不产出文本图层，需另一类模型。
- **Object Move** —— 需分割 + 补洞 + 合成三步编排，不是单次调用。
- **Upscale** —— 不在这条链上，需独立超分服务。
- **自动去背的分割步骤** —— 第一版用户手涂；「一键去背」需要分割模型，单开一轮。
- **扩展 aspectRatios 目录** —— 外扩走自定义像素，不动目录。
- **清理 `generationOutputSize.mjs:73-75` 的死代码** —— 那段边长拒绝分支永不可达（`snapEdge` 已夹取），本轮只标注，清理归 Epic 13。
  注意这与外扩的 `snapped === false` 断言**不冲突**：本方案不改 `normalizeCustomGenerationSize` 的任何行为，
  只是在外扩路径上**读取它已经返回的 `snapped` 字段**并据此拒绝 —— 而 `resolveGenerationOutputSize:115`
  今天把这个字段丢了。外扩不经过 `resolveGenerationOutputSize` 那条丢弃路径，直接用
  `normalizeCustomGenerationSize` 的完整返回值。
- **修 `resolveGenerationOutputSize` 丢 `snapped` 这件事本身** —— 改它会影响所有生成路径的返回形状，
  超出本功能范围。外扩绕开它，不修它。
- **透明 PNG 导出** —— Background Replace 是换背景，不产出 alpha。

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

1. 涂选一个物体 → 移除 → 只有该物体消失，周围背景未被改动。
2. 反向涂选主体 → 换背景 → 主体边缘保持，背景整片替换。
3. **不涂任何东西直接确认** → 被客户端拦下并说明，**不产生任何请求**（网络面板确认）。
4. 涂满整张图 → 被拦下并说明。
5. 外扩拖到超过面积上限 → 界面提前停住，不允许提交。
6. 外扩后的图**再次外扩** → 血缘上能回到最初原件。
7. 切到 `maskSupport: 'none'` 的模型 → 局部编辑入口给出可执行提示。
8. 一张有标识参考图、无 parent 的任务做局部重绘 → 蒙版尺寸正确（冲突 ③ 的人工回归）。

## 文件地图（实现时）

**新增**

| 文件 | 职责 |
| --- | --- |
| `src/domain/editIntent.ts` + `.test.ts` | 操作词表、蒙版有效性、`expandTo` → W/H |
| `src/domain/maskStrokes.ts` + `.test.ts` | 笔画列表、撤销、导出缩放比 |
| `src/features/canvas/MaskBrushEditor.tsx` | 笔刷编辑器，取代 `RegionMaskEditor` |
| `src/lib/maskRaster.ts` | `<canvas>` 光栅化与导出，原语可注入 |
| `server/editIntentTemplates.mjs` + `.test.mjs` | 九个提示词模板 |
| `server/seedreamGenerationProvider.mjs` | PR-4 |
| `server/geminiGenerationProvider.mjs` | PR-4 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `server/generationProvider.mjs` | `editOperation` 校验、三条翻译分发、`expandTo` 垫图与蒙版、**修冲突 ③** |
| `server/generationModels.mjs` | `supportsMask` → `maskSupport` 四值 |
| `server/imageOverlay.mjs` | 复用 `composeMarkOverlayPng` 做视觉指针（目前零调用方） |
| `src/domain/canvas.ts` | 配方增 `editOperation` / `expandTo` |
| `src/features/agent/AgentWorkspace.tsx`、`src/features/canvas/CanvasWorkspace.tsx` | 两处编辑器接线迁移（各约两行） |
