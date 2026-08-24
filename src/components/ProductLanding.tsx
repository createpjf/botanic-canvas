import { useRef, type MouseEvent } from 'react'
import workbenchImage from '../assets/product/botanic-workbench-agent.webp'
import sceneImage from '../assets/figma/scene.webp'
import { ArrowUpRightIcon } from './BotanicIcons'
import {
  botanicMotion,
  gsap,
  mapPointerShift,
  motionDuration,
  normalizePointerAxis,
  Observer,
  ScrollTrigger,
  useGSAP,
} from './gsapMotion'
import { LanguageSwitcher, useProductI18n } from '../i18n/react'

type ProductLandingProps = {
  isAuthenticated: boolean
  onEnterWorkspace: () => void
  ariaHidden?: boolean
}

const productLandingCopy = {
  'zh-CN': {
    brandAria: 'Botanic 产品首页',
    navAria: '产品介绍导航',
    capabilitiesNav: '产品能力',
    workflowNav: '工作方式',
    signIn: '登录工作台',
    enterWorkspace: '进入工作台',
    heroEyebrow: 'AI VISUAL PRODUCTION',
    heroTitle: '让品牌视觉生产，成为持续生长的创作系统。',
    heroDescription: '在无限画布中连接素材、提示词、模型与结果；由 Agent 协助规划和执行，并保留每一次创作的历史与血缘。',
    learnWorkflow: '了解工作方式',
    featuresAria: 'Botanic 产品特点',
    features: ['无限画布', 'Agent 协作', '图片与视频生成', '可恢复历史'],
    visualAria: 'Botanic 真实创作工作台预览',
    visualTitle: '节点画布与 Agent 协作',
    visualStatus: '产品实景',
    visualAlt: 'Botanic 工作台截图，左侧为视觉节点画布，右侧打开 Botanic Agent 面板',
    visualSummary: '素材、生成节点与 Agent 计划在同一个项目中保持上下文。',
    visualTag: '实时工作台',
    capabilitiesEyebrow: 'BUILT FOR BRAND TEAMS',
    capabilitiesTitle: '从一次生成，走向完整的视觉生产。',
    capabilitiesDescription: 'Botanic 让创作上下文、执行过程与结果保持在同一个项目中。',
    capabilities: [
      ['01', '画布化创作', '把素材、文本、生成节点与结果连接成一条可编辑、可复用的视觉工作流。'],
      ['02', 'Agent 协作', '从项目上下文出发形成计划，在确认后执行生成、检索与受控操作。'],
      ['03', '持续沉淀', '保留模型参数、版本、生成记录与结果血缘，让每次创作都能继续迭代。'],
    ],
    memoryLabel: 'PROJECT MEMORY',
    memoryRule: '自然光、克制构图、保留植物呼吸感',
    memoryStatus: '已应用于当前创作计划',
    workflowEyebrow: 'A TRACEABLE WORKFLOW',
    workflowTitle: '每一步都可确认，每个结果都有来路。',
    workflowDescription: '品牌规则不会散落在临时对话里。素材、计划、任务与产物共同组成可恢复的项目创作图谱。',
    workflowSteps: [
      ['01', '汇入品牌素材', '集中人物、商品、场景与风格参考。'],
      ['02', '确认创作计划', '锁定不变项，再展开需要探索的维度。'],
      ['03', '生成独立结果', '图片与视频结果分别进入画布和历史。'],
      ['04', '选择并交付', '在同一项目中完成预览、下载与继续编辑。'],
    ],
    sceneAlt: 'Botanic 项目中的自然场景素材',
    ctaEyebrow: 'START CREATING',
    ctaTitle: '把下一次创作，放进一个能继续生长的工作流。',
    ctaDescription: '登录 Botanic，进入你的品牌视觉项目。',
  },
  en: {
    brandAria: 'Botanic product home',
    navAria: 'Product introduction',
    capabilitiesNav: 'Capabilities',
    workflowNav: 'Workflow',
    signIn: 'Sign in',
    enterWorkspace: 'Open workspace',
    heroEyebrow: 'AI VISUAL PRODUCTION',
    heroTitle: 'Turn brand visual production into a creative system that keeps growing.',
    heroDescription: 'Connect assets, prompts, models, and outputs on an infinite canvas. Let Agent help plan and execute while every creative decision stays traceable.',
    learnWorkflow: 'See how it works',
    featuresAria: 'Botanic product highlights',
    features: ['Infinite canvas', 'Agent collaboration', 'Image and video generation', 'Recoverable history'],
    visualAria: 'Preview of the real Botanic creative workspace',
    visualTitle: 'Node canvas and Agent collaboration',
    visualStatus: 'Product view',
    visualAlt: 'Botanic workspace with visual nodes on the canvas and the Botanic Agent panel open',
    visualSummary: 'Assets, generation nodes, and Agent plans stay in context inside one project.',
    visualTag: 'Live workspace',
    capabilitiesEyebrow: 'BUILT FOR BRAND TEAMS',
    capabilitiesTitle: 'Move beyond one-off generations to complete visual production.',
    capabilitiesDescription: 'Botanic keeps creative context, execution, and outputs together in one project.',
    capabilities: [
      ['01', 'Canvas creation', 'Connect assets, text, generation nodes, and outputs into an editable, reusable visual workflow.'],
      ['02', 'Agent collaboration', 'Build plans from project context, then run generation, retrieval, and governed actions after confirmation.'],
      ['03', 'Compounding context', 'Keep model settings, versions, generation records, and lineage so every project can continue evolving.'],
    ],
    memoryLabel: 'PROJECT MEMORY',
    memoryRule: 'Natural light, restrained composition, and room for the botanicals to breathe',
    memoryStatus: 'Applied to the current creative plan',
    workflowEyebrow: 'A TRACEABLE WORKFLOW',
    workflowTitle: 'Confirm every step. Trace every result.',
    workflowDescription: 'Brand rules do not disappear into temporary chats. Assets, plans, jobs, and artifacts form a recoverable creative graph.',
    workflowSteps: [
      ['01', 'Bring in brand assets', 'Organize people, products, scenes, and style references.'],
      ['02', 'Confirm the creative plan', 'Lock what stays fixed, then define the dimensions to explore.'],
      ['03', 'Generate distinct outputs', 'Images and videos enter the canvas and history as separate results.'],
      ['04', 'Select and deliver', 'Preview, download, and keep editing in the same project.'],
    ],
    sceneAlt: 'A natural scene asset inside a Botanic project',
    ctaEyebrow: 'START CREATING',
    ctaTitle: 'Put your next creative brief into a workflow that keeps growing.',
    ctaDescription: 'Sign in to Botanic and open your brand visual projects.',
  },
} as const

