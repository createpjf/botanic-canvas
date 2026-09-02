import { readMediaSpec } from '../media/mediaSpec.mjs'
import { mapWithConcurrency } from '../concurrency.mjs'
import { compositionBrandGuard, creativeExecutionContract } from '../generation/generationComposition.mjs'
import { GenerationError, providerRejectionError } from '../generation/generationProvider.mjs'
import { detectImageFormat, isCanonicalImageFormat } from '../media/mediaFormats.mjs'

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
  // 拒绝原因走 generationProvider 的 providerRejectionError：供应商英文原文
  // 不进用户可见消息，只挂在 upstreamMessage 给日志/运维——这是本分支的
  // 不变式，OpenAI 与 MiniMax 两个适配器必须共用同一处实现，而不是各转述一份。
  const upstreamMessage = typeof body?.error?.message === 'string'
    ? body.error.message
    : typeof body?.base_resp?.status_msg === 'string'
      ? body.base_resp.status_msg
      : undefined
  const requestId = response.headers.get('x-request-id')
  return providerRejectionError(upstreamMessage, requestId, `MiniMax ${mediaLabel}`)
}

function imageMedia(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax 图像服务没有返回可用的图片数据。')
  }
  const bytes = Buffer.from(value.replace(/\s/g, ''), 'base64')
  // 字节嗅探统一走权威词表：这里曾经是第五份手写 png/jpeg/webp 签名判断，
  // 与 mediaFormats.mjs 的实现重复且不会跟着词表一起演进。
  const mimeType = detectImageFormat(bytes)
  if (!mimeType || !isCanonicalImageFormat(mimeType)) {
    throw new GenerationError(502, 'INVALID_PROVIDER_RESPONSE', 'MiniMax 图像服务返回的文件格式无法显示。')
  }
  return { mediaKind: 'image', mimeType, buffer: bytes }
}

