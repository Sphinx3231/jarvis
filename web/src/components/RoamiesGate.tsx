import { Download, FolderSearch, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type RoamiesRequirement } from '../lib/api';
import { Button } from './ui';

export const ROAMIES_URL = 'https://github.com/KenKaiii/Roamies';
export const JARVIS_SOURCE_URL = 'https://github.com/Sphinx3231/jarvis';

/**
 * Jarvis runs on Roamies. Until Roamies is found on this computer, the whole app is this screen:
 * a download link and Check again. It looks again by itself every few seconds as well.
 */
export function RoamiesGate({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<RoamiesRequirement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (recheck: boolean) => {
    try {
      const r = recheck ? await api.post<RoamiesRequirement>('/api/roamies/check') : await api.get<RoamiesRequirement>('/api/roamies');
      setReq(r);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Jarvis is not responding.');
    }
  }, []);

  useEffect(() => {
    if (!api.hasToken()) return;
    void load(false);
    const onLocked = () => void load(true);
    window.addEventListener('jarvis-locked', onLocked);
    return () => window.removeEventListener('jarvis-locked', onLocked);
  }, [load]);

  // While locked, look again every few seconds (a local file check, no network).
  useEffect(() => {
    if (!req || req.met) return;
    const t = setInterval(() => void load(true), 4000);
    return () => clearInterval(t);
  }, [req, load]);

  if (!api.hasToken() || (req?.met ?? false)) return <>{children}</>;
  if (!req) return error ? <LockShell><p className="lock-error">{error}</p></LockShell> : null;

  const checkAgain = async () => {
    setChecking(true);
    await load(true);
    setChecking(false);
  };
  return (
    <LockShell>
      <h1>Jarvis runs on Roamies</h1>
      <p className="lock-lead">
        Jarvis is built on <strong>Roamies</strong> — it thinks with the same engine, the same model and the same sign-ins. Install Roamies on this computer, open it once to sign in, then come back here.
      </p>
      <div className="lock-actions">
        <a className="btn btn--primary btn--md" href={req.downloadUrl} target="_blank" rel="noreferrer">
          <Download size={16} /> Download Roamies
        </a>
        <Button icon={<RefreshCw size={15} />} busy={checking} onClick={() => void checkAgain()}>
          Check again
        </Button>
      </div>
      <p className="lock-note">Jarvis checks again by itself every few seconds — you don’t need to restart it.</p>
      <button
        type="button"
        className="lock-link"
        onClick={() => void api.post<RoamiesRequirement>('/api/roamies/use-openjarvis').then(setReq).catch(() => undefined)}
      >
        Run fully local with OpenJarvis instead (no Roamies, no API keys)
      </button>
      <Elsewhere onFound={setReq} />
      <details className="lock-details">
        <summary>Where Jarvis looked</summary>
        <ul>
          {req.detection.searched.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      </details>
    </LockShell>
  );
}

function Elsewhere({ onFound }: { onFound: (r: RoamiesRequirement) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" className="lock-link" onClick={() => setOpen(true)}>
        <FolderSearch size={14} /> Installed it somewhere else?
      </button>
    );
  }
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onFound(await api.put<RoamiesRequirement>('/api/roamies/location', { path }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="lock-elsewhere"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="roamies-path">Full path to the Roamies app</label>
      <div className="row">
        <input id="roamies-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Applications/Roamies.app or C:\Users\…\Roamies.exe" spellCheck={false} />
        <Button type="submit" busy={busy} disabled={!path.trim()}>
          Use this
        </Button>
      </div>
      {error && <p className="lock-error">{error}</p>}
    </form>
  );
}

function LockShell({ children }: { children: ReactNode }) {
  return (
    <div className="lock">
      <div className="lock-card">
        <img src="/icon-192.png" alt="Jarvis, the purple dragon" width={88} height={88} />
        {children}
      </div>
      <p className="lock-foot">
        Jarvis is free software under the GNU AGPL v3, built on{' '}
        <a href={ROAMIES_URL} target="_blank" rel="noreferrer">
          Roamies
        </a>{' '}
        by KenKaiii ·{' '}
        <a href={JARVIS_SOURCE_URL} target="_blank" rel="noreferrer">
          Source code
        </a>
      </p>
    </div>
  );
}
