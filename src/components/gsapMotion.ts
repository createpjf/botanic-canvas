import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { CustomEase } from 'gsap/CustomEase'
import { Flip } from 'gsap/Flip'
import { MorphSVGPlugin } from 'gsap/MorphSVGPlugin'
import { Observer } from 'gsap/Observer'
import { ScrollToPlugin } from 'gsap/ScrollToPlugin'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'

/**
 * Botanic GSAP 单一入口。八个官方 skill 在这里收口，UI 只调用本模块：
 * - gsap-core：defaults、transform 别名、autoAlpha、matchMedia / reduced-motion
 * - gsap-timeline：多步用 timeline + position，不用 delay 链
 * - gsap-scrolltrigger：滚动触发只挂顶层 tween/timeline，动态内容后 refresh
 * - gsap-plugins：一次 register；Flip / MorphSVG / ScrollTo / Observer / SplitText / CustomEase
 * - gsap-react：一律 useGSAP + scope，回调走 contextSafe
 * - gsap-frameworks：本仓库是 React，对等规则是挂载后创建、卸载 revert、选择器限定根节点
 * - gsap-utils：clamp / mapRange / normalize / snap / pipe / selector
 * - gsap-performance：只动 x/y/scale/autoAlpha；高频用 quickTo；不给工具进度造假动画
 */
gsap.registerPlugin(useGSAP, CustomEase, Flip, MorphSVGPlugin, Observer, ScrollToPlugin, ScrollTrigger, SplitText)

CustomEase.create('botanic', '0.2, 0.82, 0.2, 1')

gsap.defaults({
  duration: 0.24,
  ease: 'botanic',
  overwrite: 'auto',
})

export { gsap, useGSAP, Flip, MorphSVGPlugin, Observer, ScrollTrigger, SplitText }

export const botanicMotion = {
  ease: 'botanic',
  followLatestPx: 96,
  duration: {
    press: 0.12,
    chip: 0.18,
    toast: 0.16,
    panel: 0.28,
    landing: 0.42,
  },
} as const

export type ScrollBlock = 'start' | 'center' | 'end'

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function motionDuration(seconds: number) {
  return prefersReducedMotion() ? 0 : seconds
}

export function captureFlipState(root: Element | null, selector = '[data-agent-flip]') {
  if (!root) return null
  const targets = root.querySelectorAll(selector)
  if (!targets.length) return null
  return Flip.getState(targets)
}

export function playSurfaceFlip(
  previous: ReturnType<typeof Flip.getState> | null,
  incoming: ArrayLike<Element> | null,
) {
  if (!incoming || incoming.length === 0) return
  if (!previous || prefersReducedMotion()) {
    gsap.set(incoming, { autoAlpha: 1, x: 0 })
    return
  }
  Flip.from(previous, {
    targets: incoming,
    duration: botanicMotion.duration.panel,
    ease: botanicMotion.ease,
    simple: true,
    onEnter: (elements) => gsap.fromTo(
      elements,
      { autoAlpha: 0, x: 12 },
      { autoAlpha: 1, x: 0, duration: botanicMotion.duration.chip, ease: botanicMotion.ease },
    ),
  })
}

/** 空画布引导舞台 → 右侧 Agent：同一 data-flip-id 跨节点 Flip。 */
export function playEmptyGuideOpenFlip(
  previous: ReturnType<typeof Flip.getState> | null,
  target: Element | null,
) {
  if (!target) return
  if (!previous || prefersReducedMotion()) {
    gsap.set(target, { clearProps: 'transform' })
    return
  }
  return Flip.from(previous, {
    targets: target,
    absolute: true,
    scale: true,
    duration: botanicMotion.duration.landing,
    ease: botanicMotion.ease,
  })
}

export function remainingScroll(viewport: { scrollHeight: number; scrollTop: number; clientHeight: number }) {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
}

export function isFollowingLatest(
  viewport: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = botanicMotion.followLatestPx,
) {
  return remainingScroll(viewport) < threshold
}

export function readScrollDestination(input: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  scrollerTop: number
  targetTop: number
  targetHeight: number
  block: ScrollBlock
  offsetY?: number
}) {
  const offsetY = input.offsetY ?? 0
  if (input.block === 'end') {
    return Math.max(0, input.scrollHeight - input.clientHeight - offsetY)
  }
  const targetOffset = input.targetTop - input.scrollerTop + input.scrollTop
  if (input.block === 'center') {
    return Math.max(0, targetOffset - input.clientHeight / 2 + input.targetHeight / 2 - offsetY)
  }
  return Math.max(0, targetOffset - offsetY)
}

export function scrollElementIntoView(
  scroller: Element,
  target: Element | 'max',
  options: { duration?: number; block?: ScrollBlock; offsetY?: number } = {},
) {
  const block = options.block ?? (target === 'max' ? 'end' : 'start')
  const scrollerRect = scroller.getBoundingClientRect()
  const targetRect = target === 'max'
    ? { top: scrollerRect.top + scroller.scrollHeight - scroller.scrollTop, height: 0 }
    : target.getBoundingClientRect()
  const y = readScrollDestination({
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    scrollerTop: scrollerRect.top,
    targetTop: targetRect.top,
    targetHeight: targetRect.height,
    block,
    offsetY: options.offsetY,
  })
  return gsap.to(scroller, {
    duration: motionDuration(options.duration ?? botanicMotion.duration.panel),
    ease: botanicMotion.ease,
    overwrite: true,
    scrollTo: { y, autoKill: true },
  })
}

export const clamp01 = gsap.utils.clamp(0, 1)
export const snapPixel = gsap.utils.snap(1)

export function mapPointerShift(progress: number, min: number, max: number) {
  return gsap.utils.mapRange(0, 1, min, max, clamp01(progress))
}

export function normalizePointerAxis(start: number, end: number, value: number) {
  return gsap.utils.normalize(start, end, value)
}

export function composeMotionValue(
  first: (value: number) => number,
  second: (value: number) => number,
) {
  return gsap.utils.pipe(first, second)
}

/** 发送箭头与停止方块都是单段填充 path，供 MorphSVG 在同一按钮内变形。 */
export const sendArrowPath = 'M12 3.6 18.2 9.9l-1.35 1.3-3.6-3.7V20.4h-2.5V7.5L7.15 11.2 5.8 9.9 12 3.6z'
export const sendStopPath = 'M7.2 7.2h9.6v9.6H7.2z'
