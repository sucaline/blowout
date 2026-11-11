const state = document.getElementById('state');
const help = document.getElementById('help');

function show(status) {
  const linked = Boolean(status && status.linked);
  state.classList.toggle('on', linked);
  state.textContent = linked ? 'Linked to the BLOWOUT app' : 'BLOWOUT app not found';
  help.textContent = linked
    ? 'Play something on YouTube Music, YouTube or Spotify in this browser. The app controls the boost and shows the lyrics.'
    : 'Open the BLOWOUT app on this PC. It links by itself within a few seconds. Tabs that were open before you installed this need a refresh.';
}

function check() {
  chrome.runtime.sendMessage({ type: 'status' }, (status) => {
    void chrome.runtime.lastError; // worker still starting: treat as not linked yet
    show(status);
  });
}

check();
setInterval(check, 1500);
