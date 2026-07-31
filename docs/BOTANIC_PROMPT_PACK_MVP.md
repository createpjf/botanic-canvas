# Botanic 植物学系列提示词包 · MVP 草案

> 内容边界：提示词与风格事实仅来自《植物学系列图片提示词整合.md》。
> `原文`表示可直接收录；`扩展草案`表示基于原文风格锚点组合出的新任务，需确认后再正式收录。

## 一、产品结构

```text
Botanic 植物学系列提示词包
├── 全局规则
│   ├── 模特一致性前缀
│   ├── 通用负面提示词
│   └── 默认画幅
├── 系列
│   ├── 一朵白云
│   ├── 条纹毛衣套装
│   ├── 波西塔诺
│   ├── 浪漫庄园小衫
│   ├── 玫瑰系列套装
│   ├── 玫瑰系列马甲套装
│   ├── 粉紫双面呢
│   ├── 莫兰迪衬衫
│   ├── 香榭丽舍
│   └── 浪漫曼波+牛仔外套（资料待补充）
├── 拍摄任务
│   ├── 白底展示｜原文
│   ├── 环境大片｜原文
│   ├── 服装细节｜扩展草案
│   └── 社媒种草｜扩展草案
└── 可调变量
    ├── 上装颜色
    ├── 动作
    ├── 道具
    ├── 场景
    ├── 光线
    └── 画幅
```

源文件共有 10 个系列，其中 9 个具备完整的风格锚点、白底提示词和环境提示词。「浪漫曼波+牛仔外套」没有具体提示词，MVP 中应显示“资料待补充”，不自动推断。

## 二、完整样例：一朵白云

### 1. 系列锚点｜原文

- 核心记忆点：轻盈白裙＋贴身细针织上衣
- 白裙：小腿中部、A 字放量、腰部褶量、干净伞形轮廓
- 上装：圆领细罗纹针织
- 可用颜色：深咖、浅灰、米白、奶油黄
- 整体气质：柔软、干净、日常、低饱和
- 常用道具：花束
- 场景：白色百叶窗、木质窗框、阳光房、白帘、暖木地板
- 光线：高调柔光或自然侧光

系列核心中的“圆领细针织”和“白色中长 A 字伞裙”默认锁定；每次只建议调整 1～2 个变量。

### 2. 可调变量

| 变量 | 默认值 | 可选值 |
|---|---|---|
| 上装颜色 | 浅灰 | 深咖、浅灰、米白、奶油黄 |
| 道具 | 淡粉雏菊 | 淡粉雏菊、小花束 |
| 动作 | 自然全身站姿 | 抱花、看向窗外、轻扶窗框、微微倚靠 |
| 场景 | 暖灰白影棚 | 白色百叶窗、暖木窗框、阳光房 |
| 光线 | 柔和漫射光 | 高调柔光、自然侧光 |
| 画幅 | `4:5` | 电商 `4:5`、环境及内容图 `3:4` |

### 3. 白底展示｜原文

```text
young East Asian female model wearing a light gray fine ribbed knit round neck sweater and a white midi A-line cotton skirt with soft pleats, holding pale pink daisies, clean off-white studio background, full body lookbook fashion photography, soft diffused light, natural makeup, slightly wavy hair, minimal styling, airy spring mood, subtle film grain, 50mm portrait lens, vertical 4:5
```

默认参数：`4:5`、`2K`、1～2 张候选。

### 4. 环境大片｜原文

```text
young East Asian female model wearing a dark brown fine knit sweater and a voluminous white midi skirt, standing beside white louvered windows in a sunlit vintage room, warm wooden window frames, terracotta floor tiles, holding a small bouquet, soft natural window light, gentle French countryside mood, low contrast creamy color grading, relaxed pose looking outside, editorial lifestyle fashion photography, 50mm lens, vertical 3:4
```

默认参数：`3:4`、`2K`、1～2 张候选。

### 5. 服装细节｜扩展草案

由原文中的针织纹理、腰部褶量、柔灰背景与柔光锚点组合：

```text
young East Asian female model wearing a light gray fine ribbed knit round neck sweater and a white midi A-line cotton skirt with soft waist pleats, close fashion detail composition focusing on the fine ribbed knit texture, ribbed cuffs and natural skirt pleats, holding pale pink daisies, clean warm gray studio background, soft diffused light, low contrast creamy color grading, subtle film grain, vertical 4:5
```

### 6. 社媒种草｜扩展草案

由原文中的阳光房、花束、窗边动作及大量留白组合；留白用于后期排版，图中不直接生成文字：

```text
young East Asian female model wearing a cream fine ribbed knit round neck sweater and a voluminous white midi skirt, standing beside white louvered windows and warm wooden window frames in a bright sunroom, gently holding a small bouquet and looking outside, soft natural side light, quiet morning mood, low contrast creamy film color, relaxed lifestyle fashion photography, generous clean negative space in the upper left for later social layout, 50mm lens, vertical 3:4
```

