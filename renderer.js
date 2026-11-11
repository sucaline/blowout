const $ = (id) => document.getElementById(id);

const stage = $('stage');
const view = $('view');
const local = $('local');
const address = $('address');

// ---------- settings ----------
const PRESETS = {
  warm: { bass: 8, freq: 100, loud: 3, clip: 'soft' },
  boosted: { bass: 16, freq: 120, loud: 9, clip: 'soft' },
  fried: { bass: 26, freq: 140, loud: 20, clip: 'hard' },
  earrape: { bass: 40, freq: 180, loud: 40, clip: 'square' },
};
const DEFAULTS = { on: true, ...PRESETS.fried, out: 0.5 };

let params = { ...DEFAULTS };
try {
  Object.assign(params, JSON.parse(localStorage.getItem('params')) || {});
} catch { /* first run or unreadable settings: keep defaults */ }

const sliders = {
  bass: { el: $('bass'), out: $('bass-out'), text: (v) => `+${v} dB` },
  freq: { el: $('freq'), out: $('freq-out'), text: (v) => `below ${v} Hz` },
  loud: { el: $('loud'), out: $('loud-out'), text: (v) => `+${v} dB` },
  out: { el: $('out'), out: $('out-out'), text: (v) => `${v}%`, scale: 100 },
};

function render() {
  for (const [key, s] of Object.entries(sliders)) {
    const value = Math.round(params[key] * (s.scale || 1));
    s.el.value = value;
    s.out.textContent = s.text(value);
    const fill = ((value - s.el.min) / (s.el.max - s.el.min)) * 100;
    s.el.style.setProperty('--fill', `${fill}%`);
  }
  $('power').setAttribute('aria-pressed', String(params.on));
  $('power').textContent = params.on ? 'BOOST: ON' : 'BOOST: OFF';
  for (const b of document.querySelectorAll('[data-clip]')) {
    b.classList.toggle('active', b.dataset.clip === params.clip);
  }
}

function update(changes) {
  Object.assign(params, changes);
  localStorage.setItem('params', JSON.stringify(params));
  window.boost.setParams(params);
  render();
}

for (const [key, s] of Object.entries(sliders)) {
  s.el.addEventListener('input', () => update({ [key]: Number(s.el.value) / (s.scale || 1) }));
}
$('power').addEventListener('click', () => update({ on: !params.on }));
for (const b of document.querySelectorAll('[data-clip]')) {
  b.addEventListener('click', () => update({ clip: b.dataset.clip }));
}
for (const b of document.querySelectorAll('[data-preset]')) {
  // Presets leave the output volume alone: that one is yours.
  b.addEventListener('click', () => update({ on: true, ...PRESETS[b.dataset.preset] }));
}

// ---------- links ----------
let statusTimer;
function showStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  const spotify = /^spotify:(\w+):(\w+)$/i.exec(t); // "Copy Spotify URI" links
  if (spotify) return `https://open.spotify.com/${spotify[1]}/${spotify[2]}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`;
}

function openLink(text) {
  const url = toUrl(text);
  if (!url) return;
  local.pause();
  stage.dataset.view = 'web';
  view.src = url;
}

$('go-form').addEventListener('submit', (e) => {
  e.preventDefault();
  openLink(address.value);
  address.blur();
});
for (const b of document.querySelectorAll('[data-url]')) {
  b.addEventListener('click', () => openLink(b.dataset.url));
}
$('back').addEventListener('click', () => {
  if (stage.dataset.view === 'web' && view.canGoBack()) view.goBack();
});

function showCurrentUrl(e) {
  if (e.isMainFrame === false || e.url === 'about:blank') return;
  if (document.activeElement !== address) address.value = e.url;
}
view.addEventListener('did-navigate', showCurrentUrl);
view.addEventListener('did-navigate-in-page', showCurrentUrl);
view.addEventListener('did-fail-load', (e) => {
  if (e.isMainFrame && e.errorCode !== -3) showStatus(`Couldn't load that page (${e.errorDescription}).`);
});

// ---------- local files ----------
let objectUrl = null;

function openFile(file) {
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  window.boost.pauseWeb();
  $('file-name').textContent = file.name.replace(/\.[^.]+$/, '');
  stage.dataset.view = 'file';
  local.src = objectUrl;
  local.play().catch(() => {});
}

$('open-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});

let dragDepth = 0;
const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  openFile(e.dataTransfer.files[0]);
});

const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const seek = $('seek');
let seeking = false;

function togglePlay() {
  if (local.paused) local.play().catch(() => {});
  else local.pause();
}
function renderTransport() {
  $('play').innerHTML = local.paused ? '&#9654;' : '&#10074;&#10074;';
  $('time-now').textContent = fmt(local.currentTime);
  $('time-total').textContent = fmt(local.duration);
  if (!seeking) seek.value = local.duration ? (local.currentTime / local.duration) * 1000 : 0;
  seek.style.setProperty('--fill', `${seek.value / 10}%`);
}
for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'ended']) {
  local.addEventListener(type, renderTransport);
}
local.addEventListener('error', () => {
  if (local.src) showStatus("Couldn't play that file. Try an .mp3, .wav, .flac, .ogg or .m4a.");
});
$('play').addEventListener('click', togglePlay);
seek.addEventListener('input', () => {
  seeking = true;
  seek.style.setProperty('--fill', `${seek.value / 10}%`);
});
seek.addEventListener('change', () => {
  if (local.duration) local.currentTime = (seek.value / 1000) * local.duration;
  seeking = false;
});
$('loop').addEventListener('click', (e) => {
  local.loop = !local.loop;
  e.currentTarget.setAttribute('aria-pressed', String(local.loop));
});
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|BUTTON)$/.test(document.activeElement.tagName);
  if (e.code === 'Space' && !typing && stage.dataset.view === 'file') {
    e.preventDefault();
    togglePlay();
  }
});

// ---------- meter ----------
const canvas = $('bars');
const g = canvas.getContext('2d');
let meter = { bars: [], peak: 0 };
let clipUntil = 0;
let meterAt = 0;

window.boost.onMeter((m) => {
  meter = m;
  meterAt = performance.now();
  if (m.peak >= 1) {
    clipUntil = performance.now() + 250;
    $('over').textContent = `${(20 * Math.log10(m.peak)).toFixed(1)} dB over`;
  }
});

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  g.clearRect(0, 0, w, h);
  // A page that navigates away never sends a final "silent" frame, so stale bars time out.
  if (performance.now() - meterAt > 300) meter = { bars: [], peak: 0 };
  const n = meter.bars.length;
  if (n) {
    const gap = dpr;
    const bw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const level = meter.bars[i] / 255;
      const bh = Math.max(dpr, level * h);
      g.fillStyle = level > 0.9 ? '#ff3d1f' : level > 0.7 ? '#ff9a1f' : '#ffd600';
      g.fillRect(i * (bw + gap), h - bh, bw, bh);
    }
  }
  const clipping = performance.now() < clipUntil;
  $('clip-light').classList.toggle('on', clipping);
  if (!clipping && $('over').textContent.trim()) $('over').innerHTML = '&nbsp;';
  requestAnimationFrame(draw);
}

render();
renderTransport();
window.boost.setParams(params);
requestAnimationFrame(draw);
