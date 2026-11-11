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

// ---------- what's on screen, and what's playing ----------
// The stage shows one of: 'empty', 'web' (the site itself) or 'now' (the Now Playing screen).
// `source` is where the current song comes from: a page in the web view, or a local file.
let source = null; // 'web' | 'file'
let track = null; // { key, title, artist, art, time, duration, paused, at }

function setView(name) {
  stage.dataset.view = name;
  $('now-toggle').hidden = !track || name === 'now';
}

let statusTimer;
function showStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Returns true when this is a different song from the one before.
function setTrack(info) {
  const key = `${info.title}\n${info.artist}`;
  const fresh = !track || track.key !== key;
  track = { ...info, key };
  if (!fresh) return false;

  $('now-title').textContent = info.title;
  $('now-artist').textContent = info.artist;
  const art = /^https:\/\//.test(info.art || '') ? info.art : '';
  $('now-art').hidden = !art;
  if (art) $('now-art').src = art;
  $('now-bg').style.backgroundImage = art ? `url(${JSON.stringify(art)})` : '';
  $('now-page').hidden = source !== 'web';
  $('loop').hidden = source !== 'file';
  $('now-next').disabled = source === 'file';
  $('now-toggle').hidden = stage.dataset.view === 'now';
  lag = 0;
  renderLag();
  loadLyrics();
  return true;
}

// Pages report their position four times a second; fill the gaps so lyrics move smoothly.
function position() {
  if (!track) return 0;
  if (source === 'file') return local.currentTime;
  if (track.paused) return track.time;
  return track.time + Math.min(1, (performance.now() - track.at) / 1000);
}
const duration = () => (source === 'file' ? local.duration || 0 : track ? track.duration : 0);
const isPaused = () => (source === 'file' ? local.paused : !track || track.paused);

function control(action, time) {
  if (source === 'file') {
    if (action === 'toggle') {
      if (local.paused) local.play().catch(() => {});
      else local.pause();
    } else if (action === 'seek') local.currentTime = time;
    else if (action === 'prev') local.currentTime = 0;
    return;
  }
  window.boost.control(action, time);
  if (action === 'seek' && track) Object.assign(track, { time, at: performance.now() });
}

const MUSIC_SITES = /^(music\.youtube\.com|open\.spotify\.com)$/;
window.boost.onTrack((info) => {
  if (source !== 'web') return;
  const fresh = setTrack({ ...info, at: performance.now() });
  // Picking a song on a music site jumps to Now Playing; autoplay moving on doesn't yank you.
  if (fresh && info.clicked && MUSIC_SITES.test(info.host)) setView('now');
});

// ---------- links ----------
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
  source = 'web';
  track = null;
  setView('web');
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
  if (stage.dataset.view === 'now' && source === 'web') setView('web');
  else if (stage.dataset.view === 'web' && view.canGoBack()) view.goBack();
});
$('now-toggle').addEventListener('click', () => setView('now'));
$('now-page').addEventListener('click', () => setView('web'));

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
  source = 'file';
  // "Artist - Song.mp3" is the only hint a bare file gives us.
  const name = file.name.replace(/\.[^.]+$/, '');
  const parts = name.split(/\s+[-–—]\s+/);
  const named = parts.length === 2 ? { artist: parts[0], title: parts[1] } : { artist: '', title: name };
  track = null;
  setTrack({ ...named, art: '' });
  setView('now');
  local.src = objectUrl;
  local.play().catch(() => {});
}

$('open-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});
local.addEventListener('error', () => {
  if (local.src) showStatus("Couldn't play that file. Try an .mp3, .wav, .flac, .ogg or .m4a.");
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

// ---------- Now Playing: transport ----------
const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const seek = $('now-seek');
let seeking = false;

$('now-play').addEventListener('click', () => control('toggle'));
$('now-prev').addEventListener('click', () => control('prev'));
$('now-next').addEventListener('click', () => control('next'));
seek.addEventListener('input', () => { seeking = true; });
seek.addEventListener('change', () => {
  if (duration()) control('seek', (seek.value / 1000) * duration());
  seeking = false;
});
$('loop').addEventListener('click', (e) => {
  local.loop = !local.loop;
  e.currentTarget.setAttribute('aria-pressed', String(local.loop));
});
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|BUTTON|SELECT)$/.test(document.activeElement.tagName);
  if (e.code === 'Space' && !typing && stage.dataset.view === 'now') {
    e.preventDefault();
    control('toggle');
  }
});

// ---------- Now Playing: lyrics ----------
const box = $('lyrics');
let lyrics = null; // { timed, lines: [{ t, text }], els: [<p>] }
let active = -1;
let lag = 0; // seconds to delay the lyrics by, for videos with intros
let scrolledAt = 0;

function lyricsNote(text) {
  lyrics = null;
  active = -1;
  const note = document.createElement('p');
  note.className = 'lyrics-note';
  note.textContent = text;
  box.replaceChildren(note);
  box.classList.remove('untimed');
  $('sync-row').hidden = true;
}

