// Dev check, run with `npm run selftest`. Everything is muted at the speaker, but the audio
// graph still runs, so the meter tells us whether sound is really flowing through the chain.
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO = process.env.SELFTEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const OUT = process.env.SELFTEST_OUT || __dirname;

module.exports = async function selftest(win) {
  win.webContents.setAudioMuted(true);
  win.setAlwaysOnTop(true); // a covered window stops painting, which breaks the screenshots
  app.on('web-contents-created', (_e, wc) => wc.setAudioMuted(true));
  win.webContents.on('console-message', (e) => console.log('[page]', e.message));

  const seen = { host: { frames: 0, peak: 0, bass: 0 }, guest: { frames: 0, peak: 0, bass: 0 } };
  ipcMain.on('boost:meter', (event, m) => {
    const s = seen[event.sender === win.webContents ? 'host' : 'guest'];
    s.frames++;
    s.peak = Math.max(s.peak, m.peak);
    s.bass = Math.max(s.bass, ...m.bars.slice(0, 8));
  });
  const shot = async (name) => {
    try {
      fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      console.log('RESULT screenshot failed', name, err.message);
    }
  };
  const run = (js) => win.webContents.executeJavaScript(js, true);

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(500);
  await shot('selftest-1-empty.png');

  // 1) Local file: a quiet 55 Hz + 1 kHz tone (peak 0.15), pushed through the FRIED preset.
  await run(`(() => {
    const rate = 44100, n = rate * 4, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const s = 0.1 * Math.sin(2 * Math.PI * 55 * t) + 0.05 * Math.sin(2 * Math.PI * 1000 * t);
      v.setInt16(44 + i * 2, s * 32767, true);
    }
    update({ on: false });
    openFile(new File([buf], 'test tone.wav', { type: 'audio/wav' }));
  })()`);
  await sleep(1500);
  const clean = { ...seen.host };
  seen.host.peak = 0; seen.host.bass = 0;
  await run(`document.querySelector('[data-preset="fried"]').click()`);
  await sleep(1500);
  const fried = { ...seen.host };
  await shot('selftest-2-file.png');
  console.log('RESULT file clean ', JSON.stringify(clean));
  console.log('RESULT file fried ', JSON.stringify(fried));

  // The three looks, each on Now Playing and on the Settings page.
  for (const look of ['starrail', 'material', 'blowout']) {
    await run(`applyLook('${look}'); setView('now', true)`);
    await sleep(700);
    await shot(`selftest-look-${look}-now.png`);
    await run(`$('settings-btn').click()`);
    await sleep(500);
    await shot(`selftest-look-${look}-settings.png`);
    await run(`$('settings-done').click()`);
  }
  await run(`applyLook('material'); setView('empty', true)`);
  await sleep(500);
  await shot('selftest-look-material-empty.png');
  console.log('RESULT look', await run(`JSON.stringify({ theme: document.body.dataset.theme, bar: barColors, view: stage.dataset.view })`));
  await run(`applyLook('blowout'); setView('now', true)`);
  if (process.env.SELFTEST_LOOK) return app.exit(0);

  const guest = (js) => run(`view.executeJavaScript(${JSON.stringify(js)})`).catch((e) => `ERR ${e.message}`);
  const open = async (url, ms) => {
    await run(`openLink(${JSON.stringify(url)})`);
    await sleep(ms);
    seen.guest = { frames: 0, peak: 0, bass: 0 };
  };
  const identity = `JSON.stringify({ ua: navigator.userAgent, brands: (navigator.userAgentData || {}).brands, title: document.title, host: location.host })`;

  // 2) A YouTube link, boosted as it plays.
  await run(`openLink(${JSON.stringify(VIDEO)})`);
  await sleep(12000);
  await shot('selftest-3-youtube.png');
  console.log('RESULT youtube    ', JSON.stringify(seen.guest));
  console.log('RESULT view       ', await run(`JSON.stringify({ view: stage.dataset.view, url: view.getURL() })`));

  // 2b) Now Playing: the page's song info reaches us, lyrics load, translate, and follow along.
  await open(process.env.SELFTEST_SONG || 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', 14000);
  await run(`setView('now'); langSelect.value = 'es'; if (!translating) $('translate').click(); langSelect.dispatchEvent(new Event('change'));`);
  await sleep(6000);
  console.log('RESULT now playing', await run(`JSON.stringify({
    title: track && track.title, artist: track && track.artist, art: Boolean(track && track.art),
    duration: Math.round(duration()), position: Math.round(position()), paused: isPaused(),
    lines: lyrics ? lyrics.lines.length : 0, timed: Boolean(lyrics && lyrics.timed), active,
    translated: lyrics ? lyrics.els.filter((el) => el.lastChild.textContent).length : 0,
    note: lyrics ? '' : box.textContent, status: $('status').hidden ? '' : $('status').textContent,
  })`));
  await shot('selftest-3b-now-playing.png');
  const before = await run(`position()`);
  await run(`control('seek', 60)`);
  await sleep(2500);
  console.log('RESULT seek       ', JSON.stringify({ before: Math.round(before), after: Math.round(await run(`position()`)) }));
  await run(`control('toggle')`);
  await sleep(1500);
  console.log('RESULT pause      ', await run(`JSON.stringify({ paused: isPaused() })`));

  // 2c) Chrome link: a stand-in browser with the extension loaded plays a song; the app should
  //     link, follow it, boost it and control it.
  const { BrowserWindow, session } = require('electron');
  const sim = session.fromPartition('persist:chrome-sim');
  await (sim.extensions || sim).loadExtension(path.join(__dirname, 'extension'));
  const browser = new BrowserWindow({ show: false, webPreferences: { session: sim, backgroundThrottling: false } });
  browser.webContents.on('console-message', (e) => console.log('[sim]', e.message));
  await browser.loadURL(process.env.SELFTEST_SONG || 'https://music.youtube.com/watch?v=dQw4w9WgXcQ');
  await sleep(4000);
  if (browser.webContents.getURL().includes('consent.youtube.com')) {
    // Fresh test profile: decline the optional cookies and carry on to the song.
    await browser.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button, input[type=submit]')].find((el) => /reject all/i.test(el.textContent || el.value || el.getAttribute('aria-label') || ''));
      if (b) b.click();
    })()`);
  }
  await sleep(14000);
  console.log('RESULT chrome link', await run(`JSON.stringify({
    linked: !$('chrome-link').hidden, source, view: stage.dataset.view, title: track && track.title,
    paused: isPaused(), position: Math.round(position()), lines: lyrics ? lyrics.lines.length : 0,
    meterFrom: meter.role, peak: Math.round(meter.peak * 10) / 10,
  })`));
  await shot('selftest-3c-chrome-link.png');
  await run(`control('seek', 100)`);
  await sleep(2500);
  console.log('RESULT chrome seek', await run(`JSON.stringify({ position: Math.round(position()) })`));
  await run(`update({ on: false })`);
  await sleep(800);
  console.log('RESULT chrome off ', await run(`JSON.stringify({ peak: Math.round(meter.peak * 100) / 100 })`));
  await run(`update({ on: true }); control('toggle')`);
  await sleep(1500);
  console.log('RESULT chrome stop', await run(`JSON.stringify({ paused: isPaused() })`));
  browser.destroy();
  await sleep(1500);
  console.log('RESULT unlinked   ', await run(`JSON.stringify({ linked: !$('chrome-link').hidden })`));
  if (process.env.SELFTEST_QUICK) return app.exit(0);

  // 3) A player that never puts its <audio> in the page (how Spotify does it).
  await open('https://example.com/', 3000);
  await guest(`(() => {
    const rate = 44100, n = rate * 3, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, 3000 * Math.sin(2 * Math.PI * 60 * i / rate), true);
    window.__tone = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
    window.__tone.loop = true;
    window.__tone.play();
    return document.querySelectorAll('audio, video').length;
  })()`);
  await sleep(2000);
  console.log('RESULT detached   ', JSON.stringify(seen.guest));

  // 4) YouTube Music loads as a normal Chrome-like browser.
  await open('https://music.youtube.com/', 8000);
  console.log('RESULT ytmusic    ', await guest(identity));
  await shot('selftest-5-ytmusic.png');

  // 5) Widevine DRM: is it there, and does protected audio still reach our chain?
  console.log('RESULT widevine   ', await guest(`navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
    initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
  }]).then(() => 'available', (e) => 'MISSING ' + e.message)`));
  await open('https://shaka-player-demo.appspot.com/demo/#asset=https://storage.googleapis.com/shaka-demo-assets/angel-one-widevine/dash.mpd;license=https://cwip-shaka-proxy.appspot.com/no_auth;panel=HOME;build=uncompiled', 6000);
  await sleep(12000);
  console.log('RESULT drm audio  ', JSON.stringify(seen.guest));
  console.log('RESULT drm video  ', await guest(`JSON.stringify([...document.querySelectorAll('video')].map((v) => ({ t: v.currentTime, paused: v.paused, keys: !!v.mediaKeys })))`));
  await shot('selftest-6-drm.png');

  // 6) Spotify's web player loads (playing needs your own login).
  await open('https://open.spotify.com/', 9000);
  console.log('RESULT spotify    ', await guest(identity));
  await shot('selftest-7-spotify.png');
  app.exit(0); // not quit(): a page's "leave site?" handler can veto that and hang the run
};
