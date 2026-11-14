import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LiveProvider } from './lib/live';
import { VoiceProvider } from './lib/voice';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveProvider>
      <VoiceProvider>
        <App />
      </VoiceProvider>
    </LiveProvider>
  </StrictMode>,
);
