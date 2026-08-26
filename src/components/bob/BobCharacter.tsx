import { useEffect, useId, useRef } from 'react'
import { prefersReducedMotion } from '../gsapMotion'
import {
  bodyPaint,
  computeFrame,
  contentExtent,
  createAvatar,
  EYE_STYLE_BY_ID,
  MOTION_BY_ID,
  play,
  svgFrame,
  topperById,
  type BobRuntimeEye,
  type BobRuntimePaint,
} from './character-runtime.js'

const BOB_SPEC = {
  id: 'bob',
  name: 'Bob',
  shape: 'blob',
  body: '#2d633b',
  eye: '#fafcf9',
  er: 84,
  eyes: { w: 17, h: 38, sp: 28, py: -4, aL: 0, aR: 0 },
}

const BOB_CONFIG = {
  characterId: 'bob',
  eyeStyleId: 'plain',
  motionId: 'idle',
  topperId: 'none',
  size: 1,
  stretchX: 1,
  stretchY: 1,
  depth: 1,
  perspective: 1,
  turn: 0,
  tilt: 0,
  lean: 0,
  bodyColor: '#2d633b',
  surfaceId: 'solid',
  lightColor: '#ffffff',
  shadowColor: '#000000',
  shine: 0.2,
  shadow: 0.06,
  lightX: -0.76,
  lightY: 0.8,
  lightSpread: 1,
  gloss: 0,
  rim: 0,
  rimColor: '#ffffff',
  eyeColor: '#fafcf9',
  irisColor: '#6f9c77',
  pupilColor: '#0B0D10',
  glintColor: '#FFFFFF',
  eyeWidth: 0.88,
  eyeHeight: 1,
  eyeSpacing: 1,
  eyeRaise: 4,
  eyeAngle: -1,
  irisSize: 1,
  pupilSize: 1,
  glintSize: 1,
  eyeMorph: true,
  speed: 1,
  motionAmount: 1,
  blink: true,
  blinkRate: 1,
  flush: true,
  glide: true,
  flushColors: {},
  motionParams: {},
  textureId: 'none',
  textureColors: {},
  textureWidth: 1,
  textureOpacity: 1,
  textureDensity: 1,
  topperSize: 1,
  topperSpread: 1,
  topperHeight: 1,
  topperAcross: 0,
  topperLift: 0,
  topperTilt: 0,
  topperDepth: 0.2,
  topperColor: '',
}

const DETAIL = 3
const OVERLAY_SLOTS = 6
const OVERLAY_POOL = ['ov0', 'ov1', 'ov2', 'ov3', 'ov4', 'ov5'] as const
const TEXTURE_SLOTS = 4
const TEXTURE_POOL = ['tex0', 'tex1', 'tex2', 'tex3'] as const

export type BobMood = 'idle' | 'listening' | 'thinking' | 'curious' | 'excited' | 'happy'

type BobRefs = Record<string, SVGElement | null>

function lay(node: SVGElement | null | undefined, path: string | undefined, opacity: string | number | undefined) {
  if (!node) return
  node.setAttribute('d', path || 'M0 0')
  node.setAttribute('opacity', path ? String(opacity ?? 1) : '0')
}

function applyEye(
  sclera: SVGElement | null | undefined,
  iris: SVGElement | null | undefined,
  pupil: SVGElement | null | undefined,
  glint: SVGElement | null | undefined,
  eye: BobRuntimeEye | undefined,
) {
  if (!eye) {
    lay(sclera, '', '0')
    lay(iris, '', '0')
    lay(pupil, '', '0')
    lay(glint, '', '0')
    return
  }
  lay(sclera, eye.d, eye.op)
  lay(iris, eye.id, eye.pop)
  lay(pupil, eye.pd, eye.pop)
  lay(glint, eye.gd, eye.pop)
}

