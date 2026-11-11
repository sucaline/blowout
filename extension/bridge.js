// BLOWOUT Link: carries messages between the music page (page.js) and the extension's
// background worker (sw.js), which holds the connection to the BLOWOUT app.
let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'page' });
  port.onMessage.addListener((message) => {
    document.dispatchEvent(new CustomEvent('blowout:in', { detail: JSON.stringify(message) }));
  });
  port.onDisconnect.addListener(() => { port = null; });
}

document.addEventListener('blowout:out', (event) => {
  try {
    if (!port) connect();
    port.postMessage(JSON.parse(event.detail));
  } catch {
    port = null; // the extension was reloaded or updated; this tab needs a refresh to rejoin
  }
});
