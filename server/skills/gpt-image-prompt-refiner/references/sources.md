# 来源与适配范围

核对日期：2026-09-10。依据 OpenAI 官方 [Image prompting](https://developers.openai.com/api/docs/guides/image-prompting) 及其 [Markdown 页面](https://developers.openai.com/api/docs/guides/image-prompting.md) 编写；接口配置在执行时通过 [Image generation](https://developers.openai.com/api/docs/guides/image-generation) 复核。

该 Skill 为独立编写的提示优化工作流，不是官方 OpenAI 产品。包内案例为新编文本，没有打包官方示例图片或整页文档。

| 官方指南内容 | 本 Skill 采用的做法 |
|---|---|
| Prompting fundamentals | 先定义结果；明确主体、关系、构图、材料、光线与限制 |
| Choose a maintainable format | 选择最易维护的短段落或字段，不假定特殊语法 |
| Specify exact text | 引号、位置、字体处理、出现次数与逐字检查 |
| Assign roles to references | 分开身份、衣着、风格、背景和结构职责 |
| Separate changes from constraints | 编辑的变化项与保留项分列 |
| Refine an image across turns | 一次改一个主要条件，保留有效基准与关键约束 |
| Transparent product cutout | 描述、参数和实际 Alpha 验证共同决定透明交付 |
| Migrate an existing workflow | 固定输入做对比，先满足质量，再优化延迟与成本 |
| Repeated edits / pixel-identical regions | 承认编辑漂移，逐像素保持需要原图合成 |
| Check the result | 文字、关系、身份、产品形状和修改范围需要实图检查 |

操作分流、默认单提示输出、缺口判断、意图核对与维护入口，是面向提示优化任务的工作流设计；不将这些约定冒称为官方 API 功能。

本包保留有日期的模型差异参考，以避免将 input_fidelity、透明或质量档复制到不支持的接口。模型、尺寸、质量选项、价格和生命周期会变化；在线无法核实时保留用户设置、说明待查，不用记忆中的型号替换用户目标。

Skill 的文本结构与案例检查不等于真实生图能力验证。只有实际执行并查看结果，才能报告图片质量、文字准确率、人物 / 产品保持与成本。
