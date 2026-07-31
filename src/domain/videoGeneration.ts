import type { GenerationAspectRatio, GenerationReference, VideoInputMode } from './canvas.ts'

export type AssignedVideoReferences = {
  references: GenerationReference[]
  error?: string
}

export type VideoAspectRatioPolicy = {
  providerRatio: GenerationAspectRatio | 'adaptive'
  controlLabel: GenerationAspectRatio | '跟随素材'
  ratioSelectable: boolean
}

/**
 * H3 的首帧/首尾帧接口会忽略具体比例并跟随输入素材；只有参考素材模式
 * 才能按用户选择的比例生成画面外区域。把这条 Provider 规则显式暴露给 UI，
 * 避免界面显示 4:3、实际却提交 adaptive。
 */
export function videoAspectRatioPolicy(
  mode: VideoInputMode,
  requestedRatio: GenerationAspectRatio,
): VideoAspectRatioPolicy {
  return mode === 'reference'
    ? { providerRatio: requestedRatio, controlLabel: requestedRatio, ratioSelectable: true }
    : { providerRatio: 'adaptive', controlLabel: '跟随素材', ratioSelectable: false }
}

/**
 * 把画布顺序转换为 H3 的输入角色。连接关系仍是唯一输入来源，
 * 此函数只声明同一批输入在视频模型中的语义。
 */
export function assignVideoInputRoles(
  references: GenerationReference[],
  mode: VideoInputMode,
): AssignedVideoReferences {
  if (mode === 'reference') {
    return {
      references: references.map((reference) => ({
        ...reference,
        inputRole: reference.mediaKind === 'video' ? 'reference_video' : 'reference_image',
      })),
    }
  }

  if (references.some((reference) => reference.mediaKind === 'video')) {
    return { references, error: '首帧和尾帧必须使用图片；视频请切换为“参考素材”。' }
  }
  if (mode === 'first_frame') {
    if (references.length !== 1) return { references, error: '首帧模式仅使用一张图片。' }
    return { references: [{ ...references[0], inputRole: 'first_frame' }] }
  }
  if (references.length !== 2) return { references, error: '首尾帧模式需要且仅使用两张图片。' }
  return {
    references: [
      { ...references[0], inputRole: 'first_frame' },
      { ...references[1], inputRole: 'last_frame' },
    ],
  }
}
