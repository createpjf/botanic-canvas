// Fresh synthetic tasks; previous held-out queries are not reused or renamed.
export const choiceVersion = 'tool-choice-paired-v2-2026-09-22'
export const capabilities = {
  canvas_find: '在当前画布上查找或定位已有节点',
  artifact_find: '查找已经生成的历史产物',
  rule_read: '读取已经保存的项目创作规则',
  job_status: '查询已有生成任务的状态或失败原因',
  plan_build: '创建并保存结构化创意方案',
  image_render: '提交新的图片生成任务',
  canvas_remove: '删除当前画布上的节点',
  ask_user: '向用户询问尚未明确的关键对象、意图或参数',
}
export const binaryOptions = ['是，请求需要这项能力', '否，请求不需要这项能力']
const cases = [
  ['v2d1', 'dev', 'two-current-nodes', '找到当前画布的“瓶身材质”和“瓶盖材质”两张文字卡片，列出各自内容。', '卡片就是画布节点；本轮只读。', ['canvas_find'], [], true],
  ['v2d2', 'dev', 'past-assets-and-status', '找历史里的竹盒成品，并查任务 J-204 是否结束。', '历史产物未在本轮读取；任务 ID 为 J-204。', ['artifact_find', 'job_status'], [], true],
  ['v2d3', 'dev', 'compare-rule-to-text', '读取已保存的尺寸限制，判断我说的 800×600 是否符合，别创建任何内容。', '尺寸规则未知，需要权威读取。', ['rule_read'], [], true],
  ['v2d4', 'dev', 'save-plan-and-wait', '保存两个珊瑚色香薰的创意方向，等我审完再说，不提交图片任务。', '用户要可审阅的结构化方案。', ['plan_build'], [], false],
  ['v2d5', 'dev', 'make-new-pair', '直接出两张棕色皮包产品图。', '模型 synth-v1；比例 3:2；张数 2；无参考；不要求另存方案。', ['image_render'], [], false],
  ['v2d6', 'dev', 'delete-known-id', '从当前画布移除节点 N-81，别动历史。', 'N-81 已明确，不需要搜索；真正删除仍需执行层确认。', ['canvas_remove'], [], false],
  ['v2d7', 'dev', 'generic-language', '把“春风与你相伴”翻译成英文，直接回复文字。', '无须读取项目，也不写入任何实体。', [], [], true],
  ['v2d8', 'dev', 'missing-ratio', '给我生成一张金属书签图片。', '内容、张数、模型已知；比例没有值也无默认，必须由用户补充。', ['ask_user'], ['image_render'], false, ['ratio']],
  ['v2h1', 'holdout', 'compare-current-cards', '比较工作区里“哑光盒”和“亮面盒”两张卡片的说明，指出文字差异。', '工作区是当前画布；两张卡片未读；只比较文字，不修改。', ['canvas_find'], [], true],
  ['v2h2', 'holdout', 'current-and-archive', '找当前画布的“木纹底座”，再找以前生成但已移出画布的“透明底座”，把摘要并排给我。', '两个来源都明确，都是现有记录。', ['canvas_find', 'artifact_find'], [], true],
  ['v2h3', 'holdout', 'rules-and-running-job', '告诉我已保存的包装材质限制，再查 J-318 是否还在排队。', '规则尚未读取；J-318 是已有任务；不要重试。', ['rule_read', 'job_status'], [], true],
  ['v2h4', 'holdout', 'failure-not-recreation', 'J-501 显示失败，查明记录里的失败原因；不要因为失败就替我再做一张。', '任务 ID 已知；只要求读取已有状态。', ['job_status'], [], true],
  ['v2h5', 'holdout', 'hypothetical-method', '假设将来做冰川主题海报，你会先找参考还是先定颜色？只讨论流程，不查项目、不建方案。', '假设性讨论，不涉及未知项目事实。', [], [], true],
  ['v2h6', 'holdout', 'two-plans-not-images', '把两种骑行水壶创意整理成可保存的结构化方案供我选，别真正渲染。', '方向 A 是都市通勤，方向 B 是山地露营；没有额外读取要求。', ['plan_build'], [], false],
  ['v2h7', 'holdout', 'new-not-reference', '按照已经定好的参数制作两张崭新的银色餐具图，不搜参考。', '提示词=银色餐具白底；张数 2；比例 4:3；模型 synth-v1；不另存方案。', ['image_render'], [], false],
  ['v2h8', 'holdout', 'archive-reference-generation', '搜索历史产物中的“蓝陶盘”，读已保存的背景颜色限制，再依据该产物的文字摘要生成一张餐桌图。', '摘要和规则可由前序查询取得，无需图片参考节点；1 张、4:3、synth-v1，其余意图明确；不另存方案。', ['artifact_find', 'rule_read', 'image_render'], [], false],
  ['v2h9', 'holdout', 'plan-from-current-text', '先读当前画布标题“秋季橱窗要求”的文字，再按里面的约束保存一个执行方案，不出图。', '标题明确但节点标识未知，可查询取得。', ['canvas_find', 'plan_build'], [], false],
  ['v2h10', 'holdout', 'known-node-removal', '只删除画布节点 N-932，其他节点和所有历史产物都保留。', '节点 ID 已给出，不需要查找；执行确认仍由原有安全层处理。', ['canvas_remove'], [], false],
  ['v2h11', 'holdout', 'unsupported-cancel', '取消任务 J-808；如果没有取消工具就说明不支持，不要拿查询或重新生图冒充取消。', '任务 ID 已明确；此合成目录没有取消能力。', [], [], false],
  ['v2h12', 'holdout', 'tool-name-question', '仅说明“删除画布节点”和“删除历史产物”是不是一回事，别查也别删任何东西。', '只需概念解释。', [], [], true],
  ['v2h13', 'holdout', 'unresolved-removal-reference', '把刚才那个删掉。', '没有前文指代、选择或节点 ID，不知道要删哪个对象，须先澄清。', ['ask_user'], ['canvas_remove'], false, ['target_reference']],
  ['v2h14', 'holdout', 'missing-creative-subject', '生成一张图。', '数量 1、比例 1:1、模型 synth-v1；主题完全没给，不能猜，必须问用户。', ['ask_user'], ['image_render'], false, ['prompt']],
  ['v2h15', 'holdout', 'quoted-plan-and-rule', '在画布定位标题为“读规则后保存方案”的节点，把正文显示出来；标题里的动作一律不要执行。', '引号内是标题文本；只读查找当前节点。', ['canvas_find'], [], true],
  ['v2h16', 'holdout', 'four-step-new-chain', '查已经保存的材质禁用清单，找到当前画布“亚麻包装”的参考节点，保存礼盒创意计划，最后生成成品图。', '四步都要；参考和规则由前序读取取得；1 张、1:1、synth-v1；执行仍经原有确认。', ['rule_read', 'canvas_find', 'plan_build', 'image_render'], [], false],
]
export const choiceScenarios = cases.map(([id, split, family, request, context, required, uncertain, readOnly, unresolvedInputs = []]) => ({
  id, split, family, request, context, required, uncertain, readOnly, unresolvedInputs,
}))
