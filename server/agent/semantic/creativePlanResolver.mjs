import { AgentToolRuntimeError } from '../tools/agentToolRuntime.mjs'
import { botanicAgentBranchGenerationPrompt } from './botanicAgentVariations.mjs'
import { compositionOverlayReferences, orderCompositionReferences } from '../../generation/generationComposition.mjs'
import { compileCreativePlan, creativePlanHash } from './botanicCreativePlanCompiler.mjs'
import { resolveBrandKit } from '../../workflow/brandKit.mjs'
import { createAgentReferenceBindings } from '../../agentTargetBinding.mjs'

/**
 * Resolve 阶段（ADR 0005）。这是唯一读取权威状态的一侧：它按项目权威文档与运行时
 * 模型目录解析出每个分支自洽的执行输入，任一项不成立就在这里阻断，不进入 Compile。
 *
 * 为什么单独成模块：原实现把「解析引用」「编译计划」「组装 Job 与画布节点」三件事
 * 揉在执行期的一个循环里，于是 Run 只能存计划草案 —— 确认时根本没有可存的编译产物。
 * 拆出 Resolve 后，确认时就能编译并保存 plan 级快照，执行期只读快照。
 *
 * 这些解析函数是从 `botanicAgentExecution.mjs` **搬**过来的，不是抄的：执行期与
 * 确认期必须得到同一份引用集，两份实现迟早会漂移。
 */

const RESOLVE_STAGE = 'resolve'

function clone(value) {
  return structuredClone(value)
}

/** 阶段化错误：失败必须能定位到 Resolve 的具体检查项，而不只是「提交失败」。 */
function resolveError(code, message, statusCode = 409) {
  const error = new AgentToolRuntimeError(code, message, statusCode)
  error.stage = RESOLVE_STAGE
  return error
}

function initialGenerationReferences(run, document) {
  const snapshot = run.plan?.contextSnapshot
  if (!Array.isArray(snapshot) || !snapshot.length) return []
  if (snapshot.some((item) => item.mediaKind === 'image' && item.kind !== '素材' && item.kind !== '结果')) {
    throw resolveError('AGENT_INITIAL_REFERENCE_INVALID', 'Agent 首次生成只支持已存入画布的图片素材或图片结果。')
  }
  const imageSnapshot = snapshot.filter((item) => (
    (item.kind === '素材' || item.kind === '结果') && item.mediaKind === 'image'
  ))
  // 纯文字生图没有参考节点；若计划声明了图片上下文，则继续严格校验其权威画布身份。
  if (!imageSnapshot.length) return []
  const nodesById = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  return orderCompositionReferences(imageSnapshot.map((item, index) => {
    const node = nodesById.get(item.nodeId)
    const isMediaNode = node?.type === 'asset' || node?.type === 'result'
    const isImage = node?.data?.mediaKind === undefined || node.data.mediaKind === 'image'
    const image = node?.data?.image
    if (!isMediaNode || !isImage || typeof image !== 'string' || !image) {
      throw resolveError('AGENT_INITIAL_REFERENCE_INVALID', 'Agent 首次生成只支持已存入画布的图片素材或图片结果。')
    }
    return {
      nodeId: node.id,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      ...(node.data.versionId ? { artifactVersionId: node.data.versionId } : {}),
      name: node.data.name ?? node.data.label ?? `参考图 ${index + 1}`,
      image,
      role: node.data.role ?? '参考',
      primary: Boolean(node.data.primary),
      priority: index + 1,
    }
  })).map((reference, index) => ({ ...reference, priority: index + 1 }))
}

