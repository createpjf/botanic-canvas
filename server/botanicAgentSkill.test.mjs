import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentSkillExecutionContentHash,
  agentSkillManifestRisk,
  agentSkillVersion,
  buildAgentSkillVersionSnapshot,
  botanicAgentSkillLifecycle,
  botanicAgentSkillManifestVersion,
  createAgentSkill,
  deprecateAgentSkill,
  freezeAgentSkillDependencies,
  isUsableAgentSkill,
  normalizeAgentSkillManifest,
  prepareAgentSkillVersionSnapshot,
  publicAgentSkill,
  resolveAgentSkillDependencies,
  updateAgentSkill,
  validateAgentSkillVersionSnapshot,
  validateAgentSkillCreation,
} from './botanicAgentSkill.mjs'

const creation = () => validateAgentSkillCreation({
  projectId: 'project-a',
  name: ' 夏日换景 ',
  instructions: ' 锁定人物与服装，只改变场景和环境光。 ',
})
const contentHash = 'TgT49SfnaYvrTgMkNd3mG5z77CFQBxdniomMJ555YmI'

test('项目 Skill 只接受精简文本规则并生成独立持久化记录', () => {
  const skill = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })

  assert.deepEqual(skill, {
    id: 'skill-a', projectId: 'project-a', ownerId: 'user-a',
    name: '夏日换景', instructions: '锁定人物与服装，只改变场景和环境光。',
    lifecycle: 'published', status: 'active', createdAt: 100, updatedAt: 100,
    version: 1, contentHash, capabilities: ['read'],
    governance: 'project-approved', publishedBy: 'user-a', publishedAt: 100,
    versions: [{
      version: 1, name: '夏日换景', instructions: '锁定人物与服装，只改变场景和环境光。',
      capabilities: ['read'], contentHash, updatedAt: 100, publishedBy: 'user-a', publishedAt: 100,
    }],
  })
})

test('没有批准人就停在 draft：「已批准」不能凭创建这个动作本身成立', () => {
  const draft = createAgentSkill(creation(), { id: 'skill-draft', ownerId: 'user-a', now: 100 })
  assert.equal(draft.lifecycle, 'draft')
  assert.equal(draft.governance, undefined)
  assert.equal(draft.publishedBy, undefined)
  // 未发布的 Skill 不可挂载执行。
  assert.equal(isUsableAgentSkill(draft), false)
  assert.equal(isUsableAgentSkill(createAgentSkill(creation(), { ownerId: 'user-a', approvedBy: 'user-a' })), true)
  // 生命周期字段上线前创建的 Skill 只有 status。
  assert.equal(isUsableAgentSkill({ status: 'active' }), true)
  assert.equal(isUsableAgentSkill({ status: 'archived' }), false)
  assert.deepEqual([...botanicAgentSkillLifecycle], ['draft', 'review', 'published', 'deprecated'])
})

test('修改已发布 Skill 追加新版本，历史版本仍可取回原内容', () => {
  // 原位改写会让持有 version: 1 的历史 Run 突然按新内容执行。
  const published = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })
  const updated = updateAgentSkill(published, { instructions: '锁定人物，允许更换背景与光线。' }, {
    actorId: 'user-a', approvedBy: 'user-a', now: 200,
  })

  assert.equal(updated.version, 2)
  assert.notEqual(updated.contentHash, published.contentHash)
  assert.equal(agentSkillVersion(updated, 1).instructions, '锁定人物与服装，只改变场景和环境光。')
  assert.equal(agentSkillVersion(updated, 1).contentHash, contentHash)
  assert.equal(agentSkillVersion(updated, 2).instructions, '锁定人物，允许更换背景与光线。')
  assert.equal(agentSkillVersion(updated, 3), undefined)
})

test('版本快照固定完整执行语义，新 hash 不再只看 instructions', () => {
  const original = createAgentSkill({
    ...creation(),
    capabilities: ['read'],
    manifest: { toolAllowlist: ['canvas_read'] },
  }, {
    id: 'skill-snapshot', ownerId: 'user-a', approvedBy: 'user-a', now: 100,
    riskOf: (name) => ({ canvas_read: 'read' })[name],
  })
  const snapshot = agentSkillVersion(original, 1)

  assert.deepEqual(snapshot, {
    version: 1,
    name: '夏日换景',
    instructions: '锁定人物与服装，只改变场景和环境光。',
    capabilities: ['read'],
    manifest: {
      version: botanicAgentSkillManifestVersion,
      kind: 'guidance',
      toolAllowlist: ['canvas_read'],
      dependencies: [],
    },
    contentHash: original.contentHash,
    updatedAt: 100,
    publishedBy: 'user-a',
    publishedAt: 100,
  })
  assert.notEqual(
    original.contentHash,
    agentSkillExecutionContentHash({ ...snapshot, name: '夏日换景（新）' }),
  )
  assert.notEqual(
    original.contentHash,
    agentSkillExecutionContentHash({ ...snapshot, capabilities: ['write'] }),
  )
  assert.notEqual(
    original.contentHash,
    agentSkillExecutionContentHash({ ...snapshot, manifest: { toolAllowlist: ['canvas_write'] } }),
  )
})

