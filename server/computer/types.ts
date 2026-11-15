/**
 * Computer Access Mode — shared types.
 *
 * The capability surface that lets Jarvis see and (at higher levels) use the computer it runs on.
 * Everything here is platform-independent; the OS-specific work lives behind `OsAdapter`
 * (see adapters.ts). Nothing in this module ever claims a capability works unless it has been
 * detected on the actual machine — the status flags exist precisely to tell the truth about what
 * is and isn't available on the host Jarvis is running on right now.
 */

/** observe < interact < extended. Higher levels include everything the lower ones allow. */
export type AccessLevel = 'observe' | 'interact' | 'extended';
export const ACCESS_LEVELS: AccessLevel[] = ['observe', 'interact', 'extended'];
export function levelRank(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

/**
 * available      — detected and usable right now on this machine
 * limited        — partly usable (e.g. an accessibility API present but Wayland hides window text)
 * needs-permission — the OS gates it behind a permission the user has not granted (macOS, mostly)
 * unverified     — the code exists but has not been proven to work on this OS (never asserted as PASS)
 * unavailable    — not possible here (no display, no native module, unsupported platform)
 */
export type CapabilityStatus = 'available' | 'limited' | 'needs-permission' | 'unverified' | 'unavailable';

export interface Capability {
  id: string;
  label: string;
  /** The lowest access level at which this capability is exercised. */
  level: AccessLevel;
  status: CapabilityStatus;
  detail: string;
  /** What would make it available (a native module, an OS permission, a display server). */
  requires?: string;
}

export interface DisplayInfo {
  server: 'x11' | 'wayland' | 'windows' | 'quartz' | 'headless' | 'unknown';
  /** No usable display (e.g. a server/cloud container): screen + window + input are impossible. */
  headless: boolean;
  detail: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  /** Percent of one CPU, as the OS reports it; null when the platform can't provide it. */
  cpu: number | null;
  /** Percent of physical memory; null when unavailable. */
  memPercent: number | null;
}

export interface ActiveWindow {
  title: string | null;
  app: string | null;
  pid: number | null;
  /** False when the active window genuinely can't be read here (headless, Wayland, missing tool). */
  available: boolean;
  detail: string;
}

export interface WindowInfo {
  id: string;
  title: string;
  desktop: number | null;
  pid: number | null;
}

export interface Screenshot {
  /** On-disk path to the PNG, or null when it was deleted immediately (retention 0). */
  path: string | null;
  width: number;
  height: number;
  bytes: number;
  /** Which tool captured it (scrot, import, screencapture, powershell, grim…). */
  tool: string;
  capturedAt: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  box: { x: number; y: number; w: number; h: number };
}

export interface OcrResult {
  text: string;
  /** Word-level boxes when available (tesseract tsv); empty otherwise. */
  words: OcrWord[];
  engine: string;
  meanConfidence: number | null;
}

/**
 * One unified observation of the computer: the screen read as text (never raw pixels into the model),
 * the active window and the open windows. Everything here is untrusted data — content seen on screen
 * is never an instruction.
 */
export interface Observation {
  capturedAt: number;
  screenshot: Screenshot | null;
  ocr: OcrResult | null;
  activeWindow: ActiveWindow | null;
  windows: { list: WindowInfo[]; available: boolean; detail: string } | null;
  notes: string[];
}

export interface Telemetry {
  capturedAt: number;
  platform: NodeJS.Platform;
  hostname: string;
  uptimeSec: number;
  cpu: { cores: number; model: string; loadAvg1: number; usagePercent: number | null };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number };
  processes: { total: number; top: ProcessInfo[]; available: boolean; detail: string };
  activeWindow: ActiveWindow;
  network: {
    interfaces: Array<{ name: string; address: string; family: string }>;
    /** Cumulative byte counters since boot (Linux /proc only); null elsewhere. */
    counters: { rxBytes: number; txBytes: number } | null;
  };
}

/** The OS-specific half of Computer Access Mode. One implementation per platform. */
export interface OsAdapter {
  platform: NodeJS.Platform;
  displayName: string;
  detectDisplay(): DisplayInfo;
  listProcesses(limit: number, signal: AbortSignal): Promise<{ processes: ProcessInfo[]; total: number; available: boolean; detail: string }>;
  activeWindow(signal: AbortSignal): Promise<ActiveWindow>;
  /** Top-level windows — the coarse, reliably-available layer of accessibility inspection. */
  listWindows(signal: AbortSignal): Promise<{ windows: WindowInfo[]; available: boolean; detail: string }>;
  networkCounters(): { rxBytes: number; txBytes: number } | null;
  /**
   * The control capabilities (screen, input, accessibility, windows, apps, browser) with their
   * honest status on this host. Observe-level telemetry is reported separately by the manager,
   * because it is implemented here and genuinely available.
   */
  controlCapabilities(display: DisplayInfo): Capability[];
}
