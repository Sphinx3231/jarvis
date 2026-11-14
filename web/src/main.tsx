import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RoamiesGate } from './components/RoamiesGate';
import { LiveProvider } from './lib/live';
import { VoiceProvider } from './lib/voice';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RoamiesGate>
      <LiveProvider>
        <VoiceProvider>
          <App />
        </VoiceProvider>
      </LiveProvider>
    </RoamiesGate>
  </StrictMode>,
);
