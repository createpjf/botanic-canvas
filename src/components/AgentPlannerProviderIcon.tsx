import { agentPlannerProvider } from './generationModelPresentation'

/** 规划模型的官方厂商标识；图标文件来自各厂商官网 favicon。 */
export function AgentPlannerProviderIcon({ model }: { model: string }) {
  const provider = agentPlannerProvider(model)
  return <span className={`agent-provider-icon is-${provider}`} aria-hidden="true">
    {provider === 'deepseek' ? <img src="/provider-logos/deepseek.ico" alt="" draggable="false" />
      : provider === 'kimi' ? <img src="/provider-logos/kimi.ico" alt="" draggable="false" />
        : provider === 'minimax' ? <span className="agent-provider-icon__letter">M</span>
          : <span className="agent-provider-icon__letter">AI</span>}
  </span>
}