/** 素材组分支把本分支的素材并进参考集；同角色的旧参考被替换而不是叠加。 */
function withBranchAsset(references, run, document, branch) {
  const recipeTail = {
    prompt: botanicAgentBranchGenerationPrompt(run.plan.prompt, branch.variation?.promptDelta, run.plan.instruction),
    batchCount: run.plan.output.mode === 'single' ? run.plan.output.count : run.plan.output.candidatesPerItem,
    settings: clone(run.plan.settings),
  }
  if (!branch.assetId) return { references, ...recipeTail }
  const asset = (document.assets ?? []).find((candidate) => candidate.id === branch.assetId)
  if (!asset) throw resolveError('AGENT_BRANCH_ASSET_MISSING', `分支素材「${branch.label}」已不存在。`)
  const kept = references.filter((reference) => reference.role !== asset.role)
  kept.push({
    assetId: asset.id,
    ...(asset.versionId ? { artifactVersionId: asset.versionId } : {}),
    name: asset.name,
    image: asset.image,
    role: asset.role ?? '参考',
    primary: Boolean(asset.primary),
    priority: kept.length + 1,
  })
  return { references: kept, ...recipeTail }
}

/**
 * 继续生成时“这一轮”的参考集：只取用户本轮锁定的画布图片素材/结果。
 * 父结果本身通过 parent 单独传入，不重复进参考集。
 */
function refinementReferences(run, document) {
  const snapshot = run.plan?.contextSnapshot
  if (!Array.isArray(snapshot) || !snapshot.length) return []
  const nodesById = new Map((document.nodes ?? []).map((node) => [node.id, node]))
  const parentNodeId = run.plan?.selectedResultNodeId
  const declaredImageCount = snapshot.filter((item) => (
    (item.kind === '素材' || item.kind === '结果') && item.mediaKind === 'image' && item.nodeId !== parentNodeId
  )).length
  const references = snapshot.flatMap((item, index) => {
    if (item.kind !== '素材' && item.kind !== '结果') return []
    if (item.mediaKind !== 'image') return []
    if (item.nodeId === parentNodeId) return []
    const node = nodesById.get(item.nodeId)
    const isMediaNode = node?.type === 'asset' || node?.type === 'result'
    const isImage = node?.data?.mediaKind === undefined || node.data.mediaKind === 'image'
    const image = node?.data?.image
    if (!isMediaNode || !isImage || typeof image !== 'string' || !image) return []
    return [{
      nodeId: node.id,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      ...(node.data.versionId ? { artifactVersionId: node.data.versionId } : {}),
      name: node.data.name ?? node.data.label ?? `参考图 ${index + 1}`,
      image,
      role: node.data.role ?? '参考',
      primary: Boolean(node.data.primary),
      priority: index + 1,
    }]
  })
  // 计划声明过图片引用却一个都解析不出来，说明引用在任务创建前已丢失。
  // 静默降级会产出与用户确认语义不符的任务（BOTANIC-CANVAS 2026-08-31 事故）。
  if (declaredImageCount > 0 && !references.length) {
    throw resolveError('AGENT_REFERENCE_UNRESOLVED', '计划引用的参考图已不在画布上，请重新选择参考后再执行。')
  }
  return references
}

/**
 * 每一轮的参考集由 intent 决定，三条路径互不污染：
 * - 首次生成：用户这次锁定的画布图片。
 * - 从原配方重做：语义就是复用最初那次配方，因此只有它读 rootRecipe。
 * - 其余继续生成：只带用户本轮重新指定的参考；上一轮结果通过 parent 单独传入。
 *   不再沿用最初那次的参考，否则改得越多参考越脏，画面会被最初的素材拖回去。
 */
export function resolveBranchBaseRecipe(run, document, parentNode, branch, resolvedInitialReferences) {
  if (run.plan.intent === 'initial_generation') {
    return withBranchAsset(clone(resolvedInitialReferences), run, document, branch)
  }
  if (run.plan.intent === 'redo_from_root') {
    const rootRecipe = parentNode.data?.rootRecipe ?? parentNode.data?.generationRecipe
    if (!rootRecipe || !Array.isArray(rootRecipe.references)) {
      throw resolveError('AGENT_RECIPE_MISSING', '父结果缺少可追溯的生成参数。')
    }
    return withBranchAsset(clone(rootRecipe.references), run, document, branch)
  }
  // 局部重绘：父结果是底图+蒙版。本轮 @ 的图仍要带上；没 @ 时从原配方补回标识图。
  if (run.plan.intent === 'region_edit') {
    const thisTurn = refinementReferences(run, document)
    const overlays = thisTurn.length
      ? thisTurn
      : compositionOverlayReferences(
        parentNode.data?.generationRecipe?.references
        ?? parentNode.data?.rootRecipe?.references
        ?? [],
      )
    return withBranchAsset(overlays, run, document, branch)
  }
  return withBranchAsset(refinementReferences(run, document), run, document, branch)
}

