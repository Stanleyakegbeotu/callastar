import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { initI18n } from './i18n'
import './styles/globals.css'
import { registerServiceWorker } from './pwa/registerServiceWorker'

// Before the first render, so nothing paints in one language and then swaps.
initI18n()
registerServiceWorker()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