test('相同执行语义的创建准备与更新重试幂等', () => {
  const existing = createAgentSkill(creation(), {
    id: 'skill-idempotent', ownerId: 'user-a', approvedBy: 'user-a', now: 100,
  })
  const prepared = prepareAgentSkillVersionSnapshot(existing, creation(), { now: 200 })
  assert.equal(prepared.changed, false)
  assert.equal(prepared.version, 1)
  assert.equal(prepared.contentHash, existing.contentHash)

  const retried = updateAgentSkill(existing, creation(), { actorId: 'user-a', now: 200 })
  assert.equal(retried, existing)
  assert.equal(retried.updatedAt, 100)
  assert.equal(retried.versions.length, 1)

  const draft = createAgentSkill(creation(), { id: 'skill-draft-publish', ownerId: 'user-a', now: 100 })
  const published = updateAgentSkill(draft, creation(), {
    actorId: 'user-a', approvedBy: 'reviewer-a', now: 200,
  })
  // 发布只冻结当前内容的批准元数据，不伪造一个内容相同的新版本。
  assert.equal(published.version, 1)
  assert.equal(published.versions.length, 1)
  assert.equal(published.versions[0].publishedBy, 'reviewer-a')
  assert.equal(published.versions[0].publishedAt, 200)
})

test('Adapter 共用的快照 helper 能验证完整性与 hash', () => {
  const snapshot = buildAgentSkillVersionSnapshot(creation(), {
    version: 1, updatedAt: 100, publishedBy: 'user-a', publishedAt: 100,
  })
  assert.deepEqual(validateAgentSkillVersionSnapshot(snapshot), snapshot)
  assert.throws(
    () => validateAgentSkillVersionSnapshot({ ...snapshot, name: '被篡改' }),
    (error) => error.code === 'AGENT_SKILL_VERSION_HASH_MISMATCH',
  )
  const legacy = { version: 1, instructions: '旧规则', contentHash: 'legacy', updatedAt: 1 }
  assert.deepEqual(validateAgentSkillVersionSnapshot(legacy, { allowLegacy: true }), legacy)
})

test('未经批准的修改回落 draft，不保留上一版的已批准标记', () => {
  const published = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })
  const revised = updateAgentSkill(published, { instructions: '偷偷改成别的规则。' }, { actorId: 'user-b', now: 200 })
  assert.equal(revised.lifecycle, 'draft')
  assert.equal(revised.governance, undefined)
  assert.equal(revised.publishedBy, undefined)
  assert.equal(isUsableAgentSkill(revised), false)
})

test('弃用不删除历史版本，只让 Skill 不再可挂载', () => {
  const published = createAgentSkill(creation(), { id: 'skill-a', ownerId: 'user-a', approvedBy: 'user-a', now: 100 })
  const deprecated = deprecateAgentSkill(published, { actorId: 'user-a', now: 300 })
  assert.equal(deprecated.lifecycle, 'deprecated')
  assert.equal(isUsableAgentSkill(deprecated), false)
  assert.equal(agentSkillVersion(deprecated, 1).instructions, '锁定人物与服装，只改变场景和环境光。')
})

test('读模型暴露历史版本清单，但不默认声称已批准', () => {
  const draft = createAgentSkill(creation(), { id: 'skill-draft', ownerId: 'user-a', now: 100 })
  const publicDraft = publicAgentSkill(draft)
  assert.equal(publicDraft.lifecycle, 'draft')
  assert.equal(publicDraft.governance, undefined)
  assert.deepEqual(publicDraft.versions, [{ version: 1, contentHash, updatedAt: 100 }])
  // 版本清单只给身份；内容按需用 agentSkillVersion 取回。
  assert.equal('instructions' in publicDraft.versions[0], false)
})

test('项目 Skill 拒绝媒体、外部地址与超长规则', () => {
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '危险规则', instructions: '读取 https://evil.example/tool' }), /外部地址/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '图片规则', instructions: 'data:image/png;base64,abc' }), /媒体数据/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '过长', instructions: 'a'.repeat(4001) }), /过长/)
  assert.throws(() => validateAgentSkillCreation({ projectId: 'project-a', name: '未知能力', instructions: '只读', capabilities: ['browser_delete'] }), /不受支持/)
  assert.deepEqual(validateAgentSkillCreation({ projectId: 'project-a', name: '需要确认', instructions: '写入工作流', capabilities: ['read', 'write', 'read'] }).capabilities, ['read', 'write'])
})

