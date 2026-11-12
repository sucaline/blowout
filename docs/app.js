// BLOWOUT for phones: the same chain as the desktop app, for audio files you pick.
//
//   <audio> ─► low-shelf (bass) ─► drive (loudness) ─► clipper ─► output volume ─► speakers
//
// Everything stays on the device; nothing is uploaded.
const $ = (id) => document.getElementById(id);
const local = $('local');

// ---------- settings ----------
const PRESETS = {
  warm: { bass: 8, freq: 100, loud: 3, clip: 'soft' },
  boosted: { bass: 16, freq: 120, loud: 9, clip: 'soft' },
  fried: { bass: 26, freq: 140, loud: 20, clip: 'hard' },
  earrape: { bass: 40, freq: 180, loud: 40, clip: 'square' },
};
const params = { on: true, ...PRESETS.fried, out: 0.5 };
try {
  Object.assign(params, JSON.parse(localStorage.getItem('params')) || {});
} catch { /* first run, or storage is blocked: keep defaults */ }

// ---------- audio engine ----------
function makeCurve(fn) {
  const n = 4097; // odd, so silence maps to exactly 0
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fn((i / (n - 1)) * 2 - 1);
  return curve;
}
// A WaveShaper clamps anything past the ends of its curve, so a straight line is a hard clip.
const CURVES = {
  hard: new Float32Array([-1, 1]),
  soft: makeCurve((x) => Math.tanh(2.5 * x) / Math.tanh(2.5)),
  square: makeCurve((x) => Math.tanh(40 * x)),
};

let ctx = null;
let shelf, drive, shaper, master, preClip, postClip, appliedCurve;

// Phones only allow sound to start from a tap, so this is called from tap handlers.
function wake() {
  if (!ctx) {
    // Play like a music app: ignore the silent switch and keep going with the screen off.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    drive = ctx.createGain();
    shaper = ctx.createWaveShaper();
    master = ctx.createGain();
    preClip = ctx.createAnalyser(); // how far over full scale we're pushing
    preClip.fftSize = 2048;
    postClip = ctx.createAnalyser(); // what it sounds like after the clipper
    postClip.fftSize = 4096;
    postClip.smoothingTimeConstant = 0.6;
    ctx.createMediaElementSource(local).connect(shelf);
    shelf.connect(drive);
    drive.connect(shaper);
    shaper.connect(master);
    master.connect(ctx.destination);
    drive.connect(preClip);
    shaper.connect(postClip);
    apply(true);
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

function apply(instant) {
  if (!ctx) return;
  const on = params.on;
  const set = (param, value) => {
    if (instant) param.value = value;
    else param.setTargetAtTime(value, ctx.currentTime, 0.02);
  };
  set(shelf.frequency, params.freq);
  set(shelf.gain, on ? params.bass : 0);
  set(drive.gain, on ? 10 ** (params.loud / 20) : 1);
  set(master.gain, on ? params.out : 1);
  const curve = on ? CURVES[params.clip] || CURVES.hard : null;
  if (curve !== appliedCurve) {
    shaper.curve = curve;
    appliedCurve = curve;
  }
}

// ---------- controls ----------
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
    s.el.style.setProperty('--fill', `${((value - s.el.min) / (s.el.max - s.el.min)) * 100}%`);
  }
  $('power').setAttribute('aria-pressed', String(params.on));
  $('power').textContent = params.on ? 'BOOST: ON' : 'BOOST: OFF';
  for (const b of document.querySelectorAll('[data-clip]')) {
    b.classList.toggle('active', b.dataset.clip === params.clip);
  }
}

function update(changes) {
  Object.assign(params, changes);
  try {
    localStorage.setItem('params', JSON.stringify(params));
  } catch { /* storage is blocked (private browsing): settings just won't be remembered */ }
  apply(false);
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

// ---------- player ----------
let objectUrl = null;
let statusTimer;

function showStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function play() {
  wake();
  // If the phone refuses (no recent tap), the play button is right there.
  local.play().catch(() => {});
}

function openFile(file) {
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  const title = file.name.replace(/\.[^.]+$/, '');
  $('file-name').textContent = title;
  $('play').disabled = false;
  $('seek').disabled = false;
  local.src = objectUrl;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'BLOWOUT' });
  }
  play();
}

$('pick').addEventListener('click', () => {
  wake();
  $('file-input').click();
});
$('file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});

const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const seek = $('seek');
let seeking = false;

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
  if (local.src) showStatus("Couldn't play that file. Try an .mp3, .m4a or .wav.");
});
$('play').addEventListener('click', () => {
  if (local.paused) play();
  else local.pause();
});
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
// Coming back from a phone call or another app can leave the audio engine paused.
document.addEventListener('visibilitychange', () => {
  if (ctx && !document.hidden && !local.paused) wake();
});

