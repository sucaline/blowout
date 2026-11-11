// Runs in BOTH the app window and the embedded browser. It finds every <video>/<audio>
// on the page and reroutes its sound through:
//
//   media ─► low-shelf (bass) ─► drive (loudness) ─► clipper ─► output volume ─► speakers
//
// Nothing is downloaded or saved; the page plays as normal and we mangle it on the way out.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

const hello = ipcRenderer.sendSync('boost:hello'); // { role: 'host' | 'guest', params }

const NEUTRAL = { on: false, bass: 0, freq: 120, loud: 0, clip: 'hard', out: 1 };
let params = hello.params || NEUTRAL;

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
let input, shelf, drive, shaper, master, preClip, postClip;
let appliedCurve;
const hooked = new Set();

function build() {
  ctx = new AudioContext();
  input = ctx.createGain();
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

  input.connect(shelf).connect(drive).connect(shaper).connect(master).connect(ctx.destination);
  drive.connect(preClip);
  shaper.connect(postClip);
  apply(true);
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

function hook(el) {
  if (hooked.has(el)) return;
  hooked.add(el);
  if (!ctx) build();
  try {
    ctx.createMediaElementSource(el).connect(input);
  } catch {
    return; // something else already owns this element's audio
  }
  const wake = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
  el.addEventListener('play', wake);
  el.addEventListener('playing', wake);
  wake();
}

// ---- metering: 48 log-spaced bars from 30 Hz to 16 kHz, plus the pre-clip peak ----
const BARS = 48;
let freqData, timeData, edges;
let wasActive = false;

function measure() {
  if (!freqData) {
    freqData = new Uint8Array(postClip.frequencyBinCount);
    timeData = new Float32Array(preClip.fftSize);
    const hzPerBin = ctx.sampleRate / postClip.fftSize;
    edges = [];
    for (let i = 0; i <= BARS; i++) edges.push((30 * (16000 / 30) ** (i / BARS)) / hzPerBin);
  }
  postClip.getByteFrequencyData(freqData);
  preClip.getFloatTimeDomainData(timeData);
  const bars = [];
  for (let i = 0; i < BARS; i++) {
    const from = Math.floor(edges[i]);
    const to = Math.max(from + 1, Math.ceil(edges[i + 1]));
    let peak = 0;
    for (let b = from; b < to && b < freqData.length; b++) if (freqData[b] > peak) peak = freqData[b];
    bars.push(peak);
  }
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = Math.abs(timeData[i]);
    if (v > peak) peak = v;
  }
  return { bars, peak };
}

setInterval(() => {
  for (const el of document.querySelectorAll('video, audio')) hook(el);
  let active = false;
  for (const el of hooked) {
    if (!el.paused && !el.ended && el.readyState > 2) active = true;
  }
  if (!ctx) return;
  if (active) ipcRenderer.send('boost:meter', measure());
  else if (wasActive) ipcRenderer.send('boost:meter', { bars: new Array(BARS).fill(0), peak: 0 });
  wasActive = active;
}, 40);

ipcRenderer.on('boost:params', (_event, next) => {
  params = next || NEUTRAL;
  apply(false);
});

ipcRenderer.on('boost:pause', () => {
  for (const el of hooked) el.pause();
});

if (hello.role === 'guest') {
  // Some players (Spotify) keep their <video>/<audio> out of the page, where the scan above
  // can't see it. So the page's own play() hands us each element the moment it starts.
  contextBridge.exposeInMainWorld('__blowoutHook', (el) => {
    if (el instanceof HTMLMediaElement) hook(el);
  });
  webFrame.executeJavaScript(`(() => {
    const hook = window.__blowoutHook;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { hook(this); } catch {}
      return play.apply(this, arguments);
    };
  })()`);
}

if (hello.role === 'host') {
  contextBridge.exposeInMainWorld('boost', {
    setParams: (next) => ipcRenderer.send('boost:params', next),
    pauseWeb: () => ipcRenderer.send('boost:pause-web'),
    onMeter: (callback) => ipcRenderer.on('boost:meter', (_event, meter) => callback(meter)),
  });
}
