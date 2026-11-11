// `components` only exists in the castlabs Electron build, which adds the Widevine DRM
// module that Spotify's web player needs. Stock Electron runs everything except Spotify.
const { app, BrowserWindow, components, ipcMain, session, webContents } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, 'preload.js');
const PARTITION = 'persist:blowout';
const isWeb = (url) => /^https?:\/\//i.test(url);
const SELFTEST = process.argv.includes('--selftest');
// Test runs get a throwaway profile so they never touch your real settings or sign-ins.
if (SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), 'blowout-selftest'));

// Let pages (and our audio graph) start sound without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Look like plain Chrome so sites serve their normal player.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, 'i'), '');
// Note: Google refuses account sign-in from any browser embedded in an app, this one included.
// YouTube and YouTube Music still play signed out.

let win = null;
let params = null; // latest settings from the UI; handed to every page as it loads

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0a0a0b',
    title: 'BLOWOUT',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, webviewTag: true },
  });

  // The embedded browser always gets our preload, sandboxed, with no Node access.
  win.webContents.on('will-attach-webview', (event, prefs, attrs) => {
    delete prefs.preloadURL;
    prefs.preload = PRELOAD;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (attrs.src && attrs.src !== 'about:blank' && !isWeb(attrs.src)) event.preventDefault();
  });

  // The app window itself never navigates anywhere (e.g. a file dropped on it).
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });

  win.loadFile('index.html');
}

app.on('web-contents-created', (_event, wc) => {
  if (wc.getType() !== 'webview') return;
  // Links that want a new window open in the same view; only http(s) is allowed.
  wc.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event) => { if (!isWeb(event.url)) event.preventDefault(); });
});

// Fetch/enable Widevine before any page loads. The first launch downloads it from Google.
async function loadWidevine() {
  if (!components) return;
  const giveUp = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), 20000));
  try {
    await Promise.race([components.whenReady(), giveUp]);
  } catch (err) {
    console.warn('Widevine is unavailable, so Spotify will not play:', err.message || err);
  }
}

const isHost = (event) => win && event.sender === win.webContents;

ipcMain.on('boost:hello', (event) => {
  event.returnValue = { role: isHost(event) ? 'host' : 'guest', params };
});

ipcMain.on('boost:params', (event, next) => {
  if (!isHost(event)) return;
  params = next;
  for (const wc of webContents.getAllWebContents()) wc.send('boost:params', params);
});

ipcMain.on('boost:pause-web', (event) => {
  if (!isHost(event)) return;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'webview') wc.send('boost:pause');
  }
});

ipcMain.on('boost:track', (event, track) => {
  if (win && !isHost(event)) win.webContents.send('boost:track', track);
});

ipcMain.on('boost:control', (event, command) => {
  if (!isHost(event)) return;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'webview') wc.send('boost:control', command);
  }
});

require('./lyrics')(isHost);

ipcMain.on('boost:meter', (event, meter) => {
  if (!win) return;
  win.webContents.send('boost:meter', { ...meter, role: isHost(event) ? 'host' : 'guest' });
});

app.whenReady().then(async () => {
  const web = session.fromPartition(PARTITION);
  // Sites inside the app get fullscreen and DRM playback, nothing else (no mic, location…).
  web.setPermissionRequestHandler((_wc, permission, done) => {
    done(permission === 'fullscreen' || permission === 'protected-media-identifier');
  });
  await loadWidevine();
  createWindow();
  if (SELFTEST) require('./selftest')(win);
});

app.on('window-all-closed', () => app.quit());
