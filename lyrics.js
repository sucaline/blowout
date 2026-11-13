// Lyrics and translations for the Now Playing screen. Runs in the main process so the
// app window itself never talks to the network.
//
//   lyrics:      LRCLIB (https://lrclib.net), a free, open lyrics database with timed lines
//   translation: Google Translate's free web endpoint. It is unofficial and may be rate
//                limited or change; swap out translate() to use another service.
const { app, ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');

const LRCLIB = 'https://lrclib.net/api';
const HEADERS = { 'User-Agent': 'BLOWOUT/1.0 (desktop music player)' };

async function getJson(url) {
  try {
    const res = await net.fetch(url, { headers: HEADERS });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // offline, blocked, or the service is down: just no lyrics
  }
}

function parseLrc(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(raw.trim());
    if (m) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3] });
  }
  return lines;
}

// YouTube titles carry clutter like "(Official Video)" and channel names like "ArtistVEVO".
// Edits of a song (sped up, slowed, nightcore...) are a different length from the original, so
// lyrics for them come from the original song with the timing stretched to fit.
const TEMPO = /\b(sped[\s-]*up|speed(ed)?[\s-]*up|slowed|nightcore|reverb(ed)?|8d)\b/i;
const CLUTTER = /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|4k|mv|explicit|sped[\s-]*up|speed(ed)?[\s-]*up|slowed|nightcore|reverb(ed)?|8d|tiktok)\b[^)\]]*[)\]]/gi;
const tidyTitle = (title) => title.split(/\s+\|\s+/)[0].replace(CLUTTER, '').replace(/\s+/g, ' ').trim();
const tidyArtist = (artist) => artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();

// Does a database entry really name the song we are playing? (A close length alone is not enough:
// that is how a pop song ended up with the lyrics of an unrelated Chinese one.)
const norm = (s) => String(s || '').toLowerCase().replace(/[([].*?[)\]]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  const wa = new Set(x.split(' '));
  const wb = new Set(y.split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size) >= 0.6 && common >= 1 && Math.min(wa.size, wb.size) >= 2;
}
// `ids` = who the song is by: [artist from the title ("Artist - Song"), the uploader's name].
function matches(name, who, wanted, ids) {
  if (!similar(name, wanted.song)) return false;
  if (norm(name) === norm(wanted.song) && !wanted.byInTitle) return true; // exact name, artist only a channel name
  return ids.filter(Boolean).some((id) => similar(who, id));
}

// How far off is a length? Edits are allowed to be any length (the timing gets stretched).
function lengthOk(candidate, wanted, limit) {
  if (!wanted.duration || !candidate) return true;
  if (wanted.tempo) return candidate / wanted.duration > 0.5 && candidate / wanted.duration < 2;
  return Math.abs(candidate - wanted.duration) <= limit;
}

async function search(wanted, artist, strict) {
  const params = new URLSearchParams({ track_name: wanted.song });
  if (wanted.by || artist) params.set('artist_name', wanted.by || artist);
  let results = (await getJson(`${LRCLIB}/search?${params}`)) || [];
  results = results.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental);
  const off = (r) => (wanted.duration ? Math.abs(r.duration - wanted.duration) : 0);
  // A bare file name can match the wrong song, so files must also match on length.
  results = results.filter((r) => matches(r.trackName, r.artistName, wanted, [wanted.by, artist]) && lengthOk(r.duration, wanted, strict ? 3 : 25));
  results.sort((a, b) => Boolean(b.syncedLyrics) - Boolean(a.syncedLyrics) || off(a) - off(b));
  return results[0] || null;
}

// Fallback 1: LRCLIB's free-text search, for titles the exact search can't parse.
async function looseSearch(wanted, artist, strict) {
  const q = new URLSearchParams({ q: `${wanted.by || artist} ${wanted.song}`.trim() });
  let results = ((await getJson(`${LRCLIB}/search?${q}`)) || []).filter((r) => r.syncedLyrics || r.plainLyrics);
  const off = (r) => (wanted.duration ? Math.abs(r.duration - wanted.duration) : 0);
  results = results.filter((r) => matches(r.trackName, r.artistName, wanted, [wanted.by, artist]) && lengthOk(r.duration, wanted, strict ? 3 : 12));
  results.sort((a, b) => Boolean(b.syncedLyrics) - Boolean(a.syncedLyrics) || off(a) - off(b));
  return results[0] || null;
}

// Stretch (or squeeze) timed lines from the original's length to the edit's length.
function fit(lines, from, wanted) {
  if (!lines || !wanted.tempo || !from || !wanted.duration) return lines;
  const k = wanted.duration / from;
  return k > 0.5 && k < 2 ? lines.map((l) => ({ ...l, t: l.t * k })) : lines;
}

