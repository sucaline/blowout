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
const CHROME_UA = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, 'i'), '');
app.userAgentFallback = CHROME_UA;

// Google turns away sign-ins from browsers embedded in apps ("this browser or app may not
// be secure") but accepts Firefox, so its sign-in pages alone are shown a Firefox identity.
// You still type your own details straight into Google's real page; the app never sees them.
const FIREFOX_OS = { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10.15' };
const FIREFOX_UA = `Mozilla/5.0 (${FIREFOX_OS[process.platform] || 'X11; Linux x86_64'}; rv:150.0) Gecko/20100101 Firefox/150.0`;
const GOOGLE_SIGN_IN = 'https://accounts.google.com/';

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
  const matchUserAgent = (url) => {
    const ua = url.startsWith(GOOGLE_SIGN_IN) ? FIREFOX_UA : CHROME_UA;
    if (wc.getUserAgent() !== ua) wc.setUserAgent(ua);
  };
  wc.on('will-navigate', (event) => {
    if (!isWeb(event.url)) event.preventDefault();
    else if (event.isMainFrame) matchUserAgent(event.url);
  });
  wc.on('will-redirect', (event) => { if (event.isMainFrame) matchUserAgent(event.url); });
  wc.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) matchUserAgent(event.url);
  });
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
  web.webRequest.onBeforeSendHeaders({ urls: [`${GOOGLE_SIGN_IN}*`] }, (details, done) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(name)) delete headers[name]; // Firefox doesn't send these
    }
    headers['User-Agent'] = FIREFOX_UA;
    done({ requestHeaders: headers });
  });
  await loadWidevine();
  createWindow();
  if (SELFTEST) require('./selftest')(win);
});

app.on('window-all-closed', () => app.quit());
