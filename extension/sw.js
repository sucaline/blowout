// BLOWOUT Link: the background worker. It holds one connection to the BLOWOUT app on this
// computer and passes messages between the app and the music tabs.
const APP = 'ws://127.0.0.1:38765';
const RETRY_MS = 10000;

const ports = new Set(); // one per open music tab
let active = null; // the tab that is actually playing; the app follows and controls this one
let socket = null;
let triedAt = 0;
let params = null; // latest settings from the app, for tabs opened later

const linked = () => Boolean(socket && socket.readyState === WebSocket.OPEN);

function badge(text) {
  if (!chrome.action) return; // browsers without a toolbar button
  chrome.action.setBadgeBackgroundColor({ color: '#ff3d1f' });
  chrome.action.setBadgeText({ text });
}

function toPages(message, only) {
  for (const port of only ? [only] : ports) {
    try {
      port.postMessage(message);
    } catch { /* that tab just closed */ }
  }
}

function connect() {
  if (socket || Date.now() - triedAt < RETRY_MS) return;
  triedAt = Date.now();
  const ws = new WebSocket(APP);
  socket = ws;
  ws.onopen = () => badge('ON');
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'params') params = message.params;
    // Play/pause/seek go to the tab that's playing; everything else goes to every tab.
    toPages(message, message.type === 'control' && ports.has(active) ? active : null);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    params = null;
    badge('');
    toPages({ type: 'params', params: null }); // app closed: hand the audio back untouched
  };
  ws.onerror = () => {}; // the app isn't open; onclose follows and we retry later
}

chrome.runtime.onConnect.addListener((port) => {
  ports.add(port);
  if (params) port.postMessage({ type: 'params', params });
  port.onMessage.addListener((message) => {
    connect();
    if (message.type === 'track' && !message.track.paused) active = port;
    // Only the playing tab reports, so two open tabs don't fight over the app's screen.
    if (linked() && (!active || port === active)) socket.send(JSON.stringify(message));
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (active === port) active = null;
  });
});

// The toolbar popup asks whether the app is connected.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message && message.type === 'status') {
    connect();
    respond({ linked: linked(), tabs: ports.size });
  }
});