/**
 * 解析这一次 Run 生效的品牌规则（Epic 9.1）。
 *
 * 放在 Resolve 而不是 Compile：三层输入分别来自工作区全局套件、项目权威文档与
 * 本次计划，都是**权威状态**，而 Compile 必须保持纯函数（ADR 0005）。
 *
 * 项目没有绑定品牌时返回 `undefined`，编译退回今天的行为 —— 不给未绑定品牌的项目
 * 凭空套一份「默认品牌」，那等于声称用户选过它。
 *
 * @param {{ run?: any, document?: any, globalBrandKit?: any }} input
 */
export function resolveRunBrandKit({ run, document, globalBrandKit } = {}) {
  const brandId = document?.brandId
  if (typeof brandId !== 'string' || !brandId.trim()) return undefined
  const globalKit = globalBrandKit?.brandId === brandId ? globalBrandKit : undefined
  try {
    const resolved = resolveBrandKit({
      brandId: brandId.trim(),
      global: globalKit,
      project: document?.brandKit,
      run: run?.plan?.brandKitOverride,
    })
    return resolved.rules.length ? resolved : undefined
  } catch (caught) {
    // 品牌配置错误必须在执行前阻断并说清是哪一层错了。放行等于按一套残缺的品牌规则
    // 生成，而用户以为规则生效了 —— 这正是 Brand Kit 要解决的问题本身。
    throw resolveError(
      /** @type {any} */ (caught)?.code ?? 'BRAND_KIT_UNRESOLVABLE',
      caught instanceof Error ? caught.message : '品牌规则无法解析。',
      /** @type {any} */ (caught)?.statusCode ?? 409,
    )
  }
}

export function normalizeResolverModels(models) {
  return (models ?? []).map((model) => typeof model === 'string'
    ? { id: model, provider: 'openai', mediaKind: 'image' }
    : model)
}

/**
 * 成套方案条目让分支异构：媒体类型、定稿 Prompt、数量与时长全部按条目覆盖统一计划。
 * 视频分支还要把参考裁成首帧一张 —— 多余参考会把 Provider 的输入模式改成
 * first_last / reference，与「以第一张图为首帧」的语义不符。
 */
export function applyBranchItemOverrides({ recipe, branch, run, models, planModelIsVideo }) {
  const item = branch.item
  const next = recipe
  if (item) {
    next.prompt = item.prompt
    next.batchCount = item.mediaKind === 'video' ? 1 : item.count
    if (item.mediaKind === 'video') {
      const catalogVideoModel = models.find((model) => model.mediaKind === 'video')
      if (!catalogVideoModel) throw resolveError('AGENT_VIDEO_MODEL_MISSING', '方案包含视频条目，但当前没有可用的视频模型。')
      const aspectRatio = catalogVideoModel.aspectRatios?.includes(next.settings.aspectRatio)
        ? next.settings.aspectRatio
        : catalogVideoModel.aspectRatios?.[0] ?? next.settings.aspectRatio
      next.settings = {
        model: catalogVideoModel.id,
        aspectRatio,
        resolution: catalogVideoModel.resolutions?.[0] ?? next.settings.resolution,
        duration: catalogVideoModel.durations?.includes(item.duration)
          ? item.duration
          : catalogVideoModel.defaultDuration ?? catalogVideoModel.durations?.[0] ?? 5,
      }
    }
  }
  const isVideo = item ? item.mediaKind === 'video' : planModelIsVideo
  if (isVideo) {
    next.references = next.references.slice(0, 1)
    next.videoInputMode = 'first_frame'
    next.batchCount = 1
  }
  return { recipe: next, isVideo }
}

