/**
 * Jarvis desktop app (Electron).
 *
 * The Jarvis service runs as a child process using Electron's built-in Node.js, so the installed
 * app needs nothing else on the computer. The window shows the same UI the service serves on
 * 127.0.0.1. Closing the window keeps Jarvis working from the tray; "Quit Jarvis" stops it safely.
 */
const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, session, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'dist-server', 'main.js');
const ICON = path.join(ROOT, 'web', 'dist', 'icon-512.png');
const TRAY_ICON = path.join(ROOT, 'web', 'dist', 'icon-32.png');
const SMOKE = process.env.JARVIS_SMOKE_TEST === '1';

// Chromium's sandbox cannot run as root, so Electron refuses to start there. On systems commonly
// used as root (e.g. Kali Linux) disable the sandbox so the app still launches; normal users keep it.
if (process.platform === 'linux' && process.getuid?.() === 0) app.commandLine.appendSwitch('no-sandbox');

let win = null;
let tray = null;
let server = null;
let serverUrl = null;
let quitting = false;
let toldAboutTray = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

function log(...args) {
  console.log('[jarvis-desktop]', ...args);
}

/** Start the service and resolve with its URL (or the URL of a Jarvis that is already running). */
function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      JARVIS_PORT: process.env.JARVIS_PORT || '0',
      JARVIS_DATA_DIR: process.env.JARVIS_DATA_DIR || path.join(os.homedir(), '.jarvis'),
    };
    server = fork(SERVER, [], { env, execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let settled = false;
    server.on('message', (msg) => {
      if (settled || !msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        settled = true;
        resolve(msg.url);
      } else if (msg.type === 'error') {
        settled = true;
        // Another Jarvis (for example `npm start`) already owns this data folder: just show it.
        if (msg.code === 'EJARVISRUNNING' && msg.url) {
          server = null;
          resolve(msg.url);
        } else reject(new Error(msg.message));
      }
    });
    server.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`The Jarvis service exited during startup (code ${code})`));
      } else if (!quitting && server) {
        log('service stopped unexpectedly with code', code);
        server = null;
        if (!SMOKE) {
          dialog.showErrorBox('Jarvis stopped', 'The Jarvis service stopped unexpectedly. Restart the app to continue; unfinished tasks will be recovered.');
        }
      }
    });
  });
}

function sameOrigin(url) {
  try {
    return serverUrl && new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

function lockDownSession() {
  const ses = session.defaultSession;
  // Microphone (for voice) and notifications only, and only for the Jarvis page itself.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    if (!sameOrigin(origin)) return callback(false);
    if (permission === 'notifications') return callback(true);
    if (permission === 'media') return callback(Array.isArray(details.mediaTypes) && details.mediaTypes.every((t) => t === 'audio'));
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => sameOrigin(origin) && (permission === 'media' || permission === 'notifications'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: 'Jarvis',
    backgroundColor: '#09070f',
    icon: ICON,
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  // Links to other sites open in the normal browser; the app window only ever shows Jarvis.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // "Open in Obsidian" links hand off to the Obsidian app.
    if (/^obsidian:\/\//.test(url) || (/^https?:\/\//.test(url) && !sameOrigin(url))) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url)) {
      event.preventDefault();
      if (/^(https?|obsidian):\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'Jarvis is still running', body: 'Jarvis keeps working in the background. Use the tray icon to open or quit.', icon: ICON }).show();
    }
  });
  win.loadURL(serverUrl);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.setToolTip('Jarvis');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Jarvis', click: showWindow },
        { type: 'separator' },
        { label: 'Quit Jarvis', click: () => app.quit() },
      ]),
    );
    tray.on('click', showWindow);
  } catch (err) {
    // Some Linux desktops have no tray: closing the window then quits instead of hiding.
    log('tray unavailable:', err.message);
    tray = null;
  }
}

// JARVIS_SMOKE_EXPECT=locked: Roamies is missing, so only the "Roamies required" screen may work.
const EXPECT_LOCKED = process.env.JARVIS_SMOKE_EXPECT === 'locked';

async function smokeTest() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const token = document.querySelector('meta[name="jarvis-token"]')?.content;
        const res = await fetch('/api/status', { headers: { 'x-jarvis-token': token } });
        const body = await res.json();
        const about = await fetch('/api/about', { headers: { 'x-jarvis-token': token } });
        return { core: !!document.querySelector('.core'), online: document.body.innerText.includes('Online'), locked: document.body.innerText.includes('Jarvis runs on Roamies'), status: res.status, about: about.status, version: body.status && body.status.version };
      })()`);
      const ok = EXPECT_LOCKED ? result.locked && result.status === 423 && result.about === 200 && !result.core : result.core && result.online && result.status === 200;
      if (ok) {
        log('SMOKE TEST PASSED', JSON.stringify(result));
        return true;
      }
    } catch {
      /* page still loading */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log('SMOKE TEST FAILED');
  return false;
}

async function start() {
  try {
    serverUrl = await startServer();
  } catch (err) {
    log('failed to start:', err.message);
    if (!SMOKE) dialog.showErrorBox('Jarvis could not start', String(err.message));
    app.exit(1);
    return;
  }
  log('service ready at', serverUrl);
  lockDownSession();
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
      : null,
  );
  createWindow();
  if (!SMOKE) createTray();
  if (SMOKE) {
    const ok = await smokeTest();
    quitting = true;
    await stopServer();
    app.exit(ok ? 0 : 1);
  }
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const child = server;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    // A graceful request lets the service record task state safely (signals are abrupt on Windows).
    try {
      child.send({ type: 'shutdown' });
    } catch {
      child.kill('SIGTERM');
    }
  });
}

app.on('activate', showWindow);
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  stopServer().then(() => app.quit());
});