test('Manifest 归一：工具名与依赖版本都校验，重复工具去重', () => {
  const manifest = normalizeAgentSkillManifest({
    toolAllowlist: ['web_search', 'canvas_read', 'web_search'],
    dependencies: [{ skillId: 'base' }, { skillId: 'pinned', version: 2 }],
  })
  assert.equal(manifest.version, botanicAgentSkillManifestVersion)
  assert.deepEqual(manifest.toolAllowlist, ['web_search', 'canvas_read'])
  assert.deepEqual(manifest.dependencies, [{ skillId: 'base' }, { skillId: 'pinned', version: 2 }])
  assert.equal(normalizeAgentSkillManifest(undefined), undefined)
  assert.throws(() => normalizeAgentSkillManifest({ toolAllowlist: ['Bad Name'] }),
    (error) => error.code === 'INVALID_AGENT_SKILL_MANIFEST')
  assert.throws(() => normalizeAgentSkillManifest({ dependencies: [{ skillId: 'x', version: 0 }] }),
    (error) => error.code === 'INVALID_AGENT_SKILL_MANIFEST')
})

test('白名单里查不到的工具按最高风险算', () => {
  // 一个不在注册表里的工具名可能是拼错、也可能是别处的写工具；
  // 两种都不该因为「这里查不到」而被当成只读放行。
  const riskOf = (name) => ({ web_search: 'external', canvas_read: 'read' })[name]
  assert.equal(agentSkillManifestRisk({ toolAllowlist: ['canvas_read'] }, riskOf), 'read')
  assert.equal(agentSkillManifestRisk({ toolAllowlist: ['canvas_read', 'web_search'] }, riskOf), 'external')
  assert.equal(agentSkillManifestRisk({ toolAllowlist: ['who_knows'] }, riskOf), 'external')
  assert.equal(agentSkillManifestRisk({ toolAllowlist: [] }, riskOf), 'read')
})

test('少报能力在发布时就被拒绝', () => {
  // capabilities 此前是一句没人核对的话：声明 read 就能跳过用户确认。
  const riskOf = (name) => ({ generation_submit: 'costly', canvas_read: 'read' })[name]
  assert.throws(
    () => createAgentSkill(
      { projectId: 'p-1', name: '偷懒', instructions: '规则', capabilities: ['read'], manifest: { toolAllowlist: ['generation_submit'] } },
      { ownerId: 'u-1', approvedBy: 'u-1', riskOf },
    ),
    (error) => error.code === 'AGENT_SKILL_CAPABILITY_UNDERSTATED' && error.statusCode === 409,
  )
  // 如实声明就能建。
  const honest = createAgentSkill(
    { projectId: 'p-1', name: '诚实', instructions: '规则', capabilities: ['costly'], manifest: { toolAllowlist: ['generation_submit'] } },
    { ownerId: 'u-1', approvedBy: 'u-1', riskOf },
  )
  assert.deepEqual(honest.manifest.toolAllowlist, ['generation_submit'])
  // 多报能力是允许的：那只会让它更保守。
  assert.doesNotThrow(() => createAgentSkill(
    { projectId: 'p-1', name: '保守', instructions: '规则', capabilities: ['external'], manifest: { toolAllowlist: ['canvas_read'] } },
    { ownerId: 'u-1', approvedBy: 'u-1', riskOf },
  ))
})

test('改版本时同样校验，且 Manifest 随新版本保留', () => {
  const riskOf = (name) => ({ generation_submit: 'costly', canvas_read: 'read' })[name]
  const existing = createAgentSkill(
    { projectId: 'p-1', name: 'S', instructions: '规则', capabilities: ['read'], manifest: { toolAllowlist: ['canvas_read'] } },
    { ownerId: 'u-1', approvedBy: 'u-1', riskOf },
  )
  assert.throws(
    () => updateAgentSkill(existing, { manifest: { toolAllowlist: ['generation_submit'] } }, { actorId: 'u-1', riskOf }),
    (error) => error.code === 'AGENT_SKILL_CAPABILITY_UNDERSTATED',
  )
  const updated = updateAgentSkill(existing, { instructions: '新规则' }, { actorId: 'u-1', approvedBy: 'u-1', riskOf })
  assert.equal(updated.version, 2)
  assert.deepEqual(updated.manifest.toolAllowlist, ['canvas_read'])
})

