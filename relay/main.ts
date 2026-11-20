/**
 * Run the Jarvis relay:  PORT=8787 node relay/main.ts
 * Put it behind TLS (any HTTPS host or reverse proxy) so clients connect with wss://…/v1.
 */
import { startRelay } from './relay.ts';

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  log: (m) => console.log(`[relay] ${new Date().toISOString()} ${m}`),
});
console.log(`[relay] listening on :${relay.port} (WebSocket path /v1, health /healthz)`);
const stop = () => void relay.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
