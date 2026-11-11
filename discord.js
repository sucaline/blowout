// Discord Rich Presence: shows what BLOWOUT is playing on your Discord profile
// ("Listening to BLOWOUT"). It talks to the Discord desktop app on this PC over a local pipe;
// nothing is sent anywhere else. Needs a Discord application ID (see the README).
const { Client } = require('@xhayper/discord-rpc');

module.exports = function startDiscord() {
  let config = { enabled: false, clientId: '' };
  let presence = null; // what the renderer last told us is playing
  let client = null;
  let ready = false;
  let retry = null;
  let state = 'off'; // shown in the settings: off | connecting | on | no-discord | bad-id

  const listeners = new Set();
  const setState = (next) => {
    state = next;
    for (const fn of listeners) fn(state);
  };

  function stop() {
    clearTimeout(retry);
    const old = client;
    client = null;
    ready = false;
    if (old) {
      old.user?.clearActivity().catch(() => {});
      old.destroy().catch(() => {});
    }
    setState('off');
  }

  function connect() {
    clearTimeout(retry);
    if (!config.enabled || !/^\d{15,25}$/.test(config.clientId)) {
      stop();
      if (config.enabled) setState('bad-id');
      return;
    }
    setState('connecting');
    const mine = new Client({ clientId: config.clientId });
    client = mine;
    mine.on('ready', () => {
      if (client !== mine) return;
      ready = true;
      setState('on');
      push();
    });
    mine.on('disconnected', () => {
      if (client !== mine) return;
      ready = false;
      setState('no-discord');
      retry = setTimeout(connect, 15000);
    });
    mine.login().catch((e) => { if (process.env.DISCORD_DEBUG) console.log("login failed:", e && e.message);
      if (client !== mine) return;
      // Discord isn't running (or the ID is wrong); keep trying quietly.
      setState('no-discord');
      retry = setTimeout(() => { mine.destroy().catch(() => {}); connect(); }, 15000);
    });
  }

  function push() {
    if (!ready || !client || !client.user) return;
    if (!presence || !presence.title) {
      client.user.clearActivity().catch(() => {});
      return;
    }
    const p = presence;
    const activity = {
      type: 2, // Listening
      details: p.title.slice(0, 120),
      state: (p.artist ? `by ${p.artist}` : 'BLOWOUT').slice(0, 120),
      largeImageKey: /^https:\/\//.test(p.art || '') && p.art.length < 256 ? p.art : undefined,
      largeImageText: 'BLOWOUT: bass boosted and loud',
      instance: false,
    };
    // A running clock only while playing; paused songs just sit there with no timer.
    if (!p.paused && p.duration > 0) {
      const start = Date.now() - p.position * 1000;
      activity.startTimestamp = Math.round(start);
      activity.endTimestamp = Math.round(start + p.duration * 1000);
    } else if (p.paused) {
      activity.state = `${activity.state} (paused)`.slice(0, 128);
    }
    client.user.setActivity(activity).catch(() => {});
  }

  return {
    configure(next) {
      const changed = next.enabled !== config.enabled || next.clientId !== config.clientId;
      config = { enabled: Boolean(next.enabled), clientId: String(next.clientId || '').trim() };
      if (changed) connect();
    },
    update(next) {
      presence = next;
      push();
    },
    get state() { return state; },
    onState(fn) { listeners.add(fn); },
    stop,
  };
};
