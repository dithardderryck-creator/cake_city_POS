import '@fontsource/young-serif';
import '@fontsource-variable/nunito';
import '@cake-pos/design-system/tokens.css';
import '@cake-pos/design-system/components.css';
import '@cake-pos/design-system/docs.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PanelProvider } from './lib/panel';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PanelProvider>
      <App />
    </PanelProvider>
  </StrictMode>,
);
