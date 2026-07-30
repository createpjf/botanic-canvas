import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProductStore } from './productStore.mjs'
import { createPostgresProductStore } from './postgresProductStore.mjs'
import { createObjectStore } from './objectStore.mjs'
import { createMediaService } from './mediaService.mjs'
import { createSupabaseProductStore } from './supabaseProductStore.mjs'
import { createSupabaseObjectStore } from './supabaseObjectStore.mjs'

export function loadLocalEnv(rootDir = process.cwd()) {
  const envPath = resolve(rootDir, '.env')
  if (!existsSync(envPath)) return
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]]) continue
    process.env[match[1]] = match[2].trim().replace(/^("|')(.*)\1$/, '$2')
  }
}

export function runtimeConfig(rootDir = process.cwd()) {
  const models = [...new Set((process.env.OPENAI_IMAGE_MODELS ?? process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2')
    .split(',').map((model) => model.trim()).filter(Boolean))]
  return {
    rootDir,
    port: Number(process.env.PORT ?? 8787),
    production: process.env.NODE_ENV === 'production',
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    supabase: {
      url: process.env.SUPABASE_URL,
      secretKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'botanic-media',
      inviteRedirectTo: process.env.SUPABASE_INVITE_REDIRECT_TO,
    },
    apiBaseUrl: (process.env.IMAGE_API_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, ''),
    apiKey: process.env.OPENAI_API_KEY,
    models: models.length ? models : ['gpt-image-2'],
    maximumBatchCount: Number(process.env.MAX_GENERATION_BATCH ?? 8),
    maximumReferenceBytes: 8 * 1024 * 1024,
    maximumRequestBytes: 32 * 1024 * 1024,
    workerConcurrency: Number(process.env.GENERATION_WORKER_CONCURRENCY ?? 1),
    bootstrapAccessToken: process.env.BOTANIC_BOOTSTRAP_ACCESS_TOKEN ?? (process.env.NODE_ENV === 'production' ? '' : 'botanic-local-dev'),
    bootstrapEmail: process.env.SUPABASE_BOOTSTRAP_OWNER_EMAIL ?? process.env.BOTANIC_BOOTSTRAP_EMAIL,
    localDataPath: resolve(rootDir, process.env.BOTANIC_DATA_PATH ?? 'server/.data/product.json'),
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    },
  }
}

export async function createProductRuntime(config = runtimeConfig()) {
  const useSupabase = Boolean(config.supabase.url && config.supabase.secretKey)
  if (config.production && !useSupabase) throw new Error('生产环境必须配置 SUPABASE_URL 与 SUPABASE_SECRET_KEY；文件和直连数据库仅用于本地迁移。')
  const productStore = useSupabase
    ? createSupabaseProductStore({
        url: config.supabase.url,
        secretKey: config.supabase.secretKey,
        bootstrapEmail: config.bootstrapEmail,
        inviteRedirectTo: config.supabase.inviteRedirectTo,
      })
    : config.databaseUrl
      ? await createPostgresProductStore({ databaseUrl: config.databaseUrl, bootstrapAccessToken: config.bootstrapAccessToken, bootstrapEmail: config.bootstrapEmail })
      : createProductStore({ dataPath: config.localDataPath, bootstrapAccessToken: config.bootstrapAccessToken, bootstrapEmail: config.bootstrapEmail })

  if (useSupabase) {
    const objectStore = createSupabaseObjectStore({
      url: config.supabase.url,
      secretKey: config.supabase.secretKey,
      bucket: config.supabase.bucket,
    })
    return { config, productStore, mediaService: createMediaService({ productStore, objectStore }), persistence: 'supabase', authProvider: 'supabase' }
  }
  const configuredObjectStore = [config.s3.endpoint, config.s3.bucket, config.s3.accessKeyId, config.s3.secretAccessKey].every(Boolean)
  if (config.production && !configuredObjectStore) throw new Error('生产环境必须配置 S3_ENDPOINT、S3_BUCKET 与对象存储凭据。')
  const objectStore = configuredObjectStore ? await createObjectStore(config.s3) : undefined
  const mediaService = createMediaService({ productStore, objectStore })
  return { config, productStore, mediaService, persistence: config.databaseUrl ? 'postgres' : 'file', authProvider: 'access-token' }
}
