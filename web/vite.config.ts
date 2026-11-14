import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.JARVIS_PORT ?? 7777);

/** In development the API token is read from the running server's data directory. */
function devToken(): Plugin {
  return {
    name: 'jarvis-dev-token',
    apply: 'serve',
    transformIndexHtml(html) {
      try {
        const dir = process.env.JARVIS_DATA_DIR ?? join(homedir(), '.jarvis');
        const token = readFileSync(join(dir, 'session.token'), 'utf8').trim();
        return html.replace('<meta name="jarvis-token" content="" />', `<meta name="jarvis-token" content="${token}" />`);
      } catch {
        return html;
      }
    },
  };
}

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react(), devToken()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
