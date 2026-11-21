import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The project folder (where web/dist, docs and README.md live). The service runs from source as
 * <root>/server, and compiled as <root>/dist-server/server (beside dist-server/shared).
 */
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_ROOT = basename(dirname(serverDir)) === 'dist-server' ? join(serverDir, '..', '..') : join(serverDir, '..');