async function loadLyrics() {
  const mine = track.key;
  lyricsNote('Looking for lyrics…');
  // A page names the song before it knows how long it is; the length helps find the right lyrics.
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (!track || track.key !== mine) return;
  const hit = await window.boost.lyrics({
    title: track.title,
    artist: track.artist,
    duration: duration(),
    strict: source === 'file',
  });
  if (!track || track.key !== mine) return;
  if (hit && hit.instrumental) return lyricsNote('Instrumental. Just vibes.');
  if (!hit || (!hit.synced && !hit.plain)) return lyricsNote('No lyrics found for this one.');

  const timed = Boolean(hit.synced && hit.synced.length);
  const lines = timed ? hit.synced : hit.plain.split('\n').map((text) => ({ t: 0, text }));
  const els = lines.map((line) => {
    const p = document.createElement('p');
    p.className = 'line';
    const text = document.createElement('span');
    text.textContent = line.text || '♪';
    const translated = document.createElement('span');
    translated.className = 'line-tr';
    p.append(text, translated);
    if (timed) p.addEventListener('click', () => control('seek', Math.max(0, line.t + lag)));
    return p;
  });
  lyrics = { timed, lines, els };
  active = -1;
  box.replaceChildren(...els);
  box.classList.toggle('untimed', !timed);
  box.scrollTop = 0;
  $('sync-row').hidden = !timed;
  if (translating) loadTranslation();
}

function showActiveLine(index) {
  active = index;
  lyrics.els.forEach((el, i) => {
    el.classList.toggle('active', i === index);
    el.classList.toggle('past', i < index);
  });
  // Follow along, unless you scrolled away yourself a moment ago.
  if (index >= 0 && performance.now() - scrolledAt > 3000) {
    const el = lyrics.els[index];
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
  }
}
box.addEventListener('wheel', () => { scrolledAt = performance.now(); }, { passive: true });

function renderLag() {
  $('sync-out').textContent = `${lag > 0 ? '+' : ''}${lag.toFixed(1)}s`;
}
$('sync-earlier').addEventListener('click', () => { lag -= 0.5; renderLag(); });
$('sync-later').addEventListener('click', () => { lag += 0.5; renderLag(); });

// ---------- Now Playing: translation ----------
const langSelect = $('lang');
const saved = localStorage.getItem('lang') || navigator.language;
langSelect.value = [...langSelect.options].some((o) => o.value === saved) ? saved
  : [...langSelect.options].some((o) => o.value === saved.split('-')[0]) ? saved.split('-')[0] : 'en';
let translating = localStorage.getItem('translate') === 'on';
const translations = new Map(); // song + language -> translated lines

function renderTranslate() {
  $('translate').setAttribute('aria-pressed', String(translating));
  box.classList.toggle('translated', translating);
}

async function loadTranslation() {
  if (!lyrics) return;
  const lang = langSelect.value;
  const mine = `${track.key}\n${lang}`;
  const wanted = lyrics;
  if (!translations.has(mine)) {
    const result = await window.boost.translate(lyrics.lines.map((line) => line.text), lang);
    if (!result) return showStatus("Couldn't reach the translator. Try again in a bit.");
    // Lyrics already in that language come back unchanged; don't print them twice.
    const same = result.from && result.from.split('-')[0] === lang.split('-')[0];
    translations.set(mine, same ? [] : result.lines);
  }
  if (lyrics !== wanted || !translating) return;
  const lines = translations.get(mine);
  if (!lines.length) showStatus(`These lyrics are already in ${langSelect.selectedOptions[0].textContent}.`);
  wanted.els.forEach((el, i) => {
    const text = lines[i] || '';
    el.lastChild.textContent = text.toLowerCase() === wanted.lines[i].text.toLowerCase() ? '' : text;
  });
}

$('translate').addEventListener('click', () => {
  translating = !translating;
  localStorage.setItem('translate', translating ? 'on' : 'off');
  renderTranslate();
  if (translating) loadTranslation();
});
langSelect.addEventListener('change', () => {
  localStorage.setItem('lang', langSelect.value);
  if (translating) loadTranslation();
});

// ---------- meter + per-frame updates ----------
const canvas = $('bars');
const g = canvas.getContext('2d');
let meter = { bars: [], peak: 0 };
let clipUntil = 0;
let meterAt = 0;
let bass = 0;

window.boost.onMeter((m) => {
  meter = m;
  meterAt = performance.now();
  if (m.peak >= 1) {
    clipUntil = performance.now() + 250;
    $('over').textContent = `${(20 * Math.log10(m.peak)).toFixed(1)} dB over`;
  }
});

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

function drawNowPlaying(clipping) {
  if (!track || stage.dataset.view !== 'now') return;
  const pos = position();
  const dur = duration();
  setText($('now-time'), fmt(pos));
  setText($('now-total'), fmt(dur));
  setText($('now-play'), isPaused() ? '▶' : '❚❚');
  if (!seeking) seek.value = dur ? (pos / dur) * 1000 : 0;
  seek.style.setProperty('--fill', `${seek.value / 10}%`);

  if (lyrics && lyrics.timed) {
    const t = pos - lag;
    let index = -1;
    while (index + 1 < lyrics.lines.length && lyrics.lines[index + 1].t <= t) index++;
    if (index !== active) showActiveLine(index);
  }

  // Everything on this screen breathes with the low end and glitches when it clips.
  const low = meter.bars.length ? meter.bars.slice(0, 8).reduce((a, b) => a + b, 0) / (8 * 255) : 0;
  bass += (low - bass) * (low > bass ? 0.5 : 0.12);
  stage.style.setProperty('--bass', bass.toFixed(3));
  stage.classList.toggle('clipping', clipping);
}

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
  drawNowPlaying(clipping);
  requestAnimationFrame(draw);
}

render();
renderTranslate();
renderLag();
window.boost.setParams(params);
requestAnimationFrame(draw);