function applyFlush(nodes: BobRefs, frame: ReturnType<typeof svgFrame>, paint: BobRuntimePaint, blushFilter: string) {
  const ramp = frame.ramp
  nodes.stop0?.setAttribute('stop-color', ramp ? ramp.light : paint.light)
  nodes.stop1?.setAttribute('stop-color', ramp ? ramp.mid : paint.mid)
  nodes.stop2?.setAttribute('stop-color', ramp ? ramp.dark : paint.dark)
  for (let index = 0; index < OVERLAY_SLOTS; index += 1) {
    const node = nodes[`ov${index}`]
    if (!node) continue
    const overlay = frame.overlays[index]
    if (!overlay) {
      node.setAttribute('opacity', '0')
      continue
    }
    node.setAttribute('d', overlay.d)
    node.setAttribute('fill', overlay.fill)
    node.setAttribute('opacity', String(overlay.op))
    node.setAttribute('filter', overlay.blur ? blushFilter : 'none')
  }
}

function applyTexture(nodes: BobRefs, frame: ReturnType<typeof svgFrame>) {
  for (let index = 0; index < TEXTURE_SLOTS; index += 1) {
    const node = nodes[`tex${index}`]
    if (!node) continue
    const layer = frame.texture[index]
    if (!layer) {
      node.setAttribute('opacity', '0')
      node.setAttribute('d', 'M0 0')
      continue
    }
    node.setAttribute('d', layer.d || 'M0 0')
    node.setAttribute('fill', layer.fill)
    node.setAttribute('stroke', layer.stroke)
    node.setAttribute('stroke-width', String(layer.width))
    node.setAttribute('opacity', layer.d ? String(layer.op) : '0')
  }
}

