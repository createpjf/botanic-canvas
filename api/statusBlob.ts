import { get, put } from '@vercel/blob'
import type { StatusSampleFile } from '../src/domain/statusPage.ts'
import type { StatusBlobRead } from '../src/lib/statusPageRuntime.ts'

export const STATUS_SAMPLES_BLOB = 'status-samples.json'

function isMissingBlob(error: unknown) {
  if (!error || typeof error !== 'object') return false
  return ('name' in error && error.name === 'BlobNotFoundError')
    || ('status' in error && error.status === 404)
}

export async function readStatusSamples(): Promise<StatusBlobRead> {
  try {
    const result = await get(STATUS_SAMPLES_BLOB, { access: 'private', useCache: false })
    if (!result?.stream) return { ok: false, missing: true }
    return { ok: true, value: JSON.parse(await new Response(result.stream).text()) }
  } catch (error) {
    return { ok: false, missing: isMissingBlob(error) }
  }
}

export async function writeStatusSamples(file: StatusSampleFile) {
  await put(STATUS_SAMPLES_BLOB, JSON.stringify(file), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  })
}
