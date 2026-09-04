import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SpeedInsights } from '@vercel/speed-insights/react'
import App from './App'
import { ProductI18nProvider } from './i18n/react'
import { initializeBrowserSentry, sentryReactErrorHandler } from './lib/sentry'
import './styles.css'
import './styles/ai-elements.css'

const sentryEnabled = initializeBrowserSentry()
const reportReactError = sentryReactErrorHandler()

createRoot(document.getElementById('root')!, sentryEnabled ? {
  onCaughtError: reportReactError,
  onRecoverableError: reportReactError,
  onUncaughtError: reportReactError,
} : undefined).render(
  <StrictMode>
    <ProductI18nProvider>
      <App />
      <SpeedInsights />
    </ProductI18nProvider>
  </StrictMode>,
)
