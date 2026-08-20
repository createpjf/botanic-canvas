import workbenchImage from '../assets/product/botanic-workbench-agent.webp'
import sceneImage from '../assets/figma/scene.webp'
import { ArrowUpRightIcon } from './BotanicIcons'
import { LanguageSwitcher, useProductI18n } from '../i18n/react'

type ProductLandingProps = {
  isAuthenticated: boolean
  onEnterWorkspace: () => void
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

export function ProductLanding({ isAuthenticated, onEnterWorkspace }: ProductLandingProps) {
  const { locale } = useProductI18n()
  const copy = productLandingCopy[locale]
  const enterLabel = isAuthenticated ? copy.enterWorkspace : copy.signIn

  return (
    <main className="product-landing" id="product-top" lang={locale}>
      <header className="product-landing__nav">
        <a className="product-landing__brand" href="#product-top" aria-label={copy.brandAria}>
          <strong>Botanic</strong>
          <span>AI VISUAL PRODUCTION</span>
        </a>
        <nav aria-label={copy.navAria}>
          <a href="#product-capabilities">{copy.capabilitiesNav}</a>
          <a href="#product-workflow">{copy.workflowNav}</a>
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
              <a href="#product-workflow">{copy.learnWorkflow}</a>
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