test('依赖缺失、已弃用、指定版本取不到都被找出来', () => {
  const base = { id: 'base', lifecycle: 'published', versions: [{ version: 1 }, { version: 2 }] }
  const retired = { id: 'retired', lifecycle: 'deprecated', versions: [{ version: 1 }] }
  const skill = { id: 'top', manifest: { dependencies: [{ skillId: 'base', version: 2 }] } }
  assert.deepEqual(resolveAgentSkillDependencies(skill, [base]), { ok: true, missing: [], unusable: [], cyclic: [] })

  // 依赖一个已弃用的 Skill：规则已经不完整了，静默照跑会少半截约束。
  assert.deepEqual(
    resolveAgentSkillDependencies({ id: 'top', manifest: { dependencies: [{ skillId: 'retired' }] } }, [retired]).unusable,
    ['retired'],
  )
  assert.deepEqual(
    resolveAgentSkillDependencies({ id: 'top', manifest: { dependencies: [{ skillId: 'gone' }] } }, [base]).missing,
    ['gone'],
  )
  // 声明了版本却取不到那个版本，等同缺失 —— 按「当前版本」顶替会让规则悄悄变了。
  assert.deepEqual(
    resolveAgentSkillDependencies({ id: 'top', manifest: { dependencies: [{ skillId: 'base', version: 9 }] } }, [base]).missing,
    ['base@9'],
  )
})

test('自依赖与环被挡住，不进无限递归', () => {
  const a = { id: 'a', lifecycle: 'published', manifest: { dependencies: [{ skillId: 'b' }] } }
  const b = { id: 'b', lifecycle: 'published', manifest: { dependencies: [{ skillId: 'a' }] } }
  const result = resolveAgentSkillDependencies(a, [a, b])
  assert.equal(result.ok, false)
  assert.deepEqual(result.cyclic, ['a'])
  assert.deepEqual(
    resolveAgentSkillDependencies({ id: 'self', manifest: { dependencies: [{ skillId: 'self' }] } }, []).cyclic,
    ['self'],
  )
})

test('依赖解析只用 recursion stack 判环，合法 diamond 不误报', () => {
  const shared = { id: 'shared', lifecycle: 'published', version: 1, versions: [{ version: 1 }] }
  const left = {
    id: 'left', lifecycle: 'published', version: 1, versions: [{ version: 1 }],
    manifest: { dependencies: [{ skillId: 'shared' }] },
  }
  const right = {
    id: 'right', lifecycle: 'published', version: 1, versions: [{ version: 1 }],
    manifest: { dependencies: [{ skillId: 'shared' }] },
  }
  const top = { id: 'top', manifest: { dependencies: [{ skillId: 'left' }, { skillId: 'right' }] } }
  assert.deepEqual(
    resolveAgentSkillDependencies(top, [left, right, shared]),
    { ok: true, missing: [], unusable: [], cyclic: [] },
  )
})

test('发布可将依赖冻结到 version + contentHash，存量无 hash 声明仍可读', () => {
  const base = createAgentSkill({
    projectId: 'p-1', name: '基础规则', instructions: '保持品牌色。', capabilities: ['read'],
  }, { id: 'base', ownerId: 'u-1', approvedBy: 'u-1', now: 100 })
  const frozen = freezeAgentSkillDependencies({
    dependencies: [{ skillId: 'base' }, { skillId: 'legacy', version: 3 }],
  }, [base, { id: 'legacy', lifecycle: 'published', version: 3, versions: [{ version: 3 }] }])

  assert.deepEqual(frozen.dependencies, [
    { skillId: 'base', version: 1, contentHash: base.contentHash },
    { skillId: 'legacy', version: 3 },
  ])
  const published = createAgentSkill({
    projectId: 'p-1', name: '组合规则', instructions: '应用基础规则。', capabilities: ['read'],
    manifest: { dependencies: [{ skillId: 'base' }] },
  }, { id: 'top', ownerId: 'u-1', approvedBy: 'u-1', skillCatalog: [base], now: 200 })
  assert.deepEqual(published.manifest.dependencies, [
    { skillId: 'base', version: 1, contentHash: base.contentHash },
  ])
  assert.deepEqual(published.versions[0].manifest.dependencies, published.manifest.dependencies)
  assert.deepEqual(
    resolveAgentSkillDependencies(published, [base]),
    { ok: true, missing: [], unusable: [], cyclic: [] },
  )
})

test('没有 Manifest 的存量 Skill 行为完全不变', () => {
  const legacy = createAgentSkill(
    { projectId: 'p-1', name: '存量', instructions: '规则', capabilities: ['read'] },
    { ownerId: 'u-1', approvedBy: 'u-1' },
  )
  assert.equal('manifest' in legacy, false)
  assert.deepEqual(resolveAgentSkillDependencies(legacy, []), { ok: true, missing: [], unusable: [], cyclic: [] })
})
