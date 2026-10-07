import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { initI18n } from './i18n'
import './styles/globals.css'
import { registerServiceWorker } from './pwa/registerServiceWorker'
import { PageErrorBoundary } from './components/PageErrorBoundary'
import { installChunkRecovery } from './lib/chunkRecovery'

// Before the first render, so nothing paints in one language and then swaps.
initI18n()
registerServiceWorker()
installChunkRecovery()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PageErrorBoundary><App /></PageErrorBoundary>
  </React.StrictMode>,
)