function miniMaxImagePrompt(job) {
  const roles = job.references.map((reference) => `${reference.role}：${reference.name}`).join('；')
  return [
    job.prompt,
    ...creativeExecutionContract(job),
    roles ? `画布参考语义：${roles}。` : '',
    job.references.find((reference) => reference.primary) ? '保持主参考主体的关键外观与识别特征。' : '',
    compositionBrandGuard(job.references),
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
  onVariant,
  completedVariants = [],
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', 'MiniMax 图像服务尚未配置：请设置 MINIMAX_API_KEY。')
  const previousOutputs = new Map(
    completedVariants
      .filter((variant) => variant?.status === 'succeeded' && variant.output)
      .map((variant) => [Number(variant.index), variant.output]),
  )
  const pendingIndexes = Array.from({ length: job.batchCount }, (_, index) => index)
    .filter((index) => !previousOutputs.has(index))
  if (!pendingIndexes.length) {
    return {
      outputs: [...previousOutputs.entries()].sort(([left], [right]) => left - right).map(([, output]) => output),
      missingOutputCount: 0,
    }
  }
  await Promise.all(pendingIndexes.map((index) => onVariant?.({ index, status: 'running' })))
  const subject = job.references.find((reference) => reference.role === '模特')
    ?? job.references.find((reference) => reference.primary)
    ?? job.parent
  const payload = {
    model: job.settings.model,
    prompt: miniMaxImagePrompt(job),
    aspect_ratio: job.settings.aspectRatio,
    response_format: 'base64',
    // 已成功的候选不会重复计费；服务端会把新返回值按 pendingIndexes 映射回子任务。
    n: pendingIndexes.length,
    prompt_optimizer: true,
    ...(subject ? {
      subject_reference: [{
        type: 'character',
        image_file: dataUrl(subject),
      }],
    } : {}),
  }
  try {
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
    const persisted = await Promise.allSettled(images.slice(0, pendingIndexes.length).map(async (value, resultIndex) => {
      const media = imageMedia(value)
      return {
        index: pendingIndexes[resultIndex],
        output: {
          id: `${jobId}-output-${pendingIndexes[resultIndex] + 1}`,
          image: await persistMedia(media),
          mediaKind: 'image',
          // 实测规格随输出落库，供评审第 1 层确定性验证（ADR 0006）。
          spec: readMediaSpec(media.buffer, media.mimeType),
        },
      }
    }))
    const outputs = new Map(previousOutputs)
    for (const result of persisted) {
      if (result.status === 'fulfilled') {
        outputs.set(result.value.index, result.value.output)
        await onVariant?.({ index: result.value.index, status: 'succeeded', output: result.value.output })
      }
    }
    const failed = persisted.filter((result) => result.status === 'rejected')
    for (const index of pendingIndexes.slice(0, images.length)) {
      if (!outputs.has(index)) {
        const failure = failed.find((result) => result.status === 'rejected')
        await onVariant?.({ index, status: 'failed', error: failure?.reason instanceof Error ? failure.reason.message : '候选图片保存失败。' })
      }
    }
    for (const index of pendingIndexes.slice(images.length)) {
      await onVariant?.({ index, status: 'failed', error: 'MiniMax 图像服务没有返回该候选图。' })
    }
    const orderedOutputs = [...outputs.entries()].sort(([left], [right]) => left - right).map(([, output]) => output)
    if (!orderedOutputs.length) {
      const failure = failed.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', 'MiniMax 图像服务没有返回候选图，请重试。')
    }
    const missingOutputCount = Math.max(0, job.batchCount - orderedOutputs.length)
    return {
      outputs: orderedOutputs,
      missingOutputCount,
      partialError: missingOutputCount
        ? `MiniMax 图像服务仅返回 ${orderedOutputs.length}/${job.batchCount} 张候选，可补生成缺少的 ${missingOutputCount} 张。`
        : undefined,
    }
  } catch (error) {
    await Promise.all(pendingIndexes.map((index) => onVariant?.({
      index,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })))
    throw error
  }
}

function videoContent(job) {
  const references = job.parent
    ? [job.parent, ...job.references.filter((reference) => !reference.buffer.equals(job.parent.buffer))]
    : job.references
  const content = [{ type: 'text', text: job.prompt }]
  const hasExplicitRoles = references.some((reference) => reference.inputRole)
  if (!hasExplicitRoles && references.length === 1) {
    content.push({ type: 'image_url', image_url: { url: dataUrl(references[0]) }, role: 'first_frame' })
    return { content, ratio: 'adaptive' }
  }
  for (const reference of references.slice(0, 9)) {
    const mediaKind = reference.mediaKind ?? (reference.mimeType === 'video/mp4' ? 'video' : 'image')
    const role = reference.inputRole ?? (mediaKind === 'video' ? 'reference_video' : 'reference_image')
    if (mediaKind === 'video') {
      content.push({ type: 'video_url', video_url: { url: dataUrl(reference) }, role })
    } else {
      content.push({ type: 'image_url', image_url: { url: dataUrl(reference) }, role })
    }
  }
  const frameMode = references.some((reference) => reference.inputRole === 'first_frame' || reference.inputRole === 'last_frame')
  return { content, ratio: frameMode ? 'adaptive' : job.settings.aspectRatio }
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
  variantConcurrency = 3,
  onVariant,
  completedVariants = [],
}) {
  if (!apiKey) throw new GenerationError(503, 'PROVIDER_NOT_CONFIGURED', 'MiniMax H3 尚未配置：请设置 MINIMAX_API_KEY。')
  const options = { apiBaseUrl, apiKey, signal, persistMedia, jobId, fetchImpl, sleep, pollIntervalMs }
  const previousOutputs = new Map(
    completedVariants
      .filter((variant) => variant?.status === 'succeeded' && variant.output)
      .map((variant) => [Number(variant.index), variant.output]),
  )
  const pendingIndexes = Array.from({ length: job.batchCount }, (_, index) => index)
    .filter((index) => !previousOutputs.has(index))
  const settled = await mapWithConcurrency(pendingIndexes, variantConcurrency, async (index) => {
    await onVariant?.({ index, status: 'running' })
    try {
      const media = await generateOneMiniMaxVideo(job, options, index)
      const output = {
        id: `${jobId}-output-${index + 1}`,
        image: await persistMedia(media),
        mediaKind: 'video',
        // 视频的时长与容器同样属于评审第 1 层，不因「是视频」就跳过。
        spec: readMediaSpec(media.buffer, media.mimeType),
      }
      await onVariant?.({ index, status: 'succeeded', output })
      return { status: 'fulfilled', value: { index, output } }
    } catch (caught) {
      await onVariant?.({ index, status: 'failed', error: caught instanceof Error ? caught.message : String(caught) })
      return { status: 'rejected', reason: caught }
    }
  })
  const outputs = new Map(previousOutputs)
  settled.forEach((result) => {
    if (result.status === 'fulfilled') outputs.set(result.value.index, result.value.output)
  })
  const orderedOutputs = [...outputs.entries()].sort(([left], [right]) => left - right).map(([, output]) => output)
  const failures = settled.filter((result) => result.status === 'rejected')
  if (!orderedOutputs.length) {
    const firstFailure = failures[0]
    if (firstFailure?.status === 'rejected') throw firstFailure.reason
    throw new GenerationError(502, 'EMPTY_PROVIDER_RESPONSE', 'MiniMax H3 没有返回候选视频，请重试。')
  }
  const missingOutputCount = Math.max(0, job.batchCount - orderedOutputs.length)
  return {
    outputs: orderedOutputs,
    missingOutputCount,
    partialError: missingOutputCount
      ? `MiniMax H3 仅返回 ${orderedOutputs.length}/${job.batchCount} 个视频，可补生成缺少的 ${missingOutputCount} 个。`
      : undefined,
  }
}
