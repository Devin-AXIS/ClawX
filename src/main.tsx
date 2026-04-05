/**
 * React Application Entry Point
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles/globals.css';
import './styles/default-bundled-theme.css';
import { initializeDefaultTransports, invokeIpc } from './lib/api-client';
import { setRuntimeBrandOverrides, type RuntimeBrandOverrides } from './brand/runtime';

initializeDefaultTransports();

function applyRuntimeBrand(overrides: RuntimeBrandOverrides): void {
  setRuntimeBrandOverrides(overrides);
  if (overrides.appName) {
    document.title = overrides.appName;
  }
  if (overrides.cssVariables) {
    for (const [key, value] of Object.entries(overrides.cssVariables)) {
      if (!key) continue;
      document.documentElement.style.setProperty(key, value);
    }
  }
  if (overrides.customCss) {
    const styleId = 'runtime-brand-overrides';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = overrides.customCss;
  }
}

async function bootstrap(): Promise<void> {
  try {
    const overrides = await invokeIpc<RuntimeBrandOverrides>('app:brand-overrides');
    applyRuntimeBrand(overrides ?? {});
  } catch {
    // Ignore override-loading failures; app can still start with built-in branding.
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>,
  );
}

void bootstrap();
