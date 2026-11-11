// Lyrics and translations for the Now Playing screen. Runs in the main process so the
// app window itself never talks to the network.
//
//   lyrics:      LRCLIB (https://lrclib.net), a free, open lyrics database with timed lines
//   translation: Google Translate's free web endpoint. It is unofficial and may be rate
//                limited or change; swap out translate() to use another service.
const { ipcMain, net } = require('electron');

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
const CLUTTER = /\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|hd|4k|mv|explicit)\b[^)\]]*[)\]]/gi;
const tidyTitle = (title) => title.replace(CLUTTER, '').trim();
const tidyArtist = (artist) => artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();

async function search(title, artist, duration, strict) {
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set('artist_name', artist);
  let results = (await getJson(`${LRCLIB}/search?${params}`)) || [];
  results = results.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental);
  const off = (r) => (duration ? Math.abs(r.duration - duration) : 0);
  // A bare file name can match the wrong song, so files must also match on length.
  if (strict) results = results.filter((r) => off(r) <= 3);
  results.sort((a, b) => Boolean(b.syncedLyrics) - Boolean(a.syncedLyrics) || off(a) - off(b));
  return results[0] || null;
}

async function find({ title = '', artist = '', duration = 0, strict = false }) {
  const t = tidyTitle(title);
  const a = tidyArtist(artist);
  let hit = t ? await search(t, a, duration, strict) : null;
  // "Artist - Song" all in the title (YouTube uploads, file names).
  const parts = t.split(/\s+[-–—]\s+/);
  if (!hit && parts.length === 2) hit = await search(parts[1], parts[0], duration, strict);
  if (!hit) return null;
  return {
    synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
    plain: hit.plainLyrics || '',
    instrumental: Boolean(hit.instrumental),
    matched: `${hit.artistName} - ${hit.trackName}`,
  };
}

async function translate(lines, lang) {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) return null;
  const out = [];
  let from = '';
  for (let start = 0; start < lines.length;) {
    // Send a batch of lines at a time, joined by newlines so they come back line for line.
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end].length < 900)) size += lines[end++].length + 1;
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

module.exports = function registerLyrics(isHost) {
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
  ipcMain.handle('lyrics:translate', (event, lines, lang) => (isHost(event) ? translate(lines, lang) : null));
};
