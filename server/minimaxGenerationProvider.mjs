import { GenerationError } from './generationProvider.mjs'

function dataUrl(media) {
  return `data:${media.mimeType};base64,${media.buffer.toString('base64')}`
}

function miniMaxError(response, body, mediaLabel) {
  if (response.status === 401 || response.status === 403) {
    return new GenerationError(502, 'PROVIDER_AUTH_FAILED', `MiniMax ${mediaLabel}服务鉴权失败，请检查 MINIMAX_API_KEY。`)
  }
  if (response.status === 429) {
    return new GenerationError(429, 'PROVIDER_RATE_LIMITED', `MiniMax ${mediaLabel}服务当前限流，请稍后重试。`)
  }
  if (response.status >= 500) {
    return new GenerationError(502, 'PROVIDER_UNAVAILABLE', `MiniMax ${mediaLabel}服务暂时不可用，请稍后重试。`)
  }
  const detail = typeof body?.error?.message === 'string'
    ? body.error.message.slice(0, 180)
    : typeof body?.base_resp?.status_msg === 'string'
      ? body.base_resp.status_msg.slice(0, 180)
      : '请检查提示词、参考素材与输出参数。'
  return new GenerationError(422, 'PROVIDER_REJECTED', `MiniMax ${mediaLabel}服务拒绝了本次任务：${detail}`)
}

function imageMedia(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax 图像服务没有返回可用的图片数据。')
  }
  const bytes = Buffer.from(value.replace(/\s/g, ''), 'base64')
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  const mimeType = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : undefined
  if (!mimeType) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax 图像服务返回的文件格式无法显示。')
  }
  return { mediaKind: 'image', mimeType, buffer: bytes }
}

function miniMaxImagePrompt(job) {
  const roles = job.references.map((reference) => `${reference.role}：${reference.name}`).join('；')
  return [
    job.prompt,
    roles ? `画布参考语义：${roles}。` : '',
    job.references.find((reference) => reference.primary) ? '保持主参考主体的关键外观与识别特征。' : '',
    '不要添加未被要求的品牌标识、价格、二维码或水印。',
  ].filter(Boolean).join('\n').slice(0, 1500)
}

/**
 * MiniMax Image Adapter。官方参考图接口只支持单个 character 主体，
 * 因而按 Botanic 配方优先选择模特，其次选择主参考；其余参考仍写入提示词语义。
 */
