import { randomUUID } from 'node:crypto'
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

function required(value, name) {
  if (!value) throw new Error(`${name} 未配置，无法启动生产对象存储。`)
  return value
}

function extension(contentType) {
  if (contentType === 'image/jpeg') return 'jpg'
  if (contentType === 'image/webp') return 'webp'
  return 'png'
}

/** S3 协议对象存储 Adapter；MinIO、AWS S3、R2 均可接入。 */
export async function createObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = true }) {
  const client = new S3Client({
    endpoint: required(endpoint, 'S3_ENDPOINT'),
    region: region || 'us-east-1',
    forcePathStyle,
    credentials: { accessKeyId: required(accessKeyId, 'S3_ACCESS_KEY_ID'), secretAccessKey: required(secretAccessKey, 'S3_SECRET_ACCESS_KEY') },
  })
  const bucketName = required(bucket, 'S3_BUCKET')
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }))
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucketName }))
    } catch (caught) {
      // API 与 Worker 可并行冷启动；另一实例已经建桶时视为成功。
      if (!['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'].includes(caught?.name)) throw caught
    }
  }

  return {
    async putImage({ projectId, bytes, contentType }) {
      const id = `media_${randomUUID()}`
      const storageKey = `projects/${projectId}/media/${id}.${extension(contentType)}`
      await client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: storageKey,
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'private, max-age=31536000, immutable',
      }))
      return { id, storageKey, contentType, byteSize: bytes.byteLength }
    },

    async get(storageKey, { signal } = {}) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: storageKey }), { abortSignal: signal })
      if (!response.Body) throw new Error('对象存储未返回媒体文件。')
      return { body: response.Body, contentType: response.ContentType }
    },

    async close() {
      client.destroy()
    },
  }
}
