// BLOWOUT Link, the part that runs inside the music page itself. It does what the app's
// own built-in browser does, but in your real Chrome:
//
//   media ─► low-shelf (bass) ─► drive (loudness) ─► clipper ─► output volume ─► speakers
//
// Settings arrive from the BLOWOUT app; the song, position and meter go back to it.
// Until the app sends settings (or you switch the on-page panel on), the page's audio is left
// completely alone. With no app, the little BLOWOUT panel in the corner of the page does the job
// on its own, which is also how this works on phones and other browsers without the app.
(() => {
  if (window.__blowoutLink) return;
  window.__blowoutLink = true;

  const send = (message) => {
    document.dispatchEvent(new CustomEvent('blowout:out', { detail: JSON.stringify(message) }));
  };

  // ---------- audio engine ----------
  const NEUTRAL = { on: false, bass: 0, freq: 120, loud: 0, clip: 'hard', out: 1 };
  let params = NEUTRAL;

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
  let input, shelf, drive, shaper, master, preClip, postClip, appliedCurve;
  const known = new Set(); // every media element the page has shown or played
  const hooked = new Set(); // the ones already routed through the chain
  let armed = false; // becomes true the first time the app switches the boost on

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

  function notice(el) {
    known.add(el);
    if (armed) hook(el);
  }

  // Players like Spotify keep their <video>/<audio> out of the page, so catch play() itself.
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try { notice(this); } catch {}
    return play.apply(this, arguments);
  };

  // The page's own media-key handlers, so the app can press next/previous/seek.
  const handlers = {};
  const setHandler = MediaSession.prototype.setActionHandler;
  MediaSession.prototype.setActionHandler = function (action, handler) {
    handlers[action] = handler;
    return setHandler.apply(this, arguments);
  };
  const act = (action, seekTime) => {
    if (!handlers[action]) return false;
    handlers[action]({ action, seekTime });
    return true;
  };

  const playing = () => {
    let fallback = null;
    for (const el of known) {
      if (!el.paused && !el.ended) return el;
      if (el.currentTime > 0) fallback = el;
    }
    return fallback;
  };

  // ---------- meter: 48 log-spaced bars from 30 Hz to 16 kHz, plus the pre-clip peak ----------
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
      let top = 0;
      for (let b = from; b < to && b < freqData.length; b++) if (freqData[b] > top) top = freqData[b];
      bars.push(top);
    }
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = Math.abs(timeData[i]);
      if (v > peak) peak = v;
    }
    return { bars, peak };
  }

  setInterval(() => {
    for (const el of document.querySelectorAll('video, audio')) notice(el);
    if (!ctx) return;
    let active = false;
    for (const el of hooked) {
      if (!el.paused && !el.ended && el.readyState > 2) active = true;
    }
    if (active) send({ type: 'meter', meter: measure() });
    else if (wasActive) send({ type: 'meter', meter: { bars: new Array(BARS).fill(0), peak: 0 } });
    wasActive = active;
  }, 40);

  // ---------- the song, for the app's Now Playing screen ----------
  let clickedAt = 0;
  window.addEventListener('pointerdown', () => { clickedAt = Date.now(); }, true);
  setInterval(() => {
    const info = navigator.mediaSession && navigator.mediaSession.metadata;
    if (!info || !info.title) return;
    const el = playing();
    const art = info.artwork && info.artwork.length ? info.artwork[info.artwork.length - 1].src : '';
    send({
      type: 'track',
      track: {
        title: info.title,
        artist: info.artist || '',
        album: info.album || '',
        art,
        time: el ? el.currentTime : 0,
        duration: el && Number.isFinite(el.duration) ? el.duration : 0,
        paused: !el || el.paused,
        host: location.host,
        clicked: Date.now() - clickedAt < 5000, // you just picked something, vs. autoplay moving on
      },
    });
  }, 250);

  // ---------- the on-page panel (works without the app) ----------
  const PRESETS = {
    warm: { bass: 8, freq: 100, loud: 3, clip: 'soft' },
    boosted: { bass: 16, freq: 120, loud: 9, clip: 'soft' },
    fried: { bass: 26, freq: 140, loud: 20, clip: 'hard' },
    earrape: { bass: 40, freq: 180, loud: 40, clip: 'square' },
  };
  let appLinked = false;
  let local = { ...NEUTRAL };
  try {
    local = { ...NEUTRAL, ...PRESETS.fried, out: 0.5, ...JSON.parse(localStorage.getItem('blowout-panel')) };
  } catch { /* first visit */ }
  let panelState = () => {};

  function setLocal(changes) {
    local = { ...local, ...changes };
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); // iOS wants this inside a tap
    try { localStorage.setItem('blowout-panel', JSON.stringify(local)); } catch { /* storage blocked */ }
    if (appLinked) return;
    params = local;
    if (params.on && !armed) {
      armed = true;
      for (const el of known) hook(el);
    }
    apply(false);
    panelState();
  }

  function buildPanel() {
    if (document.getElementById('blowout-panel-host')) return;
    const host = document.createElement('div');
    host.id = 'blowout-panel-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:96px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    // Built with DOM calls, not innerHTML: these sites block HTML strings (Trusted Types).
    const el = (tag, props = {}, ...kids) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...kids);
      return node;
    };
    const style = el('style', { textContent: `
      :host { all: initial; font: 13px/1.4 system-ui, "Segoe UI", sans-serif; }
      .pill { background:#ff3d1f; color:#1a0500; border:0; border-radius:999px; padding:9px 16px; font:800 13px system-ui; letter-spacing:1.5px; cursor:pointer; box-shadow:0 4px 18px rgba(0,0,0,.5); }
      .pill.live { background:#ffd600; color:#171300; }
      .card { width:264px; background:#0a0a0b; color:#f3f0e8; border:1px solid #2a2a30; border-radius:10px; padding:12px; box-shadow:0 10px 36px rgba(0,0,0,.65); }
      .row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
      .title { font:italic 800 18px system-ui; letter-spacing:1px; } .title span { color:#ff3d1f; }
      button { font:700 11px system-ui; letter-spacing:1px; color:#f3f0e8; background:#1b1b1f; border:1px solid #2a2a30; border-radius:4px; padding:7px 9px; cursor:pointer; }
      button.on { background:#ffd600; border-color:#ffd600; color:#171300; }
      .presets { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-bottom:10px; }
      label { display:block; margin-bottom:8px; color:#8d8a84; font-size:11px; letter-spacing:1px; }
      label b { float:right; color:#ffd600; font:11px ui-monospace,monospace; }
      input[type=range] { width:100%; accent-color:#ffd600; margin:2px 0 0; }
      .clips { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-bottom:8px; }
      .note { margin:0; color:#8d8a84; font-size:11px; }
    ` });

    const pill = el('button', { className: 'pill', textContent: 'BLOWOUT' });
    const card = el('div', { className: 'card', hidden: true });
    const power = el('button', { textContent: 'BOOST: OFF' });
    const close = el('button', { textContent: 'X', title: 'Close' });
    card.append(
      el('div', { className: 'row' }, el('div', { className: 'title' }, 'BLOW', el('span', {}, 'OUT')), power, close),
    );
    const presets = el('div', { className: 'presets' });
    for (const name of Object.keys(PRESETS)) {
      presets.append(el('button', { textContent: name.toUpperCase(), onclick: () => setLocal({ on: true, ...PRESETS[name] }) }));
    }
    card.append(presets);

    const sliders = {};
    const slider = (key, label, min, max, scale = 1) => {
      const out = el('b');
      const input = el('input', { type: 'range', min, max, step: 1 });
      input.oninput = () => setLocal({ [key]: Number(input.value) / scale });
      sliders[key] = { input, out, scale };
      card.append(el('label', {}, label, out, input));
    };
    slider('bass', 'BASS', 0, 40);
    slider('loud', 'LOUD', 0, 40);
    slider('out', 'OUTPUT VOLUME', 0, 100, 100);

    const clips = el('div', { className: 'clips' });
    const clipBtns = {};
    for (const style of ['soft', 'hard', 'square']) {
      clipBtns[style] = el('button', { textContent: style.toUpperCase(), onclick: () => setLocal({ clip: style }) });
      clips.append(clipBtns[style]);
    }
    const note = el('p', { className: 'note' });
    card.append(clips, note);

    power.onclick = () => setLocal({ on: !local.on });
    pill.onclick = () => { card.hidden = false; pill.hidden = true; };
    close.onclick = () => { card.hidden = true; pill.hidden = false; };

    panelState = () => {
      const shown = appLinked ? params : local;
      host.style.display = appLinked ? 'none' : '';
      power.textContent = shown.on ? 'BOOST: ON' : 'BOOST: OFF';
      power.classList.toggle('on', shown.on);
      pill.classList.toggle('live', shown.on);
      for (const [key, { input, out, scale }] of Object.entries(sliders)) {
        input.value = Math.round(shown[key] * scale);
        out.textContent = key === 'out' ? Math.round(shown[key] * 100) + '%' : '+' + shown[key] + ' dB';
      }
      for (const [style, btn] of Object.entries(clipBtns)) btn.classList.toggle('on', shown.clip === style);
      note.textContent = 'Clipping is a feature. Start with output volume low.';
    };
    root.append(style, pill, card);
    document.documentElement.append(host);
    panelState();
  }

  // Wait a moment: if the BLOWOUT app is running it links first and the panel stays hidden.
  const startPanel = () => setTimeout(() => {
    buildPanel();
    // Come back the way you left it: boost stays on across pages if you left it on.
    // (Not in bookmarklet mode: iOS needs a tap before sound can go through the chain.)
    if (!appLinked && local.on && !window.__blowoutBookmarklet) setLocal({});
  }, window.__blowoutBookmarklet ? 0 : 2500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPanel);
  else startPanel();

  // ---------- from the app ----------
  document.addEventListener('blowout:in', (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (message.type === 'params') {
      // null = the app went away: fall back to the on-page panel's own settings
      appLinked = Boolean(message.params);
      params = message.params || local;
      if (params.on && !armed) {
        armed = true;
        for (const el of known) hook(el);
      }
      apply(false);
      panelState();
    } else if (message.type === 'pause') {
      for (const el of known) el.pause();
    } else if (message.type === 'control') {
      const el = playing();
      const { action, time } = message;
      if (action === 'next') act('nexttrack');
      else if (action === 'prev') act('previoustrack');
      else if (action === 'seek') {
        if (!act('seekto', time) && el) el.currentTime = time;
      } else if (action === 'toggle' && el) {
        if (act(el.paused ? 'play' : 'pause')) return;
        if (el.paused) el.play().catch(() => {});
        else el.pause();
      }
    }
  });
})();