export async function generateMiniMaxImages(job, {
  apiBaseUrl,
  apiKey,
  signal,
  persistMedia,
  jobId,
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', 'MiniMax 图像服务尚未配置：请设置 MINIMAX_API_KEY。')
  const subject = job.references.find((reference) => reference.role === '模特')
    ?? job.references.find((reference) => reference.primary)
    ?? job.parent
  const payload = {
    model: job.settings.model,
    prompt: miniMaxImagePrompt(job),
    aspect_ratio: job.settings.aspectRatio,
    response_format: 'base64',
    n: job.batchCount,
    prompt_optimizer: true,
    ...(subject ? {
      subject_reference: [{
        type: 'character',
        image_file: dataUrl(subject),
      }],
    } : {}),
  }
  const response = await fetchImpl(`${apiBaseUrl}/v1/image_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.base_resp?.status_code > 0) throw miniMaxError(response, body, '图像')
  const images = Array.isArray(body?.data?.image_base64) ? body.data.image_base64 : []
  const persisted = await Promise.allSettled(images.map(async (value, index) => ({
    id: `${jobId}-output-${index + 1}`,
    image: await persistMedia(imageMedia(value)),
    mediaKind: 'image',
  })))
  const outputs = persisted.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!outputs.length) {
    const failure = persisted.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', 'MiniMax 图像服务没有返回候选图，请重试。')
  }
  const missingOutputCount = Math.max(0, job.batchCount - outputs.length)
  return {
    outputs,
    missingOutputCount,
    partialError: missingOutputCount
      ? `MiniMax 图像服务仅返回 ${outputs.length}/${job.batchCount} 张候选，可补生成缺少的 ${missingOutputCount} 张。`
      : undefined,
  }
}

function videoContent(job) {
  const references = job.parent
    ? [job.parent, ...job.references.filter((reference) => !reference.buffer.equals(job.parent.buffer))]
    : job.references
  const content = [{ type: 'text', text: job.prompt }]
  if (references.length === 1) {
    content.push({ type: 'image_url', image_url: { url: dataUrl(references[0]) }, role: 'first_frame' })
    return { content, ratio: 'adaptive' }
  }
  for (const reference of references.slice(0, 9)) {
    content.push({ type: 'image_url', image_url: { url: dataUrl(reference) }, role: 'reference_image' })
  }
  return { content, ratio: references.length ? job.settings.aspectRatio : job.settings.aspectRatio }
}

async function requestJson(url, init, { fetchImpl, mediaLabel }) {
  const response = await fetchImpl(url, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw miniMaxError(response, body, mediaLabel)
  return body
}

async function downloadVideo(url, { fetchImpl, signal }) {
  const response = await fetchImpl(url, { signal })
  if (!response.ok) throw miniMaxError(response, null, '视频')
  const upstreamMimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const mimeType = upstreamMimeType === 'video/mp4' || /\.mp4(?:$|[?#])/i.test(url) ? 'video/mp4' : upstreamMimeType
  if (mimeType !== 'video/mp4') {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax H3 返回的视频格式无法显示。')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax H3 返回了空视频。')
  return { mediaKind: 'video', mimeType, buffer }
}

async function generateOneMiniMaxVideo(job, options, variationIndex) {
  const { content, ratio } = videoContent(job)
  const prompt = variationIndex === 0
    ? job.prompt
    : `${job.prompt}\n同批候选 ${variationIndex + 1}：保持主体一致，形成可见的镜头或动作差异。`
  content[0] = { type: 'text', text: prompt }
  const submitted = await requestJson(`${options.apiBaseUrl}/v2/video_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: job.settings.model,
      content,
      resolution: '2K',
      duration: job.settings.duration ?? 5,
      ratio,
    }),
    signal: options.signal,
  }, { fetchImpl: options.fetchImpl, mediaLabel: '视频' })
  if (typeof submitted?.task_id !== 'string' || !submitted.task_id) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax H3 没有返回任务标识。')
  }

  while (!options.signal?.aborted) {
    await options.sleep(options.pollIntervalMs)
    const queried = await requestJson(
      `${options.apiBaseUrl}/v2/query/video_generation/${encodeURIComponent(submitted.task_id)}`,
      { headers: { Authorization: `Bearer ${options.apiKey}` }, signal: options.signal },
      { fetchImpl: options.fetchImpl, mediaLabel: '视频' },
    )
    const status = queried?.task?.status
    if (status === 'succeeded') {
      const url = queried?.task?.content?.url
      if (typeof url !== 'string' || !url) {
        throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax H3 任务成功但没有返回视频地址。')
      }
      return downloadVideo(url, options)
    }
    if (status === 'failed' || status === 'expired') {
      throw new GenerationError(422, 'PROVIDER_REJECTED', `MiniMax H3 任务${status === 'expired' ? '已过期' : '生成失败'}，请调整描述后重试。`)
    }
    if (status !== 'queued' && status !== 'running') {
      throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax H3 返回了未知任务状态。')
    }
  }
  throw new GenerationError(504, 'PROVIDER_TIMEOUT', 'MiniMax H3 视频生成已停止。')
}

/** MiniMax H3 Adapter：为每个候选创建独立异步任务，完成后立即持久化 MP4。 */
export async function generateMiniMaxVideos(job, {
  apiBaseUrl,
  apiKey,
  signal,
  persistMedia,
  jobId,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 10_000,
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', 'MiniMax H3 尚未配置：请设置 MINIMAX_API_KEY。')
  const options = { apiBaseUrl, apiKey, signal, persistMedia, jobId, fetchImpl, sleep, pollIntervalMs }
  const settled = []
  for (let index = 0; index < job.batchCount; index += 1) {
    try {
      const media = await generateOneMiniMaxVideo(job, options, index)
      settled.push({
        id: `${jobId}-output-${index + 1}`,
        image: await persistMedia(media),
        mediaKind: 'video',
      })
    } catch (caught) {
      if (!settled.length) throw caught
      break
    }
  }
  const missingOutputCount = Math.max(0, job.batchCount - settled.length)
  return {
    outputs: settled,
    missingOutputCount,
    partialError: missingOutputCount
      ? `MiniMax H3 仅返回 ${settled.length}/${job.batchCount} 个视频，可补生成缺少的 ${missingOutputCount} 个。`
      : undefined,
  }
}