// ---------- meter: 40 log-spaced bars from 30 Hz to 16 kHz, plus the pre-clip peak ----------
const BARS = 40;
const canvas = $('bars');
const g = canvas.getContext('2d');
let freqData, timeData, edges;
let clipUntil = 0;

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  g.clearRect(0, 0, w, h);

  if (ctx && !local.paused) {
    if (!freqData) {
      freqData = new Uint8Array(postClip.frequencyBinCount);
      timeData = new Float32Array(preClip.fftSize);
      const hzPerBin = ctx.sampleRate / postClip.fftSize;
      edges = [];
      for (let i = 0; i <= BARS; i++) edges.push((30 * (16000 / 30) ** (i / BARS)) / hzPerBin);
    }
    postClip.getByteFrequencyData(freqData);
    preClip.getFloatTimeDomainData(timeData);

    const gap = dpr;
    const bw = (w - gap * (BARS - 1)) / BARS;
    for (let i = 0; i < BARS; i++) {
      const from = Math.floor(edges[i]);
      const to = Math.max(from + 1, Math.ceil(edges[i + 1]));
      let top = 0;
      for (let b = from; b < to && b < freqData.length; b++) if (freqData[b] > top) top = freqData[b];
      const level = top / 255;
      const bh = Math.max(dpr, level * h);
      g.fillStyle = level > 0.9 ? barColors.hot : level > 0.7 ? barColors.mid : barColors.low;
      g.fillRect(i * (bw + gap), h - bh, bw, bh);
    }

    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = Math.abs(timeData[i]);
      if (v > peak) peak = v;
    }
    if (peak >= 1) {
      clipUntil = performance.now() + 250;
      $('over').textContent = `${(20 * Math.log10(peak)).toFixed(1)} dB over`;
    }
  }

  const clipping = performance.now() < clipUntil;
  $('clip-light').classList.toggle('on', clipping);
  if (!clipping && $('over').textContent.trim()) $('over').innerHTML = '&nbsp;';
  requestAnimationFrame(draw);
}

// ---------- install ----------
const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
$('install-tip').hidden = Boolean(installed);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
renderTransport();
requestAnimationFrame(draw);

// ---------- looks and settings ----------
let barColors = { hot: '#ff3d1f', mid: '#ff9a1f', low: '#ffd600' };
const store = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch { /* storage can be blocked; settings just won't stick */ }
  return null;
};
function applyLook(name) {
  if (name !== 'starrail' && name !== 'material') name = 'blowout';
  document.body.dataset.theme = name;
  store('look', name);
  for (const b of document.querySelectorAll('#look button')) b.classList.toggle('active', b.dataset.theme === name);
  const css = getComputedStyle(document.body);
  const pick = (v, d) => css.getPropertyValue(v).trim() || d;
  barColors = { hot: pick('--hot', '#ff3d1f'), mid: pick('--mid', '#ff9a1f'), low: pick('--volt', '#ffd600') };
}
function applyAccent(hex) {
  // Material 3 colors worked out from one hue (a simple stand-in for Google's tonal palettes).
  const n = parseInt(hex.slice(1), 16);
  const [R, G, B] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = Math.round((h * 60 + 360) % 360);
  const c = (hue, s, l) => `hsl(${(hue + 360) % 360} ${s}% ${l}%)`;
  const vars = {
    '--m-primary': c(h, 85, 82), '--m-on-primary': c(h, 60, 20), '--m-secondary-container': c(h, 18, 28),
    '--m-on-secondary-container': c(h, 30, 90), '--m-tertiary': c(h + 55, 60, 80), '--m-surface': c(h, 12, 8),
    '--m-surface-1': c(h, 10, 12), '--m-surface-3': c(h, 8, 20), '--m-on-surface': c(h, 15, 90),
    '--m-on-surface-variant': c(h, 10, 75), '--m-outline-variant': c(h, 8, 28),
  };
  for (const [k, val] of Object.entries(vars)) document.body.style.setProperty(k, val);
  store('accent', hex);
  document.getElementById('accent').value = hex;
  applyLook(document.body.dataset.theme);
}
for (const b of document.querySelectorAll('#look button')) b.addEventListener('click', () => applyLook(b.dataset.theme));
document.getElementById('accent').addEventListener('input', (e) => applyAccent(e.target.value));
const calmBtn = document.getElementById('set-calm');
const showCalm = () => {
  const on = store('calm') === 'on';
  calmBtn.setAttribute('aria-checked', on);
  document.body.classList.toggle('calm', on);
};
calmBtn.addEventListener('click', () => { store('calm', store('calm') === 'on' ? 'off' : 'on'); showCalm(); });
document.getElementById('set-reset').addEventListener('click', () => {
  try { localStorage.clear(); } catch { /* nothing to clear */ }
  location.reload();
});
showCalm();
applyAccent(store('accent') || '#6750a4');
applyLook(store('look'));

// ---------- bookmark for boosting YouTube Music in Safari ----------
document.getElementById('bm-copy').addEventListener('click', async () => {
  const note = document.getElementById('bm-note');
  note.hidden = false;
  try {
    const code = await (await fetch('bookmarklet.txt', { cache: 'no-cache' })).text();
    await navigator.clipboard.writeText(code);
    document.getElementById('bm-copy').textContent = 'COPIED. NOW DO STEPS 2 TO 4';
    note.textContent = 'Copied. It is a long code; that is normal.';
  } catch {
    note.textContent = 'Could not copy. Open bookmarklet.txt on this site, select all of it, and copy it by hand.';
  }
});

// ---------- speed ----------
const speedInput = $('speed');
const keepBtn = $('keep-pitch');
const applySpeed = () => {
  const speed = Number(speedInput.value) / 100;
  const keep = store('keepPitch') !== 'off';
  local.playbackRate = speed;
  local.preservesPitch = keep; // keeps the pitch where it was: no chipmunk or slurred sound
  local.webkitPreservesPitch = keep; // older Safari
  $('speed-out').textContent = speed.toFixed(2) + 'x';
  keepBtn.setAttribute('aria-checked', keep);
  speedInput.style.setProperty('--fill', ((speedInput.value - 50) / 150) * 100 + '%');
};
speedInput.value = Math.round((Number(store('speed')) || 1) * 100);
speedInput.addEventListener('input', () => { store('speed', Number(speedInput.value) / 100); applySpeed(); });
keepBtn.addEventListener('click', () => { store('keepPitch', store('keepPitch') === 'off' ? 'on' : 'off'); applySpeed(); });
local.addEventListener('loadedmetadata', applySpeed); // a new song resets the rate; put it back
local.addEventListener('play', applySpeed);
applySpeed();
