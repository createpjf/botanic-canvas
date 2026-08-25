import { BrandKitError, findBrandKit, globalBrandKitLibraryId, normalizeBrandKitLibrary, resolveBrandKit } from './brandKit.mjs'
import { requireProjectPermission } from './projectAuthorization.mjs'

export function createLibraryRouteHandler({ productStore, json, error, readJson, requireUser }) {
  return async function handleLibraryRoute(request, response, url, routeMatches) {
    const { globalAsset: assetMatch, projectBrandKit: projectBrandKitMatch } = routeMatches
    if (projectBrandKitMatch) {
      if (request.method !== 'GET') {
        return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '项目品牌规则只支持读取。' } }, { Allow: 'GET' })
      }
      const user = await requireUser(request)
      const projectId = decodeURIComponent(projectBrandKitMatch[1])
      await requireProjectPermission(productStore, user.id, projectId, 'read')
      const project = await productStore.readProject(user.id, projectId)
      if (!project) return error(response, 404, 'PROJECT_NOT_FOUND', '未找到项目或你没有访问权限。')
      const brandId = project.document?.brandId
      // 未绑定品牌就明说没有，不返回一份空套件充数 —— 空套件在界面上看起来像
      // 「品牌规则都通过了」，而实际是根本没有品牌规则参与。
      if (typeof brandId !== 'string' || !brandId.trim()) return json(response, 200, { brandKit: null })
      const library = await productStore.readGlobalAssetLibrary(user.id, globalBrandKitLibraryId)
      try {
        // 解析口径与生成时**同一实现**：界面说生效的那条，就是生成时会用的那条。
        return json(response, 200, {
          brandKit: resolveBrandKit({
            brandId: brandId.trim(),
            global: findBrandKit(library, brandId),
            project: project.document?.brandKit,
          }),
        })
      } catch (caught) {
        const code = caught instanceof BrandKitError ? caught.code : 'BRAND_KIT_UNRESOLVABLE'
        const status = caught instanceof BrandKitError ? caught.statusCode : 409
        return error(response, status, code, caught instanceof Error ? caught.message : '品牌规则无法解析。')
      }
    }
    if (url.pathname === '/api/brand-kits') {
      if (request.method === 'GET') {
        const user = await requireUser(request)
        return json(response, 200, { library: await productStore.readGlobalAssetLibrary(user.id, globalBrandKitLibraryId) })
      }
      if (request.method === 'PUT') {
        const user = await requireUser(request)
        const body = await readJson(request)
        if (!body?.library || body.library.id !== globalBrandKitLibraryId) {
          return error(response, 400, 'INVALID_BRAND_KIT_LIBRARY', '品牌套件库格式无效。')
        }
        let library
        try {
          // 服务端校验，不采信客户端提交的形状：这条路径决定生成时套哪套品牌规则。
          library = normalizeBrandKitLibrary(body.library)
        } catch (caught) {
          const code = caught instanceof BrandKitError ? caught.code : 'INVALID_BRAND_KIT_LIBRARY'
          const status = caught instanceof BrandKitError ? caught.statusCode : 400
          return error(response, status, code, caught instanceof Error ? caught.message : '品牌套件库格式无效。')
        }
        try {
          return json(response, 200, { library: await productStore.writeGlobalAssetLibrary(user.id, library) })
        } catch (caught) {
          return error(response, 403, 'BRAND_KIT_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑品牌套件库的权限。')
        }
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '品牌套件库不支持该请求方法。' } }, { Allow: 'GET, PUT' })
    }
    if (url.pathname === '/api/global-assets') {
      if (request.method === 'GET') {
        const user = await requireUser(request)
        return json(response, 200, { library: await productStore.readGlobalAssetLibrary(user.id, 'global-brand-assets') })
      }
      if (request.method === 'PUT') {
        const user = await requireUser(request)
        const body = await readJson(request)
        if (!body?.library || body.library.id !== 'global-brand-assets') return error(response, 400, 'INVALID_LIBRARY', '品牌素材库格式无效。')
        try {
          return json(response, 200, { library: await productStore.writeGlobalAssetLibrary(user.id, body.library) })
        } catch (caught) {
          return error(response, 403, 'LIBRARY_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑品牌素材库的权限。')
        }
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '品牌素材库不支持该请求方法。' } }, { Allow: 'GET, PUT' })
    }
    if (url.pathname === '/api/workflow-templates') {
      if (request.method === 'GET') {
        const user = await requireUser(request)
        return json(response, 200, { library: await productStore.readGlobalAssetLibrary(user.id, 'global-workflow-templates') })
      }
      if (request.method === 'PUT') {
        const user = await requireUser(request)
        const body = await readJson(request)
        if (!body?.library || body.library.id !== 'global-workflow-templates' || !Array.isArray(body.library.templates)) return error(response, 400, 'INVALID_WORKFLOW_TEMPLATE_LIBRARY', '工作流模板库格式无效。')
        try {
          return json(response, 200, { library: await productStore.writeGlobalAssetLibrary(user.id, body.library) })
        } catch (caught) {
          return error(response, 403, 'WORKFLOW_TEMPLATE_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑共享工作流模板库的权限。')
        }
      }
      return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '工作流模板库不支持该请求方法。' } }, { Allow: 'GET, PUT' })
    }
    if (assetMatch) {
      if (request.method !== 'DELETE') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '品牌素材资源只接受删除请求。' } }, { Allow: 'DELETE' })
      const user = await requireUser(request)
      try {
        return json(response, 200, await productStore.deleteGlobalAsset(user.id, decodeURIComponent(assetMatch[1])))
      } catch (caught) {
        return error(response, 403, 'LIBRARY_WRITE_FORBIDDEN', caught instanceof Error ? caught.message : '没有编辑品牌素材库的权限。')
      }
    }
    return false
  }
}