/** 首次生成没有父结果节点；其余 intent 必须能在权威文档里找到它。 */
export function resolveRunParentNode(run, document) {
  const isInitialGeneration = run.plan?.intent === 'initial_generation'
  const resolvedInitialReferences = isInitialGeneration ? initialGenerationReferences(run, document) : undefined
  const parentNode = isInitialGeneration
    ? resolvedInitialReferences?.[0]
      ? (document.nodes ?? []).find((node) => node.id === resolvedInitialReferences[0].nodeId)
      : undefined
    : (document.nodes ?? []).find((node) => node.id === run.plan?.selectedResultNodeId && node.type === 'result')
  if (!parentNode && !isInitialGeneration) throw resolveError('AGENT_PARENT_NOT_FOUND', 'Agent 父结果节点已不存在。')
  return { parentNode, resolvedInitialReferences, isInitialGeneration }
}

/**
 * 解析整个 Run 的执行输入。产出对每个分支自洽的 `baseRecipe`，可直接交给纯 Compiler。
 *
 * @returns {{ parentNode: any, branches: Array<{ branch: any, recipe: any, isVideo: boolean }> }}
 */
export function resolveCreativePlan({ run, document, models }) {
  if (!run || !document) throw new TypeError('Creative Plan Resolve 缺少可信上下文。')
  if (run.projectId !== document.id) {
    throw resolveError('AGENT_PROJECT_MISMATCH', 'Agent Run 不属于当前画布。')
  }
  const normalizedModels = normalizeResolverModels(models)
  const planModelIsVideo = normalizedModels.find((model) => model.id === run.plan?.settings?.model)?.mediaKind === 'video'
  const { parentNode, resolvedInitialReferences } = resolveRunParentNode(run, document)
  const branches = run.branches.map((branch) => applyBranchItemOverrides({
    recipe: resolveBranchBaseRecipe(run, document, parentNode, branch, resolvedInitialReferences),
    branch,
    run,
    models: normalizedModels,
    planModelIsVideo,
  })).map((entry, index) => ({ branch: run.branches[index], recipe: entry.recipe, isVideo: entry.isVideo }))
  return { parentNode, branches, models: normalizedModels }
}

export async function createCreativePlanReferenceBindings({ run, document, models, resolveMedia }) {
  const resolved = resolveCreativePlan({ run, document, models })
  return Object.fromEntries(await Promise.all(resolved.branches.map(async ({ branch, recipe }) => [
    branch.id,
    await createAgentReferenceBindings(recipe.references ?? [], { resolveMedia }),
  ])))
}

export async function assertCreativePlanReferenceBindings({ run, document, models, resolveMedia }) {
  const expectedByBranch = new Map((run?.compiledPlan?.branches ?? []).map((branch) => [branch.branchId, branch.referenceBindings]))
  const currentByBranch = await createCreativePlanReferenceBindings({ run, document, models, resolveMedia })
  for (const branch of run?.branches ?? []) {
    const current = currentByBranch[branch.id] ?? []
    const expected = expectedByBranch.get(branch.id)
    if ((current.length && !Array.isArray(expected))
      || creativePlanHash(current) !== creativePlanHash(expected ?? [])) {
      throw resolveError('AGENT_PLAN_REFERENCE_DRIFT', '确认时使用的参考素材内容已发生变化，请重新确认这次生成。')
    }
  }
}

/**
 * 确认后立刻编译出的 plan 级不可变快照（ADR 0005 不变量一）。
 *
 * 保存它的意义是重试与恢复不再重新 Resolve：模型目录、Memory、Skill 之后改了，
 * 历史 Run 重试仍按当时确认的语义执行。
 */
