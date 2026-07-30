import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function extension(contentType) {
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/webp') return 'webp'
  return 'png'
}

/** Supabase Storage Adapter。Bucket 保持 private，读取必须经过 API 或 Storage RLS。 */
export function createSupabaseObjectStore({ url, secretKey, bucket = 'botanic-media' }) {
  if (!url || !secretKey) throw new Error('SUPABASE_URL 与 SUPABASE_SECRET_KEY 未配置。')
  const supabase = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  return {
    async putImage({ projectId, bytes, contentType }) {
      const id = `media_${randomUUID()}`
      const storageKey = `projects/${projectId}/media/${id}.${extension(contentType)}`
      const { error } = await supabase.storage.from(bucket).upload(storageKey, bytes, { contentType, upsert: false })
      if (error) throw new Error(error.message)
      return { id, storageKey, contentType, byteSize: bytes.byteLength }
    },
    async get(storageKey) {
      const { data, error } = await supabase.storage.from(bucket).download(storageKey)
      if (error || !data) throw new Error(error?.message ?? 'Supabase Storage 未返回媒体文件。')
      return { body: Buffer.from(await data.arrayBuffer()), contentType: data.type }
    },
    async close() {},
  }
}
