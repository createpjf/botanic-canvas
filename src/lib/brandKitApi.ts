import { productRequest } from './productSession'
import type { ProjectBrandKit } from '../domain/canvas'
import type { ResolvedBrandKit } from '../domain/brandKitPresentation'

/**
 * 全局品牌套件库的读写（Epic 9.1）。
 *
 * 服务端会用 `normalizeBrandKit` 重新校验整份内容并拒绝把手册解析结果直接激活，
 * 因此这里**不做**规则合法性判断 —— 客户端再校验一遍只会产生第二套判定口径，
 * 而两套口径不一致时表现为「界面说能存，存完规则不见了」。
 */

export const globalBrandKitLibraryId = 'global-brand-kits'

export type BrandKitLibrary = {
  id: typeof globalBrandKitLibraryId
  schemaVersion: 1
  kits: ProjectBrandKit[]
  updatedAt: number
}

/**
 * 项目当前生效的品牌规则。
 *
 * 解析由服务端完成（与生成时同一实现），因此界面显示生效的那条，就是生成时会用的
 * 那条。返回 `null` 表示项目未绑定品牌 —— 与「绑定了但一条规则都没有」是两回事，
 * 界面必须区分，否则「没有品牌规则」看起来像「品牌规则都满足了」。
 */
export async function fetchProjectBrandKit(projectId: string): Promise<ResolvedBrandKit | null> {
  const response = await productRequest<{ brandKit: ResolvedBrandKit | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/brand-kit`,
  )
  return response?.brandKit ?? null
}

export async function fetchBrandKitLibrary(): Promise<BrandKitLibrary | undefined> {
  const response = await productRequest<{ library?: BrandKitLibrary }>('/api/brand-kits')
  return response?.library
}

export async function saveBrandKitLibrary(library: BrandKitLibrary): Promise<BrandKitLibrary> {
  const response = await productRequest<{ library: BrandKitLibrary }>('/api/brand-kits', {
    method: 'PUT',
    body: JSON.stringify({ library }),
  })
  return response.library
}

export type { ResolvedBrandKit }
