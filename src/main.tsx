import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SpeedInsights } from '@vercel/speed-insights/react'
import App from './App'
import { ProductI18nProvider } from './i18n/react'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProductI18nProvider>
      <App />
      <SpeedInsights />
    </ProductI18nProvider>
  </StrictMode>,
)
