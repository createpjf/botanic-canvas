import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nextWorkspaceProjectName,
  reconcileWorkspaceProjects,
  workspaceProjectsFromSummaries,
} from './workspaceProjectCoordinator.model.ts'

test('项目协调器过滤空白草稿并形成稳定的项目卡片摘要', () => {
  const projects = workspaceProjectsFromSummaries([
    { id: 'blank', name: '空白', updatedAt: 1, nodeCount: 0, resultCount: 0 },
    { id: 'built', name: '已搭建', updatedAt: 2, nodeCount: 3, resultCount: 0 },
    { id: 'generated', name: '已生成', updatedAt: 3, nodeCount: 4, resultCount: 2, coverImage: '/cover.webp' },
    { id: 'summer-fragrance-visual-lab', name: '示例', updatedAt: 4, nodeCount: 1, resultCount: 0 },
  ])

  assert.deepEqual(projects, [
    { id: 'built', name: '已搭建', updatedAt: 2, cover: undefined, summary: '已搭建 3 个节点', summaryByLocale: { 'zh-CN': '已搭建 3 个节点', en: '3 nodes on canvas' }, isSeed: false },
    { id: 'generated', name: '已生成', updatedAt: 3, cover: '/cover.webp', summary: '已生成 2 张图 · 4 个节点', summaryByLocale: { 'zh-CN': '已生成 2 张图 · 4 个节点', en: '2 images generated · 4 nodes' }, isSeed: false },
    { id: 'summer-fragrance-visual-lab', name: '示例', updatedAt: 4, cover: undefined, summary: '已搭建 1 个节点', summaryByLocale: { 'zh-CN': '已搭建 1 个节点', en: '1 node on canvas' }, isSeed: true },
  ])
})

test('列表刷新保留本机更新更晚的项目名', () => {
  const reconciled = reconcileWorkspaceProjects(
    [{ id: 'built', name: '夜景方案', updatedAt: 80, summary: '已搭建 3 个节点' }],
    [{ id: 'built', name: '已搭建', updatedAt: 20, summary: '已搭建 3 个节点' }],
  )
  assert.equal(reconciled[0].name, '夜景方案')
  assert.equal(reconciled[0].updatedAt, 80)
})

test('新项目名称只统计本地新建项目，不受示例和外部项目影响', () => {
  assert.equal(nextWorkspaceProjectName([
    { id: 'project-a' },
    { id: 'imported-b' },
    { id: 'project-c' },
  ]), '创意项目 3')
  assert.equal(nextWorkspaceProjectName([{ id: 'project-a' }], 'en'), 'Creative project 2')
})
