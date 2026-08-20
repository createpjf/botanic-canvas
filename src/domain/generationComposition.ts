import type { GenerationRecipe } from './canvas'

/**
 * 局部重绘的父图通过 generation job 的 parent 单独传输；原配方里只有非主参考
 * 需要继续作为构图/品牌叠加参考，避免把父图的主参考再次作为普通输入。
 */
export function withRegionEditOverlayReferences(recipe: GenerationRecipe, parentRecipe?: GenerationRecipe): GenerationRecipe {
  const existing = new Set(recipe.references.map((reference) => reference.nodeId))
  const overlays = (parentRecipe?.references ?? [])
    .filter((reference) => !reference.primary && !existing.has(reference.nodeId))
    .map((reference) => ({ ...reference }))
  return overlays.length
    ? { ...recipe, references: [...recipe.references.map((reference) => ({ ...reference })), ...overlays] }
    : { ...recipe, references: recipe.references.map((reference) => ({ ...reference })) }
}
