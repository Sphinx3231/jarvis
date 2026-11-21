import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RoamiesGate } from './components/RoamiesGate';
import { LiveProvider } from './lib/live';
import { VoiceProvider } from './lib/voice';
// The display face for the HUD (titles, numbers, agent names), bundled so it works offline.
import '@fontsource/rajdhani/latin-500.css';
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import './styles.css';
import 'lenis/dist/lenis.css';
import './motion/motion.css';

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
