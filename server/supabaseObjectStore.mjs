import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function extension(contentType) {
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'video/mp4') return 'mp4'
  return 'png'
}

export async function downloadSupabaseObject(fileApi, storageKey, { signal } = {}) {
  const { data, error } = await fileApi.download(
    storageKey,
    {},
    signal ? { signal } : {},
  )
  if (signal?.aborted) throw signal.reason ?? new Error('Supabase Storage 下载已取消。')
  if (error || !data) throw new Error(error?.message ?? 'Supabase Storage 未返回媒体文件。')
  const body = Buffer.from(await data.arrayBuffer())
  if (signal?.aborted) throw signal.reason ?? new Error('Supabase Storage 下载已取消。')
  return { body, contentType: data.type }
}

/** Supabase Storage Adapter。Bucket 保持 private，读取必须经过 API 或 Storage RLS。 */
export function createSupabaseObjectStore({ url, secretKey, bucket = 'botanic-media' }) {
  if (!url || !secretKey) throw new Error('SUPABASE_URL 与 SUPABASE_SECRET_KEY 未配置。')
  const supabase = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  async function putMedia({ projectId, bytes, contentType }) {
      const id = `media_${randomUUID()}`
      const storageKey = `projects/${projectId}/media/${id}.${extension(contentType)}`
      const { error } = await supabase.storage.from(bucket).upload(storageKey, bytes, { contentType, upsert: false })
      if (error) throw new Error(error.message)
      return { id, storageKey, contentType, byteSize: bytes.byteLength }
  }
  return {
    putMedia,
    putImage: putMedia,
    async get(storageKey, { signal } = {}) {
      return downloadSupabaseObject(supabase.storage.from(bucket), storageKey, { signal })
    },
    async createSignedUrl(storageKey, expiresIn) {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storageKey, expiresIn)
      if (error || !data?.signedUrl) throw new Error(error?.message ?? 'Supabase Storage 未返回签名媒体地址。')
      return data.signedUrl
    },
    async close() {},
  }
}