export function BobCharacter({
  mood = 'idle',
  className,
}: {
  mood?: BobMood
  className?: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const headId = `bob-head-${uid}`
  const clipId = `bob-clip-${uid}`
  const gradId = `bob-grad-${uid}`
  const blushId = `bob-blush-${uid}`
  const glossId = `bob-gloss-${uid}`
  const rimId = `bob-rim-${uid}`

  const config = { ...BOB_CONFIG, motionId: mood }
  const style = EYE_STYLE_BY_ID[config.eyeStyleId]
  const motion = MOTION_BY_ID[config.motionId] ?? MOTION_BY_ID.idle
  const topper = topperById(config.topperId, DETAIL)
  const paint = bodyPaint(config, BOB_SPEC)
  const gradientTransform = `scale(${paint.scaleX} ${paint.scaleY})`
  const extent = contentExtent(BOB_SPEC, config, topper, motion)
  const pad = Math.max(8, extent * 0.08)
  const viewBox = `${-extent - pad} ${-extent - pad} ${(extent + pad) * 2} ${(extent + pad) * 2}`

  const nodes = useRef<BobRefs>({})
  const setRef = (key: string) => (node: SVGElement | null) => {
    nodes.current[key] = node
  }
  const avatarRef = useRef<ReturnType<typeof createAvatar> | null>(null)
  const inputRef = useRef({ config, style, topper, drag: { x: 0, y: 0, active: false } })
  inputRef.current = { config, style, topper, drag: { x: 0, y: 0, active: false } }

  if (!avatarRef.current) {
    avatarRef.current = createAvatar(BOB_SPEC, motion, true, 4.3, DETAIL)
  }

  useEffect(() => {
    const avatar = avatarRef.current
    if (avatar && avatar.motion !== motion) play(avatar, motion)
  }, [motion])

  useEffect(() => {
    const avatar = avatarRef.current
    if (!avatar) return

    const paintFrame = (now: number) => {
      const frame = svgFrame(computeFrame(avatar, now, inputRef.current))
      const current = nodes.current
      current.head?.setAttribute('d', frame.bodyD)
      current.group?.setAttribute('transform', frame.groupTransform)
      applyEye(current.eyeL, current.irisL, current.pupL, current.glintL, frame.eyeL)
      applyEye(current.eyeR, current.irisR, current.pupR, current.glintR, frame.eyeR)
      applyEye(current.eyeC, current.irisC, current.pupC, current.glintC, frame.eyeC)
      applyFlush(current, frame, paint, `url(#${blushId})`)
      applyTexture(current, frame)
    }

    paintFrame(performance.now())
    if (prefersReducedMotion()) return undefined

    let frameId = 0
    const loop = (now: number) => {
      paintFrame(now)
      frameId = requestAnimationFrame(loop)
    }
    frameId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frameId)
  }, [blushId, paint])

  return (
    <svg className={className} viewBox={viewBox} aria-hidden="true">
      <defs>
        <path ref={setRef('head')} id={headId} d="" fillRule="nonzero" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        <clipPath id={clipId}>
          <use href={`#${headId}`} />
        </clipPath>
        <filter id={blushId} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
        <radialGradient id={gradId} gradientUnits="userSpaceOnUse" cx={paint.cx} cy={paint.cy} r={paint.r} gradientTransform={gradientTransform}>
          {paint.stops
            ? paint.stops.map((stop, index) => (
              <stop key={index} offset={stop.offset} stopColor={stop.color} stopOpacity={stop.opacity} />
            ))
            : [
              <stop key="a" ref={setRef('stop0')} offset="0" stopColor={paint.light} />,
              <stop key="b" ref={setRef('stop1')} offset="0.5" stopColor={paint.mid} />,
              <stop key="c" ref={setRef('stop2')} offset="1" stopColor={paint.dark} />,
            ]}
        </radialGradient>
        {paint.gloss ? (
          <radialGradient id={glossId} gradientUnits="userSpaceOnUse" cx={paint.gloss.cx} cy={paint.gloss.cy} r={paint.gloss.r} gradientTransform={gradientTransform}>
            <stop offset="0" stopColor={paint.gloss.color} stopOpacity={paint.gloss.opacity} />
            <stop offset="0.45" stopColor={paint.gloss.color} stopOpacity={paint.gloss.opacity * 0.3} />
            <stop offset="1" stopColor={paint.gloss.color} stopOpacity="0" />
          </radialGradient>
        ) : null}
        {paint.rim ? (
          <radialGradient id={rimId} gradientUnits="userSpaceOnUse" cx="0" cy="0" r={paint.rim.r} gradientTransform={gradientTransform}>
            <stop offset={paint.rim.inner} stopColor={paint.rim.color} stopOpacity="0" />
            <stop offset="1" stopColor={paint.rim.color} stopOpacity={paint.rim.opacity} />
          </radialGradient>
        ) : null}
      </defs>
      <g ref={setRef('group')}>
        <use href={`#${headId}`} fill={`url(#${gradId})`} stroke={paint.seam !== false ? `url(#${gradId})` : 'none'} />
        <g clipPath={`url(#${clipId})`}>
          {TEXTURE_POOL.map((key) => (
            <path key={key} ref={setRef(key)} fill="none" strokeLinejoin="round" strokeLinecap="round" opacity="0" />
          ))}
        </g>
        {paint.rim ? <use href={`#${headId}`} fill={`url(#${rimId})`} /> : null}
        {paint.gloss ? <use href={`#${headId}`} fill={`url(#${glossId})`} /> : null}
        <g clipPath={`url(#${clipId})`}>
          {OVERLAY_POOL.map((key) => (
            <path key={key} ref={setRef(key)} opacity="0" />
          ))}
          <path ref={setRef('eyeL')} fill={config.eyeColor} />
          <path ref={setRef('eyeR')} fill={config.eyeColor} />
          <path ref={setRef('eyeC')} fill={config.eyeColor} />
          <path ref={setRef('irisL')} fill={config.irisColor} />
          <path ref={setRef('irisR')} fill={config.irisColor} />
          <path ref={setRef('irisC')} fill={config.irisColor} />
          <path ref={setRef('pupL')} fill={config.pupilColor} />
          <path ref={setRef('pupR')} fill={config.pupilColor} />
          <path ref={setRef('pupC')} fill={config.pupilColor} />
          <path ref={setRef('glintL')} fill={config.glintColor} />
          <path ref={setRef('glintR')} fill={config.glintColor} />
          <path ref={setRef('glintC')} fill={config.glintColor} />
        </g>
      </g>
    </svg>
  )
}