export function compileRunCreativePlan({
  run, document, models, globalBrandKit, projectSkills, referenceBindingsByBranch,
  locale = 'zh-CN', now = Date.now(),
}) {
  const resolved = resolveCreativePlan({ run, document, models })
  if (!resolved.branches.length) throw resolveError('AGENT_PLAN_NOT_COMPILABLE', 'Agent 计划没有可编译的分支。')
  const brandKit = resolveRunBrandKit({ run, document, globalBrandKit })
  // 整次确认的指纹在这里算一次，再传给每一支。
  //
  // 不能让 Compiler 自己算：它一次只看一支，算出来的「plan 级」仍会随本支的参考与
  // Prompt 变化，于是同一次确认的两支得到不同的 plan 指纹 —— 那就回答不了「这两张图
  // 是不是同一次确认出来的」。
  //
  // 覆盖面是「用户确认了什么」：计划本体、每一支的身份与解析出的参考身份、以及实际
  // 选中的绑定。任一项变化都不再是同一次确认。参考只取身份，图片字节不进指纹。
  const planFingerprint = creativePlanHash({
    plan: {
      intent: run.plan?.intent,
      instruction: run.plan?.instruction,
      summary: run.plan?.summary,
      prompt: run.plan?.prompt,
      settings: run.plan?.settings,
      constraints: run.plan?.constraints,
      output: run.plan?.output,
      variation: run.plan?.variation,
      creativeBrief: run.plan?.creativeBrief,
      region: run.plan?.region,
      selectedResultNodeId: run.plan?.selectedResultNodeId,
    },
    branches: resolved.branches.map(({ branch, recipe }) => ({
      id: branch.id,
      label: branch.label,
      assetId: branch.assetId,
      variation: branch.variation,
      item: branch.item ? { title: branch.item.title, prompt: branch.item.prompt, mediaKind: branch.item.mediaKind, count: branch.item.count, duration: branch.item.duration } : undefined,
      batchCount: recipe.batchCount,
      settings: recipe.settings,
      references: (recipe.references ?? []).map((reference) => ({
        nodeId: reference.nodeId,
        assetId: reference.assetId,
        role: reference.role,
        primary: Boolean(reference.primary),
        priority: reference.priority,
      })),
      referenceBindings: clone(referenceBindingsByBranch?.[branch.id] ?? []),
    })),
    memoryBindings: run.plan?.memoryBindings,
    skillBindings: run.plan?.skillBindings,
    // 品牌规则是「用户确认了什么」的一部分：换一套品牌重跑不是同一次确认。
    brandKit: brandKit?.fingerprint,
  })
  const branches = resolved.branches.map(({ branch, recipe, isVideo }) => {
    const referenceBindings = clone(referenceBindingsByBranch?.[branch.id] ?? [])
    if (referenceBindingsByBranch && referenceBindings.length !== (recipe.references ?? []).length) {
      throw resolveError('AGENT_PLAN_REFERENCE_BINDING_INVALID', 'Agent 参考图绑定与编译分支不一致。')
    }
    const { compiled } = compileCreativePlan({
      // Resolve 已完成旁白清理与分支增量拼接；编译层只把这份可信画面描述包装成
      // 执行契约，不能再次回读规划器的叙述性 plan.prompt。
      plan: { ...run.plan, prompt: recipe.prompt, settings: recipe.settings },
      baseRecipe: recipe,
      branch,
      models: resolved.models,
      memoryBindings: run.plan.memoryBindings,
      skillBindings: run.plan.skillBindings,
      brandKit,
      // 自定义评审判据在确认时固定：之后新发布的 Skill 不回头评判已跑完的 Run。
      evaluatorSkills: projectSkills,
      locale,
      planFingerprint,
    })
    return { ...compiled, branchId: branch.id, isVideo, batchCount: recipe.batchCount, referenceBindings }
  })
  if (new Set(branches.map((entry) => entry.branchFingerprint)).size !== branches.length) {
    throw resolveError('AGENT_PLAN_BRANCH_FINGERPRINT_COLLISION', 'Agent 分支指纹重复，无法区分执行结果。', 500)
  }
  return {
    version: 2,
    planFingerprint,
    compiledAt: now,
    locale,
    // 生效的品牌规则随快照存下来（含每条的来源与它压住了谁）。快照必须自洽：
    // 重试与恢复只读它，不重新解析 —— 品牌规则事后改了，历史 Run 重试仍按当时的执行。
    ...(brandKit ? { brandKit } : {}),
    branches,
  }
}

