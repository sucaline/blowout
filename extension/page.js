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
  const NEUTRAL = { on: false, bass: 0, freq: 120, loud: 0, clip: 'hard', out: 1, speed: 1, keepPitch: true };
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
  let input, shelf, drive, shaper, master, preClip, postClip, appliedCurve, tapGain;
  const known = new Set(); // every media element the page has shown or played
  const hooked = new Set(); // the ones already routed through the chain
  let armed = false; // becomes true the first time the app switches the boost on

  function build() {
    ctx = new AudioContext();
    input = ctx.createGain();
    tapGain = ctx.createGain(); // where the iPhone tap plays in (see tapSync)
    tapGain.connect(input);
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


  const diag = { err: '' }; // what went wrong, shown in the panel on phones where nobody can open a console

  function hook(el) {
    if (hooked.has(el)) return;
    if (tapMode && /^blob:/.test(el.currentSrc || '')) return; // streamed playback goes through the tap instead
    hooked.add(el);
    try {
      if (!ctx) build();
      ctx.createMediaElementSource(el).connect(input);
    } catch (e) {
      diag.err = String((e && e.name) || e) + ' ' + String((e && e.message) || '').slice(0, 60);
      return; // something else already owns this element's audio
    }
    const wake = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    el.addEventListener('play', wake);
    el.addEventListener('playing', wake);
    wake();
  }

  // ---------- iPhone: tap the stream ----------
  // Safari's web view hands the audio chain silence for YouTube's streamed playback (it plays
  // through a path Web Audio cannot reach), so boosting the <video> directly does nothing. In
  // the iPhone app we instead read the audio pieces the page itself feeds to its player (AAC in
  // MP4), decode them in memory, play that copy through the chain in step with the video, and
  // mute the original. Nothing is saved or sent anywhere, and pieces are dropped after they play.
  const tapMode = Boolean(window.__blowoutForceTap || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.blowout));
  const tapSegs = new Map(); // start time in ms -> { start, dur, frames, pre, state, buffer, off, st }
  const tapState = { el: null, epoch: null, sources: new Set() };
  const tapStats = { codec: '', pieces: 0, bad: 0, resyncs: 0, hooks: 0, sbs: 0, appends: 0, mime: '', timeouts: 0, clears: 0, fallbacks: 0, tokens: 0 };
  const sbState = new WeakMap();
  const nativeMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  const muteInfo = new WeakMap();

  const u32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
  const s32 = (u, o) => (u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3];
  const fourcc = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);

  function boxesIn(u, from, to) {
    const out = [];
    let o = from;
    while (o + 8 <= to) {
      let size = u32(u, o);
      let head = 8;
      if (size === 1) { size = u32(u, o + 12); head = 16; } // 64-bit size: the low half is plenty here
      else if (size === 0) size = to - o;
      if (size < head || o + size > to) break;
      out.push({ type: fourcc(u, o + 4), start: o, end: o + size, body: o + head });
      o += size;
    }
    return out;
  }
  const child = (u, box, type) => (box ? boxesIn(u, box.body, box.end).find((b) => b.type === type) : undefined);

  function descriptor(u, o) {
    const tag = u[o];
    let len = 0;
    let i = o + 1;
    let n = 0;
    let b;
    do { b = u[i++]; len = (len << 7) | (b & 0x7f); n++; } while ((b & 0x80) && n < 4);
    return { tag, len, body: i };
  }

  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  // The first append of a stream holds the track setup (moov): sample rate, channels, AAC type.
  function parseInit(u, top, st) {
    const moov = top.find((b) => b.type === 'moov');
    const trak = child(u, moov, 'trak');
    const mdia = child(u, trak, 'mdia');
    const mdhd = child(u, mdia, 'mdhd');
    const stsd = child(u, child(u, child(u, mdia, 'minf'), 'stbl'), 'stsd');
    if (!mdhd || !stsd) return false;
    st.timescale = u32(u, mdhd.body + (u[mdhd.body] === 1 ? 20 : 12));
    const trex = child(u, child(u, moov, 'mvex'), 'trex');
    st.defDur = trex ? u32(u, trex.body + 12) : 0;
    st.defSize = trex ? u32(u, trex.body + 16) : 0;
    const entry = boxesIn(u, stsd.body + 8, stsd.end)[0];
    if (!entry) return false;
    st.codec = entry.type;
    const esds = boxesIn(u, entry.body + 28, entry.end).find((b) => b.type === 'esds');
    if (entry.type !== 'mp4a' || !esds) { diag.tap = 'codec ' + entry.type + ' unsupported'; return false; }
    const es = descriptor(u, esds.body + 4); // ES descriptor
    const config = descriptor(u, es.body + 3); // decoder config
    const specific = descriptor(u, config.body + 13); // AudioSpecificConfig
    const a0 = u[specific.body];
    const a1 = u[specific.body + 1];
    st.aot = a0 >> 3;
    st.freqIdx = ((a0 & 7) << 1) | (a1 >> 7);
    st.chan = (a1 >> 3) & 15;
    st.sr = AAC_RATES[st.freqIdx] || 0;
    tapStats.codec = entry.type + ' aot' + st.aot + ' ' + st.sr + 'Hz ' + st.chan + 'ch';
    if (st.aot !== 2 || !st.sr || !st.chan) { diag.tap = 'aac type ' + st.aot + ' unsupported'; return false; }
    diag.tap = '';
    st.tail = null;
    return true;
  }

  // Each moof+mdat pair is a piece of the song: start time, length, and the raw AAC frames.
  function parsePieces(u, top, st, sb) {
    const out = [];
    for (let i = 0; i < top.length; i++) {
      const moof = top[i];
      if (moof.type !== 'moof') continue;
      const mdat = top.slice(i + 1).find((b) => b.type === 'mdat');
      const traf = child(u, moof, 'traf');
      const tfhd = child(u, traf, 'tfhd');
      const tfdt = child(u, traf, 'tfdt');
      if (!mdat || !tfhd || !tfdt) continue;
      const flags = (u[tfhd.body + 1] << 16) | (u[tfhd.body + 2] << 8) | u[tfhd.body + 3];
      let p = tfhd.body + 8;
      let base = moof.start;
      if (flags & 1) { base = u32(u, p + 4); p += 8; }
      if (flags & 2) p += 4;
      let defDur = st.defDur;
      let defSize = st.defSize;
      if (flags & 8) { defDur = u32(u, p); p += 4; }
      if (flags & 0x10) { defSize = u32(u, p); p += 4; }
      const decodeTime = u[tfdt.body] === 1 ? u32(u, tfdt.body + 4) * 4294967296 + u32(u, tfdt.body + 8) : u32(u, tfdt.body + 4);
      const frames = [];
      let ticks = 0;
      let cursor = mdat.body;
      for (const trun of boxesIn(u, traf.body, traf.end).filter((b) => b.type === 'trun')) {
        const tf = (u[trun.body + 1] << 16) | (u[trun.body + 2] << 8) | u[trun.body + 3];
        const count = u32(u, trun.body + 4);
        let q = trun.body + 8;
        if (tf & 1) { cursor = base + s32(u, q); q += 4; }
        if (tf & 4) q += 4;
        for (let k = 0; k < count; k++) {
          let dur = defDur;
          let size = defSize;
          if (tf & 0x100) { dur = u32(u, q); q += 4; }
          if (tf & 0x200) { size = u32(u, q); q += 4; }
          if (tf & 0x400) q += 4;
          if (tf & 0x800) q += 4;
          if (cursor + size > u.length) break;
          frames.push(u.subarray(cursor, cursor + size));
          cursor += size;
          ticks += dur;
        }
      }
      if (!frames.length || !st.timescale) continue;
      out.push({ start: decodeTime / st.timescale + (sb.timestampOffset || 0), dur: ticks / st.timescale, frames });
    }
    return out;
  }

  function tapIngest(sb, st, data) {
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const u = view.slice(); // our own copy; the page is free to reuse its buffer
    const top = boxesIn(u, 0, u.length);
    if (top.some((b) => b.type === 'moov')) st.ready = parseInit(u, top, st);
    if (!st.ready) return;
    for (const rec of parsePieces(u, top, st, sb)) {
      rec.st = st;
      rec.state = 'new';
      // A few frames from the end of the previous piece let the decoder warm up, so the join is clean.
      rec.pre = st.tail && Math.abs(st.tail.end - rec.start) < 0.02 ? st.tail.frames : [];
      st.tail = { end: rec.start + rec.dur, frames: rec.frames.slice(-3) };
      tapSegs.set(Math.round(rec.start * 1000), rec);
      tapStats.pieces++;
    }
  }

  function adtsHeader(st, size) {
    const len = size + 7;
    const h = new Uint8Array(7);
    h[0] = 0xff;
    h[1] = 0xf1;
    h[2] = ((st.aot - 1) << 6) | (st.freqIdx << 2) | (st.chan >> 2);
    h[3] = ((st.chan & 3) << 6) | (len >> 11);
    h[4] = (len >> 3) & 0xff;
    h[5] = ((len & 7) << 5) | 0x1f;
    h[6] = 0xfc;
    return h;
  }

  function tapDecode(rec) {
    rec.state = 'decoding';
    rec.at = Date.now();
    rec.tries = (rec.tries || 0) + 1;
    const token = rec.token = ++tapStats.tokens;
    const parts = [];
    let total = 0;
    for (const frame of [...rec.pre, ...rec.frames]) {
      const header = adtsHeader(rec.st, frame.length);
      parts.push(header, frame);
      total += header.length + frame.length;
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const part of parts) { bytes.set(part, o); o += part.length; }
    ctx.decodeAudioData(bytes.buffer).then((buffer) => {
      if (rec.token !== token) return; // gave up on this attempt already
      rec.buffer = buffer;
      rec.off = Math.max(0, buffer.duration - rec.dur); // line up by the end: the start has the warm-up
      rec.state = 'ready';
    }, (e) => {
      if (rec.token !== token) return;
      diag.tap = 'decode ' + String((e && e.name) || e);
      rec.state = rec.tries >= 3 ? 'bad' : 'new'; // try again a couple of times
      if (rec.state === 'bad') tapStats.bad++;
    });
  }

  function tapStop() {
    for (const source of tapState.sources) {
      try { source.onended = null; source.stop(); } catch { /* already finished */ }
    }
    tapState.sources.clear();
    tapState.epoch = null;
  }

  // The original element is muted while the copy plays. The page can still mute it itself (the
  // site's own mute button), and that is respected.
  function tapMute(el, forced) {
    let info = muteInfo.get(el);
    if (!info) {
      info = { page: nativeMuted.get.call(el), forced: false };
      muteInfo.set(el, info);
      Object.defineProperty(el, 'muted', {
        configurable: true,
        get: () => info.page,
        set: (value) => { info.page = Boolean(value); nativeMuted.set.call(el, info.page || info.forced); },
      });
    }
    info.forced = forced;
    nativeMuted.set.call(el, info.page || info.forced);
    return info;
  }

  function tapRelease() {
    if (tapState.el) { try { tapMute(tapState.el, false); } catch { /* element gone */ } }
    tapState.el = null;
    tapStop();
  }

  function tapSync() {
    if (!tapMode) return;
    const el = playing();
    const eligible = el && params.on && tapSegs.size > 0 && /^blob:/.test(el.currentSrc || '');
    if (!eligible) { tapRelease(); return; }
    if (!ctx) { try { build(); } catch { return; } }
    if (ctx.state !== 'running') { ctx.resume().catch(() => {}); tapRelease(); return; } // never mute unless the copy can play
    if (tapState.el !== el) { tapRelease(); tapState.el = el; }
    tapGain.gain.value = el.muted ? 0 : (el.volume === undefined ? 1 : el.volume); // el.muted is the page's own wish

    const T = el.currentTime;
    tapPump(T);
    if (el.paused || el.seeking || el.readyState < 2) { tapStop(); return; }

    const rate = el.playbackRate || 1;
    let epoch = tapState.epoch;
    if (epoch) {
      const expected = epoch.mediaT0 + (ctx.currentTime - epoch.ctxT0) * epoch.rate;
      if (epoch.rate !== rate || Math.abs(expected - T) > 0.25) { tapStop(); epoch = null; tapStats.resyncs++; }
    }
    // The copy starts a moment from now, by which time the video has moved on: start it there.
    if (!epoch) epoch = tapState.epoch = { ctxT0: ctx.currentTime + 0.06, mediaT0: T + 0.06 * rate, rate, upTo: T };

    const horizon = T + 6;
    for (const rec of [...tapSegs.values()].sort((a, b) => a.start - b.start)) {
      const end = rec.start + rec.dur;
      if (end <= epoch.upTo + 0.001) continue;
      if (rec.start >= horizon) break;
      if (rec.state === 'bad') continue; // a hole: carry on after it
      if (rec.state !== 'ready') break; // wait for the decoder; the order keeps the pieces joined up
      const from = Math.max(rec.start, epoch.upTo);
      let when = epoch.ctxT0 + (from - epoch.mediaT0) / rate;
      let offset = rec.off + (from - rec.start);
      let length = end - from;
      const now = ctx.currentTime + 0.01;
      if (when < now) { // late: skip the part that should already have played
        const skip = (now - when) * rate;
        when = now;
        offset += skip;
        length -= skip;
        if (length <= 0) { epoch.upTo = end; continue; }
      }
      const source = ctx.createBufferSource();
      source.buffer = rec.buffer;
      source.playbackRate.value = rate;
      source.connect(tapGain);
      source.start(when, offset, length);
      tapState.sources.add(source);
      source.onended = () => tapState.sources.delete(source);
      epoch.upTo = end;
    }

    // Only silence the original while the copy really covers what is playing. If it runs dry
    // (a piece missing, still decoding, or a codec it cannot read), the original takes over
    // again instead of leaving silence, and the copy takes back over when it catches up.
    if (epoch.upTo > T + 0.4) {
      tapState.gapSince = 0;
      tapState.fallback = false;
      tapMute(el, true);
    } else {
      if (!tapState.gapSince) tapState.gapSince = Date.now();
      if (Date.now() - tapState.gapSince > 1200) {
        if (!tapState.fallback) tapStats.fallbacks++;
        tapState.fallback = true;
        tapMute(el, false);
      }
    }
  }

  function tapPump(T) {
    const now = Date.now();
    let running = 0;
    for (const [key, rec] of tapSegs) {
      if (rec.start + rec.dur < T - 600 || rec.start > T + 600) { tapSegs.delete(key); continue; }
      if (rec.state === 'decoding') {
        if (now - rec.at > 5000) { // the browser never answered: try again, a few times
          rec.token = 0;
          rec.state = rec.tries >= 3 ? 'bad' : 'new';
          tapStats.timeouts++;
          if (rec.state === 'bad') tapStats.bad++;
        } else running++;
      } else if (rec.state === 'ready' && (rec.start + rec.dur < T - 15 || rec.start > T + 60)) {
        rec.buffer = null; // keep the small encoded copy; decode again if we come back to it
        rec.state = 'new';
      }
    }
    const todo = [...tapSegs.values()]
      .filter((rec) => rec.state === 'new' && rec.start + rec.dur > T - 1 && rec.start < T + 45)
      .sort((a, b) => a.start - b.start);
    for (const rec of todo) {
      if (running >= 2) break;
      tapDecode(rec);
      running++;
    }
  }

  const tapReport = () => {
    if (!tapMode) return 'tap n/a';
    let ready = 0;
    for (const rec of tapSegs.values()) if (rec.state === 'ready') ready++;
    return 'tap ' + (tapState.sources.size ? 'ON' : 'off') + ' ' + ready + '/' + tapSegs.size + ' bad' + tapStats.bad + ' resync' + tapStats.resyncs + ' timeouts' + tapStats.timeouts + ' clears' + tapStats.clears + ' fallbacks' + tapStats.fallbacks + (tapState.fallback ? ' ORIGINAL' : '') + ' ' + (tapStats.codec || 'no-audio-seen') + ' [hooks' + tapStats.hooks + ' audioSB' + tapStats.sbs + ' appends' + tapStats.appends + ' ' + tapStats.mime + ']' + (diag.tap ? ' ERR ' + diag.tap : '');
  };

  // iPhone Safari only exposes ManagedMediaSource (not MediaSource), and the methods may live on
  // a parent prototype, so find where each one really is and wrap it there.
  const mediaSources = [window.MediaSource, window.ManagedMediaSource].filter(Boolean);
  const sourceBuffers = [window.SourceBuffer, window.ManagedSourceBuffer].filter(Boolean);
  if (tapMode && mediaSources.length) {
    const ownerOf = (proto, name) => {
      for (let p = proto; p; p = Object.getPrototypeOf(p)) {
        if (Object.prototype.hasOwnProperty.call(p, name)) return p;
      }
      return null;
    };
    const done = [];
    const wrap = (proto, name, make) => {
      const owner = ownerOf(proto, name);
      if (!owner || done.some((d) => d[0] === owner && d[1] === name)) return;
      done.push([owner, name]);
      owner[name] = make(owner[name]);
      tapStats.hooks = done.length;
    };
    const wrapBuffer = (proto) => {
      wrap(proto, 'appendBuffer', (append) => function (data) {
        try {
          const st = sbState.get(this);
          if (st) { tapStats.appends++; tapIngest(this, st, data); }
        } catch (e) { diag.tap = 'ingest ' + String((e && e.message) || e).slice(0, 60); }
        return append.apply(this, arguments);
      });
      // When the page throws away part of what it buffered (seeking, an ad ending), so do we.
      wrap(proto, 'remove', (remove) => function (from, to) {
        try {
          if (sbState.has(this)) {
            for (const [key, rec] of tapSegs) {
              if (rec.start + rec.dur > from && rec.start < to) tapSegs.delete(key);
            }
          }
        } catch { /* never get in the page's way */ }
        return remove.apply(this, arguments);
      });
    };
    for (const ctor of mediaSources) {
      wrap(ctor.prototype, 'addSourceBuffer', (add) => function (mime) {
        const sb = add.apply(this, arguments);
        try {
          if (String(mime).toLowerCase().startsWith('audio/')) {
            sbState.set(sb, { mime: String(mime), ready: false });
            tapStats.sbs++;
            if (tapSegs.size) { tapSegs.clear(); tapStop(); tapStats.clears++; } // a new song: forget the last one
            tapStats.mime = String(mime).slice(0, 40);
          }
          wrapBuffer(Object.getPrototypeOf(sb)); // whichever class the page really got
        } catch { /* never get in the page's way */ }
        return sb;
      });
      // Ask the site for MP4 audio (AAC), which the tap can read, rather than WebM.
      const supported = ctor.isTypeSupported;
      ctor.isTypeSupported = function (type) {
        return /webm/i.test(String(type)) ? false : supported.apply(this, arguments);
      };
    }
    for (const ctor of sourceBuffers) wrapBuffer(ctor.prototype);
    const canPlay = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return /webm/i.test(String(type)) ? '' : canPlay.apply(this, arguments);
    };
    setInterval(tapSync, 120);
  }

  const tapWatched = new WeakSet();
  if (window.__blowoutTest) window.__blowoutProbe = { tapReport, tapState, tapSegs, tapStats };

  function notice(el) {
    known.add(el);
    if (tapMode && !tapWatched.has(el)) {
      tapWatched.add(el);
      for (const type of ['pause', 'playing', 'seeking', 'seeked', 'ratechange', 'waiting', 'ended']) el.addEventListener(type, tapSync);
    }
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
    for (const el of new Set([...document.querySelectorAll('video, audio'), ...known])) applyRate(el);
    if (!ctx) return;
    let active = tapState.sources.size > 0;
    for (const el of hooked) {
      if (!el.paused && !el.ended && el.readyState > 2) active = true;
    }
    if (active) {
      const meter = measure();
      send({ type: 'meter', meter });
    } else if (wasActive) send({ type: 'meter', meter: { bars: new Array(BARS).fill(0), peak: 0 } });
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
        rate: el ? el.playbackRate : 1,
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
    if (tapMode && !ctx) build(); // made inside the tap, so iOS lets it run
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
      .presets { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; margin-bottom:10px; }
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
    slider('speed', 'SPEED', 50, 200, 100);

    const clips = el('div', { className: 'clips' });
    const clipBtns = {};
    for (const style of ['soft', 'hard', 'square']) {
      clipBtns[style] = el('button', { textContent: style.toUpperCase(), onclick: () => setLocal({ clip: style }) });
      clips.append(clipBtns[style]);
    }
    const pitch = el('button', { onclick: () => setLocal({ keepPitch: !local.keepPitch }) });
    card.append(pitch);
    const note = el('p', { className: 'note' });
    card.append(clips, note);
    // Phones only: a one-line status of the audio engine, for when boosting does nothing.
    const debug = window.__blowoutBookmarklet ? el('p', { className: 'note' }) : null;
    if (debug) {
      debug.style.cssText = 'font:10px ui-monospace,monospace;word-break:break-all;margin-top:8px;';
      card.append(debug);
      const report = () => {
        let peak = 0;
        if (ctx && preClip) {
          const data = new Float32Array(preClip.fftSize);
          preClip.getFloatTimeDomainData(data);
          for (const v of data) if (Math.abs(v) > peak) peak = Math.abs(v);
        }
        const media = [...known].map((e) => e.tagName[0] + ':' + ((e.currentSrc || '').slice(0, 5) || (e.srcObject ? 'obj' : '-')) + ':' + (e.paused ? 'paused' : 'playing') + e.readyState).join(' ');
        debug.textContent = 'engine: ctx ' + (ctx ? ctx.state + '@' + ctx.sampleRate : 'none') + ' | hooked ' + hooked.size + '/' + known.size + ' | peak ' + peak.toFixed(2) + ' | ' + (diag.err ? 'ERROR ' + diag.err : 'no error') + ' | ' + tapReport() + ' | MSE ' + (window.MediaSource || window.ManagedMediaSource ? 'yes' : 'no') + ' | ' + media;
      };
      setInterval(() => { if (!card.hidden) report(); }, 1000);
    }

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
        out.textContent = key === 'out' ? Math.round(shown[key] * 100) + '%' : key === 'speed' ? Number(shown.speed).toFixed(2) + 'x' : '+' + shown[key] + ' dB';
      }
      pitch.textContent = shown.keepPitch === false ? 'KEEP PITCH: OFF (NIGHTCORE)' : 'KEEP PITCH: ON';
      pitch.classList.toggle('on', shown.keepPitch !== false);
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
      } else if (action === 'resume') {
        // Only ever starts things: the iPhone app asks for this after going to the background.
        const target = el || [...known].find((candidate) => candidate.currentTime > 0);
        if (target && target.paused && !target.ended) {
          if (!act('play')) target.play().catch(() => {});
        }
      } else if (action === 'toggle' && el) {
        if (act(el.paused ? 'play' : 'pause')) return;
        if (el.paused) el.play().catch(() => {});
        else el.pause();
      }
    }
  });
})();
