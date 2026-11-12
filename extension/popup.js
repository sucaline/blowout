const state = document.getElementById('state');
const help = document.getElementById('help');

function show(status) {
  const linked = Boolean(status && status.linked);
  state.classList.toggle('on', linked);
  state.textContent = linked ? 'Linked to the BLOWOUT app' : 'Standalone (no app needed)';
  help.textContent = linked
    ? 'Play something on YouTube Music, YouTube or Spotify in this browser. The app controls the boost and shows the lyrics.'
    : 'Use the BLOWOUT button in the corner of the music page to boost it. Optional: open the BLOWOUT app on this PC and it takes over with lyrics and controls. Tabs open before you installed this need a refresh.';
}

function check() {
  chrome.runtime.sendMessage({ type: 'status' }, (status) => {
    void chrome.runtime.lastError; // worker still starting: treat as not linked yet
    show(status);
  });
}

check();
setInterval(check, 1500);
