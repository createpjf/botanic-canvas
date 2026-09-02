import { createHash } from 'node:crypto'

function inputMediaProvenance(reference, index) {
  return {
    order: index,
    ...(reference.nodeId ? { nodeId: reference.nodeId } : {}),
    ...(reference.assetId ? { assetId: reference.assetId } : {}),
    name: reference.name,
    role: reference.role,
    primary: reference.primary === true,
    priority: reference.priority,
    mediaKind: reference.mediaKind ?? 'image',
    ...(reference.inputRole ? { inputRole: reference.inputRole } : {}),
    ...(reference.mediaId ? { mediaId: reference.mediaId } : {}),
    ...(reference.buffer?.length
      ? { mediaSha256: createHash('sha256').update(reference.buffer).digest('hex') }
      : {}),
  }
}

export function generationInputProvenance(input, targetBinding) {
  return {
    references: input.references.map(inputMediaProvenance),
    ...(input.parent ? {
      parent: {
        ...inputMediaProvenance({ ...input.parent, role: '父版本', primary: true, priority: 0 }, 0),
        ...(targetBinding?.artifactId ? { artifactId: targetBinding.artifactId } : {}),
      },
    } : {}),
  }
}