// Fallback 2: NetEase Cloud Music's public endpoints, which have timed lyrics for a lot of
// songs LRCLIB lacks. Unofficial, so it may stop working; a miss just falls through.
async function neteaseSearch(wanted, artist) {
  const s = new URLSearchParams({ s: `${wanted.by || artist} ${wanted.song}`.trim(), type: '1', limit: '8' });
  const found = await getJson(`https://music.163.com/api/search/get?${s}`);
  const songs = (found && found.result && found.result.songs) || [];
  const off = (song) => (wanted.duration ? Math.abs(song.duration / 1000 - wanted.duration) : 0);
  const named = songs.filter((x) => lengthOk(x.duration / 1000, wanted, 6)
    && matches(x.name, (x.artists || []).map((a) => a.name).join(' '), wanted, [wanted.by, artist]));
  for (const song of named.sort((x, y) => off(x) - off(y))) {
    const data = await getJson(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1`);
    const lrc = data && data.lrc && data.lrc.lyric;
    const synced = lrc ? parseLrc(lrc).filter((l) => l.text) : [];
    if (synced.length > 3) {
      return { synced: fit(synced, song.duration / 1000, wanted), plain: '', instrumental: false, matched: `${song.artists[0].name} - ${song.name}` };
    }
  }
  return null;
}

// Fallback 3: lyrics.ovh, plain text with no timing, better than nothing.
async function ovhSearch(title, artist) {
  if (!artist || !title) return null;
  const data = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  const plain = data && data.lyrics ? data.lyrics.replace(/^Paroles de la chanson[^\n]*\n/, '').replace(/\r/g, '').trim() : '';
  return plain ? { synced: null, plain, instrumental: false, matched: `${artist} - ${title}` } : null;
}

async function find({ title = '', artist = '', duration = 0, strict = false }) {
  const t = tidyTitle(title);
  const a = tidyArtist(artist);
  // "Artist - Song" all in the title (YouTube uploads, file names).
  const parts = t.split(/\s+[-–—]\s+/);
  const byInTitle = parts.length === 2;
  const [song, by] = byInTitle ? [parts[1], parts[0]] : [t, ''];
  const wanted = { song, by, byInTitle, duration, tempo: TEMPO.test(title) };

  // Other spellings of the same song to try: the whole title, then just the song part.
  let hit = t ? await search(wanted, a, strict) : null;
  if (!hit && t) hit = await looseSearch(wanted, a, strict);
  if (hit) {
    return {
      synced: hit.syncedLyrics ? fit(parseLrc(hit.syncedLyrics), hit.duration, wanted) : null,
      plain: hit.plainLyrics || '',
      instrumental: Boolean(hit.instrumental),
      matched: `${hit.artistName} - ${hit.trackName}`,
    };
  }
  if (!t) return null;
  // Files only have their name to go on, so skip the sources that can't check the length.
  return (await neteaseSearch(wanted, a)) || (strict ? null : await ovhSearch(song, by || a));
}

async function translate(lines, lang) {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) return null;
  const out = [];
  let from = '';
  for (let start = 0; start < lines.length;) {
    // A big batch of lines per request (the endpoint blocks you for a while if you ask too
    // often), joined by newlines so they come back line for line.
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end].length < 1800)) size += lines[end++].length + 1;
    const batch = lines.slice(start, end);
    const q = encodeURIComponent(batch.join('\n'));
    const data = await getJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${q}`);
    if (!data || !Array.isArray(data[0])) return null;
    from = data[2] || from;
    const translated = data[0].map((segment) => segment[0]).join('').split('\n');
    for (let i = 0; i < batch.length; i++) out.push((translated[i] || '').trim());
    start = end;
  }
  return { lines: out, from };
}

// Translations are kept on disk, so each song is only ever sent for translation once.
function translationCache() {
  const file = path.join(app.getPath('userData'), 'translations.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* nothing saved yet */ }
  return {
    get: (key) => saved[key],
    set(key, value) {
      saved[key] = value;
      fs.writeFile(file, JSON.stringify(saved), () => {});
    },
  };
}

module.exports = function registerLyrics(isHost) {
  let cache = null; // opened on first use, once the app knows where its data lives
  const found = new Map();
  ipcMain.handle('lyrics:get', (event, track) => {
    if (!isHost(event)) return null;
    const key = JSON.stringify([track.title, track.artist, Math.round(track.duration || 0), track.strict]);
    if (!found.has(key)) {
      // Remember hits; a miss may have been a network blip, so let it be tried again.
      found.set(key, find(track).then((hit) => { if (!hit) found.delete(key); return hit; }));
    }
    return found.get(key);
  });
  ipcMain.handle('lyrics:translate', async (event, lines, lang) => {
    if (!isHost(event)) return null;
    cache = cache || translationCache();
    const key = `${lang}\n${lines.join('\n')}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const result = await translate(lines, lang);
    if (result) cache.set(key, result);
    return result;
  });
};

module.exports.find = find; // for tests
