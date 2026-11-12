// Runs in BOTH the app window and the embedded browser. It finds every <video>/<audio>
// on the page and reroutes its sound through:
//
//   media ─► low-shelf (bass) ─► drive (loudness) ─► clipper ─► output volume ─► speakers
//
// Nothing is downloaded or saved; the page plays as normal and we mangle it on the way out.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

const hello = ipcRenderer.sendSync('boost:hello'); // { role: 'host' | 'guest', params }

const NEUTRAL = { on: false, bass: 0, freq: 120, loud: 0, clip: 'hard', out: 1, speed: 1, keepPitch: true };
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

// Speed: play faster or slower. With keepPitch (the default) the browser time-stretches the
// sound, so it stays the same pitch and doesn't go chipmunk or slurred; without it, pitch
// moves with speed (nightcore). Only touched when you change speed, so a site's own speed
// menu is left alone at 1x.
const retimed = new WeakSet();
function applyRate(el) {
  const speed = Math.min(4, Math.max(0.25, Number(params.speed) || 1));
  const keep = params.keepPitch !== false;
  if (speed === 1) {
    if (!retimed.has(el)) return;
    retimed.delete(el);
    el.preservesPitch = true;
    el.playbackRate = 1;
    return;
  }
  retimed.add(el);
  if (el.preservesPitch !== keep) el.preservesPitch = keep;
  if (Math.abs(el.playbackRate - speed) > 0.001) el.playbackRate = speed;
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
  for (const el of new Set([...document.querySelectorAll('video, audio'), ...hooked])) applyRate(el);
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
  // The page also tells the browser how to skip/seek (its media-key handlers). Keeping a
  // copy lets the Now Playing screen press the page's own next/previous/seek.
  webFrame.executeJavaScript(`(() => {
    const hook = window.__blowoutHook;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try { hook(this); } catch {}
      return play.apply(this, arguments);
    };
    const handlers = {};
    const setHandler = MediaSession.prototype.setActionHandler;
    MediaSession.prototype.setActionHandler = function (action, handler) {
      handlers[action] = handler;
      return setHandler.apply(this, arguments);
    };
    window.__blowoutAct = (action, seekTime) => {
      if (!handlers[action]) return false;
      handlers[action]({ action, seekTime });
      return true;
    };
  })()`);
  const act = (action, seekTime) =>
    webFrame.executeJavaScript(`window.__blowoutAct(${JSON.stringify(action)}, ${Number(seekTime) || 0})`).catch(() => false);

  // The song the page says it's playing, for the Now Playing screen.
  const playing = () => {
    let fallback = null;
    for (const el of hooked) {
      if (!el.paused && !el.ended) return el;
      if (el.currentTime > 0) fallback = el;
    }
    return fallback;
  };
  let clickedAt = 0;
  window.addEventListener('pointerdown', () => { clickedAt = Date.now(); }, true);
  setInterval(() => {
    const info = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!info || !info.title) return;
    const el = playing();
    const art = info.artwork && info.artwork.length ? info.artwork[info.artwork.length - 1].src : '';
    ipcRenderer.send('boost:track', {
      title: info.title,
      artist: info.artist || '',
      album: info.album || '',
      art,
      time: el ? el.currentTime : 0,
      duration: el && Number.isFinite(el.duration) ? el.duration : 0,
      paused: !el || el.paused,
      rate: el ? el.playbackRate : 1,
      host: location.host,
      clicked: Date.now() - clickedAt < 5000, // you just picked something, vs. autoplay moving on
    });
  }, 250);

  ipcRenderer.on('boost:control', async (_event, { action, time }) => {
    const el = playing();
    if (action === 'next') act('nexttrack');
    else if (action === 'prev') act('previoustrack');
    else if (action === 'seek') {
      if (!(await act('seekto', time)) && el) el.currentTime = time;
    } else if (action === 'toggle' && el) {
      if (await act(el.paused ? 'play' : 'pause')) return;
      if (el.paused) el.play().catch(() => {});
      else el.pause();
    }
  });
}

if (hello.role === 'host') {
  contextBridge.exposeInMainWorld('boost', {
    setParams: (next) => ipcRenderer.send('boost:params', next),
    pause: (target) => ipcRenderer.send('boost:pause', target), // 'web' | 'chrome' | 'all'
    control: (action, time, target) => ipcRenderer.send('boost:control', { action, time, target }),
    linked: () => ipcRenderer.invoke('boost:linked'),
    showExtension: () => ipcRenderer.send('boost:show-extension'),
    appSettings: (settings) => ipcRenderer.send('app:settings', settings),
    discordConfig: (config) => ipcRenderer.send('discord:config', config),
    discordPresence: (presence) => ipcRenderer.send('discord:presence', presence),
    discordState: () => ipcRenderer.invoke('discord:state'),
    onDiscordState: (callback) => ipcRenderer.on('discord:state', (_event, state) => callback(state)),
    onLink: (callback) => ipcRenderer.on('boost:link', (_event, linked) => callback(linked)),
    onMeter: (callback) => ipcRenderer.on('boost:meter', (_event, meter) => callback(meter)),
    onTrack: (callback) => ipcRenderer.on('boost:track', (_event, track) => callback(track)),
    lyrics: (track) => ipcRenderer.invoke('lyrics:get', track),
    translate: (lines, lang) => ipcRenderer.invoke('lyrics:translate', lines, lang),
  });
}