### 7. 模特参考图前缀｜原文

仅当画布中存在“模特”参考图时自动添加：

```text
以实例图的模特为人物基准，动作可以跟随环境做合理的调整，五官不变。
```

### 8. 通用负面提示词｜原文

```text
logo, text, watermark, harsh flash, overexposed face, plastic skin, glossy synthetic fabric, exaggerated pose, runway styling, distorted hands, bad anatomy, extra fingers, wide angle distortion, messy background, low resolution
```

Botanic 当前没有独立的负面提示词字段。第一版可以在提交前编译成：

```text
[模特前缀，可选]
[任务提示词]
Avoid: [通用负面提示词]
```

## 三、现在就可以怎样使用

当前 Botanic 已经具备“商品、模特、场景、调性”参考角色，以及生成描述、比例、分辨率和候选数设置，可以先手工试用：

1. 上传服装或商品参考图，角色选“商品”，并设为主参考。
2. 按需加入“模特”“场景”“调性”参考图并连到同一生成节点。
3. 从本提示词包复制一个任务提示词到生成描述。
4. 有模特参考图时，在最前面添加模特一致性前缀。
5. 在末尾添加通用负面提示词。
6. 白底展示选择 `4:5`；环境大片选择 `3:4`；建议先用 `2K`、1～2 张候选。
7. 预览完整描述后再生成；每张结果会作为独立节点出现在画布中。

### 当前限制

- Botanic 当前真实生图走参考图编辑链路，至少需要一张参考图；源文件所说的“无底图直出”目前不能直接使用。
- 当前界面要求主“商品”参考，因此服装商品图应作为主参考，模特图作为辅助参考。
- 服务端当前会给所有生成任务添加“电商品牌首图”意图。环境大片、服装细节和社媒图接入时，需要改成更通用的“品牌时尚视觉”，避免任务被错误地收敛成商品主图。

## 四、在 Botanic 中做成正式功能

### 推荐交互

不增加复杂的常驻控件。在生成描述上方只显示一个轻量入口：

```text
[选择提示词包]

已选：一朵白云 · 白底展示      更换
```

点击后从右侧打开提示词包：

```text
选择系列 → 选择拍摄任务 → 调整 1～2 个变量 → 应用到生成节点
```

应用后只写入草稿，不自动生成。用户可以继续修改最终提示词、比例和候选数。

### 提示词包与工作流模板的区别

- 提示词包：只提供提示词、变量和默认生成参数，不携带具体素材。
- 工作流模板：保存画布节点、连线、素材和参数。

两者不应合并成同一种数据。提示词包可以放在现有“工作流模板”侧栏的新分页中，但应保持独立类型。

### 第一版最小实现

1. 新增内置提示词包数据，先录入 9 个完整系列。
2. 新增提示词编译器，负责变量替换、模特前缀和负面提示词拼接。
3. 在生成器加入“选择提示词包”入口，选择后更新当前生成节点的 `prompt`、`aspectRatio`、`resolution` 和 `batchCount`。
4. 保留可编辑的最终提示词，不直接提交任务。
5. 将服务端固定的“电商品牌首图”意图改为与任务匹配的通用描述。
6. 暂不修改持久化 Schema：第一版把编译后的最终提示词继续存入现有生成配方即可。

建议新增：

```text
src/data/promptPacks.ts
src/lib/promptPackCompiler.ts
src/components/PromptPackPanel.tsx
```

建议复用：

```text
src/domain/canvas.ts            提示词包类型
src/App.tsx                     入口与应用草稿
src/store/canvasStore.ts        更新生成节点
server/generationProvider.mjs   调整固定任务意图
```

### 后续增强

第二阶段再把以下溯源信息作为可选元数据写入生成配方：

```json
{
  "packId": "botanic-fashion-v1",
  "packVersion": 1,
  "seriesId": "white-cloud",
  "taskId": "studio",
  "variables": {
    "topColor": "light-gray"
  }
}
```

这样可以支持“复用同一预设”“查看某张图来自哪个系列”和后续效果分析；MVP 无需因此升级画布 Schema。

## 五、建议的 MVP 验收标准

- 9 个完整系列均能选择白底展示或环境大片。
- 「浪漫曼波+牛仔外套」明确显示“资料待补充”，不可生成虚构提示词。
- 选择预设只更新草稿，不自动发起真实生成。
- 有模特参考图时自动添加一致性前缀；没有时不添加。
- 画幅随任务正确切换：白底 `4:5`，环境 `3:4`。
- 最终提示词对用户可见、可编辑。
- 原有工作流模板、历史配方和结果节点行为不受影响。
