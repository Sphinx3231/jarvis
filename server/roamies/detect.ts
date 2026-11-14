import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

/**
 * Jarvis is built on Roamies (https://github.com/KenKaiii/Roamies): it uses the same engine,
 * the same model choice and the same sign-ins. It only runs where Roamies is installed.
 */
export const ROAMIES_RELEASES_URL = 'https://github.com/KenKaiii/Roamies/releases/latest';
export const ROAMIES_REPO_URL = 'https://github.com/KenKaiii/Roamies';

export interface RoamiesDetection {
  installed: boolean;
  /** The app or executable that was found. */
  path: string | null;
  how: 'override' | 'chosen' | 'app' | 'command' | 'appimage' | 'registry' | null;
  version: string | null;
  /** Where Roamies keeps its settings (sidekick.json) and sign-ins (auth.json). */
  ggDir: string;
  configPath: string;
  /** Whether Roamies has been opened and set up at least once. */
  configured: boolean;
  checkedAt: number;
  /** Places that were looked at, shown on the lock screen when nothing is found. */
  searched: string[];
}

/** ~/.gg, shared by Roamies and the GG framework. JARVIS_GG_DIR overrides it (tests). */
export function ggDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.JARVIS_GG_DIR || join(homedir(), '.gg');
}

/** Roamies' settings file: $ROAMIES_DATA_DIR/sidekick.json, else ~/.gg/sidekick.json (as Roamies itself resolves it). */
export function roamiesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROAMIES_DATA_DIR ? join(env.ROAMIES_DATA_DIR, 'sidekick.json') : join(ggDir(env), 'sidekick.json');
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function macVersion(app: string): string | null {
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A path the user picked as their Roamies app counts only if it exists and is named like Roamies. */
export function acceptablePath(p: string): boolean {
  if (!p || !/roamies/i.test(basename(p))) return false;
  return isFile(p) || isDir(p);
}

type Found = Pick<RoamiesDetection, 'path' | 'how' | 'version'>;

function findMac(home: string, searched: string[]): Found | null {
  for (const dir of ['/Applications', join(home, 'Applications')]) {
    const app = join(dir, 'Roamies.app');
    searched.push(app);
    if (isDir(app)) return { path: app, how: 'app', version: macVersion(app) };
  }
  return null;
}

function findWindows(env: NodeJS.ProcessEnv, searched: string[]): Found | null {
  const roots = [env.LOCALAPPDATA, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean) as string[];
  for (const root of roots) {
    for (const exe of ['Roamies.exe', 'roamies.exe']) {
      const p = join(root, 'Roamies', exe);
      if (exe === 'Roamies.exe') searched.push(p);
      if (isFile(p)) return { path: p, how: 'app', version: null };
    }
  }
  // The installer registers an uninstall entry under the product name.
  for (const hive of ['HKCU', 'HKLM']) {
    const key = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Roamies`;
    searched.push(key);
    try {
      const out = execFileSync('reg', ['query', key], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const location = /InstallLocation\s+REG_SZ\s+(.+)/.exec(out)?.[1]?.trim().replace(/^"|"$/g, '');
      const version = /DisplayVersion\s+REG_SZ\s+(.+)/.exec(out)?.[1]?.trim() ?? null;
      return { path: location || key, how: 'registry', version };
    } catch {
      // not registered here
    }
  }
  return null;
}

function findLinux(env: NodeJS.ProcessEnv, home: string, searched: string[]): Found | null {
  const dirs = [...new Set([...(env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin', '/usr/local/bin', '/opt/Roamies', '/opt/roamies'])];
  for (const dir of dirs) {
    const p = join(dir, 'roamies');
    if (isFile(p)) return { path: p, how: 'command', version: null };
  }
  searched.push('roamies on PATH (.deb / .rpm)');
  // AppImages run from wherever they were saved: look in the usual places.
  for (const dir of [join(home, 'Applications'), join(home, 'AppImages'), join(home, '.local', 'bin'), join(home, 'bin'), join(home, 'Downloads'), join(home, 'Desktop'), home, '/opt']) {
    searched.push(join(dir, 'Roamies*.AppImage'));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => /^roamies.*\.appimage$/i.test(n));
    if (hit && isFile(join(dir, hit))) return { path: join(dir, hit), how: 'appimage', version: /(\d+\.\d+\.\d+)/.exec(hit)?.[1] ?? null };
  }
  return null;
}

/**
 * Looks for an installed Roamies. `JARVIS_ROAMIES_PATH` replaces the search (tests and CI: set it to a
 * file that exists to pass, or to a missing path to fail). `chosenPath` is a location the user picked.
 */
export function detectRoamies(opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; chosenPath?: string | null } = {}): RoamiesDetection {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = env.HOME || env.USERPROFILE || homedir();
  const searched: string[] = [];
  let found: Found | null = null;

  if (env.JARVIS_ROAMIES_PATH !== undefined) {
    searched.push(env.JARVIS_ROAMIES_PATH || '(JARVIS_ROAMIES_PATH is empty)');
    if (env.JARVIS_ROAMIES_PATH && existsSync(env.JARVIS_ROAMIES_PATH)) found = { path: env.JARVIS_ROAMIES_PATH, how: 'override', version: null };
  } else {
    if (opts.chosenPath) {
      searched.push(opts.chosenPath);
      if (acceptablePath(opts.chosenPath)) found = { path: opts.chosenPath, how: 'chosen', version: null };
    }
    if (!found) found = platform === 'darwin' ? findMac(home, searched) : platform === 'win32' ? findWindows(env, searched) : findLinux(env, home, searched);
  }

  const configPath = roamiesConfigPath(env);
  return {
    installed: Boolean(found),
    path: found?.path ?? null,
    how: found?.how ?? null,
    version: found?.version ?? null,
    ggDir: ggDir(env),
    configPath,
    configured: isFile(configPath),
    checkedAt: Date.now(),
    searched,
  };
}