export function ProductLanding({ isAuthenticated, onEnterWorkspace, ariaHidden = false }: ProductLandingProps) {
  const { locale } = useProductI18n()
  const copy = productLandingCopy[locale]
  const enterLabel = isAuthenticated ? copy.enterWorkspace : copy.signIn
  const rootRef = useRef<HTMLElement>(null)

  const { contextSafe } = useGSAP(() => {
    const root = rootRef.current
    if (!root) return
    const mm = gsap.matchMedia()
    mm.add(
      {
        reduceMotion: '(prefers-reduced-motion: reduce)',
        allowMotion: '(prefers-reduced-motion: no-preference)',
        finePointer: '(hover: hover) and (pointer: fine)',
      },
      (context) => {
        const reduceMotion = context.conditions?.reduceMotion
        const allowMotion = context.conditions?.allowMotion
        const finePointer = context.conditions?.finePointer
        if (reduceMotion || !allowMotion) return

        const hero = gsap.timeline({ defaults: { duration: botanicMotion.duration.landing, ease: botanicMotion.ease } })
        hero
          .from('.product-hero .workspace-eyebrow', { autoAlpha: 0, y: 10 }, 0)
          .from('#product-hero-title', { y: 16 }, 0)
          .from('.product-hero__copy p', { autoAlpha: 0, y: 10 }, '>-0.22')
          .from('.product-hero__actions > *', { autoAlpha: 0, y: 8, stagger: 0.05 }, '>-0.24')
          .from('.product-hero__copy ul li', { autoAlpha: 0, y: 6, stagger: 0.04 }, '>-0.2')
          .from('.product-hero__visual', { autoAlpha: 0, y: 14, duration: 0.5 }, 0.12)

        ScrollTrigger.batch('.product-capabilities article', {
          scroller: root,
          start: 'top 88%',
          once: true,
          interval: 0.08,
          batchMax: 3,
          onEnter: (batch) => gsap.fromTo(batch, { autoAlpha: 0, y: 16 }, {
            autoAlpha: 1,
            y: 0,
            stagger: 0.08,
            duration: 0.36,
            ease: botanicMotion.ease,
            overwrite: true,
          }),
        })

        ScrollTrigger.batch('.product-workflow__content ol li', {
          scroller: root,
          start: 'top 90%',
          once: true,
          interval: 0.08,
          onEnter: (batch) => gsap.fromTo(batch, { autoAlpha: 0, y: 12 }, {
            autoAlpha: 1,
            y: 0,
            stagger: 0.06,
            duration: 0.32,
            ease: botanicMotion.ease,
            overwrite: true,
          }),
        })

        gsap.to('.product-workflow__media img', {
          y: 20,
          ease: 'none',
          scrollTrigger: {
            trigger: '.product-workflow',
            scroller: root,
            start: 'top bottom',
            end: 'bottom top',
            scrub: 0.6,
          },
        })

        if (!finePointer) return
        const visual = root.querySelector<HTMLElement>('.product-hero__visual')
        if (!visual) return
        visual.classList.add('is-tracking')
        const xTo = gsap.quickTo(visual, 'x', { duration: 0.55, ease: 'power3' })
        const yTo = gsap.quickTo(visual, 'y', { duration: 0.55, ease: 'power3' })
        Observer.create({
          target: visual,
          type: 'pointer',
          onMove: (self) => {
            const rect = visual.getBoundingClientRect()
            const pointerX = self.x ?? rect.left + rect.width / 2
            const pointerY = self.y ?? rect.top + rect.height / 2
            xTo(mapPointerShift(normalizePointerAxis(rect.left, rect.right, pointerX), -8, 8))
            yTo(mapPointerShift(normalizePointerAxis(rect.top, rect.bottom, pointerY), -6, 6))
          },
          onStop: () => {
            xTo(0)
            yTo(0)
          },
          onHoverEnd: () => {
            xTo(0)
            yTo(0)
          },
        })
        return () => visual.classList.remove('is-tracking')
      },
      root,
    )
    return () => mm.revert()
  }, { scope: rootRef, dependencies: [locale], revertOnUpdate: true })

  const handleHashNav = contextSafe((event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute('href')
    const root = rootRef.current
    if (!href?.startsWith('#') || !root) return
    const target = root.querySelector(href)
    if (!(target instanceof HTMLElement)) return
    event.preventDefault()
    gsap.to(root, {
      duration: motionDuration(0.58),
      ease: botanicMotion.ease,
      overwrite: true,
      scrollTo: { y: target, offsetY: 72, autoKill: true },
    })
  })

  return (
    <main ref={rootRef} className="product-landing" id="product-top" lang={locale} aria-hidden={ariaHidden || undefined} inert={ariaHidden || undefined}>
      <header className="product-landing__nav">
        <a className="product-landing__brand" href="#product-top" aria-label={copy.brandAria} onClick={handleHashNav}>
          <strong>Botanic</strong>
          <span>AI VISUAL PRODUCTION</span>
        </a>
        <nav aria-label={copy.navAria}>
          <a href="#product-capabilities" onClick={handleHashNav}>{copy.capabilitiesNav}</a>
          <a href="#product-workflow" onClick={handleHashNav}>{copy.workflowNav}</a>
        </nav>
        <div className="product-landing__nav-actions">
          <LanguageSwitcher className="product-landing__language" />
          <button type="button" className="product-landing__login" onClick={onEnterWorkspace}>
            {enterLabel} <ArrowUpRightIcon />
          </button>
        </div>
      </header>

      <div className="product-landing__frame">
        <section className="product-hero" aria-labelledby="product-hero-title">
          <div className="product-hero__copy">
            <span className="workspace-eyebrow"><i />{copy.heroEyebrow}</span>
            <h1 id="product-hero-title">{copy.heroTitle}</h1>
            <p>{copy.heroDescription}</p>
            <div className="product-hero__actions">
              <button type="button" onClick={onEnterWorkspace}>{enterLabel} <ArrowUpRightIcon /></button>
              <a href="#product-workflow" onClick={handleHashNav}>{copy.learnWorkflow}</a>
            </div>
            <ul aria-label={copy.featuresAria}>
              {copy.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
          </div>

          <section className="product-hero__visual" aria-label={copy.visualAria}>
            <header>
              <div><span>BOTANIC CANVAS</span><strong>{copy.visualTitle}</strong></div>
              <small>{copy.visualStatus}</small>
            </header>
            <div className="product-hero__screenshot">
              <img src={workbenchImage} alt={copy.visualAlt} decoding="async" fetchPriority="high" />
            </div>
            <footer>
              <div><span>BOTANIC AGENT</span><strong>{copy.visualSummary}</strong></div>
              <small>{copy.visualTag}</small>
            </footer>
          </section>
        </section>

        <section className="product-capabilities" id="product-capabilities" aria-labelledby="product-capabilities-title">
          <header>
            <span className="workspace-eyebrow"><i />{copy.capabilitiesEyebrow}</span>
            <h2 id="product-capabilities-title">{copy.capabilitiesTitle}</h2>
            <p>{copy.capabilitiesDescription}</p>
          </header>
          <div>
            {copy.capabilities.map(([number, title, description]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="product-workflow" id="product-workflow" aria-labelledby="product-workflow-title">
          <div className="product-workflow__media">
            <img src={sceneImage} alt={copy.sceneAlt} loading="lazy" />
            <article>
              <span>{copy.memoryLabel}</span>
              <strong>{copy.memoryRule}</strong>
              <small>{copy.memoryStatus}</small>
            </article>
          </div>
          <div className="product-workflow__content">
            <span className="workspace-eyebrow"><i />{copy.workflowEyebrow}</span>
            <h2 id="product-workflow-title">{copy.workflowTitle}</h2>
            <p>{copy.workflowDescription}</p>
            <ol>
              {copy.workflowSteps.map(([number, title, description]) => (
                <li key={number}>
                  <span>{number}</span>
                  <div><strong>{title}</strong><p>{description}</p></div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="product-landing__cta" aria-labelledby="product-cta-title">
          <div>
            <span className="workspace-eyebrow"><i />{copy.ctaEyebrow}</span>
            <h2 id="product-cta-title">{copy.ctaTitle}</h2>
            <p>{copy.ctaDescription}</p>
          </div>
          <button type="button" onClick={onEnterWorkspace}>{enterLabel} <ArrowUpRightIcon /></button>
        </section>
      </div>
    </main>
  )
}