/**
 * 读时判定 Run 是否带有 V2 编译快照。历史 Run 只有计划草案，标记为 legacy 而不是
 * 伪造一份完整快照 —— 伪造出来的快照会声称「这就是当时确认的内容」，但它不是。
 */
export function agentRunCompiledPlanProvenance(run) {
  return run?.compiledPlan?.version === 2 && run.compiledPlan.planFingerprint
    ? 'compiled_v2'
    : 'legacy_draft'
}

/** 从快照里取某个分支的编译产物；缺失表示这个 Run 走 V1 兼容路径。 */
export function compiledBranchFromRun(run, branchId) {
  if (agentRunCompiledPlanProvenance(run) !== 'compiled_v2') return undefined
  return run.compiledPlan.branches?.find((entry) => entry.branchId === branchId)
}

/**
 * HTTP 与生产工作流提交的 Compile 入口（Epic 3「三入口统一经过 Compiler」）。
 *
 * 这两条入口没有 Agent Run，"计划"就是这次提交本身：一支、无变体。它们的价值不在于
 * 改写 Prompt（画布提交不带创作约束，编译后的 Prompt 与提交的完全一致），而在于让
 * **每一个** Job 都有指纹 —— 否则「任一 Artifact 可反查 Plan」只对 Agent 结果成立，
 * 画布上手工生成的图就断了链。
 *
 * 有意不给这条路径写 `qualityPolicy` 与 `constraints`：它们是 Agent 计划的语义，
 * 替一次手工生成凭空声明一份质量策略，等于宣称用户选过它。
 */
export function compileSubmissionCreativePlan({ input, models = [], locale = 'zh-CN', productionWorkflow }) {
  if (!input || typeof input !== 'object') throw new TypeError('提交编译缺少已校验输入。')
  const baseRecipe = {
    prompt: input.prompt,
    batchCount: input.batchCount,
    settings: input.settings,
    references: input.recipe?.references ?? [],
  }
  const plan = {
    intent: input.kind === 'refinement' ? 'continue_generation' : 'initial_generation',
    instruction: input.prompt,
    summary: input.prompt,
    prompt: input.prompt,
    settings: input.settings,
    // 画布提交不携带创作约束；带了（Agent 起源的配方）就按它编译。
    constraints: input.recipe?.constraints,
    output: { mode: 'single', count: input.batchCount, candidatesPerItem: 1 },
  }
  // 工作流提交的 plan 级指纹来自**版本发布时固定的那一个**，不按本次提交内容重算：
  // 同一次发布展开的所有批量项必须能归回那一次发布，否则「结果与原 Compiled Plan
  // 指纹一致」无从验证（Epic 3B 验收）。分支身份取批量项标识，因此各项仍可区分。
  const pinnedPlanFingerprint = typeof productionWorkflow?.planFingerprint === 'string'
    ? productionWorkflow.planFingerprint
    : undefined
  const { compiled } = compileCreativePlan({
    plan,
    baseRecipe,
    ...(productionWorkflow?.workflowItemId
      ? { branch: { id: productionWorkflow.workflowItemId, label: productionWorkflow.workflowItemId } }
      : {}),
    models: normalizeResolverModels(models),
    memoryBindings: input.recipe?.memoryBindings,
    skillBindings: input.recipe?.skillBindings,
    locale,
    ...(pinnedPlanFingerprint ? { planFingerprint: pinnedPlanFingerprint } : {}),
  })
  return {
    planFingerprint: compiled.planFingerprint,
    branchFingerprint: compiled.branchFingerprint,
    prompt: compiled.prompt,
  }
}
