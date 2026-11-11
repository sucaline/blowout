// The link to the BLOWOUT Link browser extension (see extension/). The extension boosts
// audio inside your real Chrome, where you're signed in, and connects here so the app can
// be its control panel: settings go out; the song, meter and position come back.
//
// It listens on this computer only (127.0.0.1) and only accepts browser extensions; a
// website can't connect, because browsers stamp every connection with where it came from.
const { WebSocketServer } = require('ws');

const PORT = 38765;

module.exports = function startLink({ onMessage, onChange }) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    verifyClient: ({ origin }) => /^chrome-extension:\/\//.test(origin || ''),
  });
  // Port already taken (a second copy of the app): this copy just runs without the link.
  server.on('error', (err) => console.warn('Chrome link unavailable:', err.message));
  server.on('connection', (socket) => {
    onChange(true);
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return; // not ours
      }
      onMessage(message);
    });
    socket.on('close', () => onChange(server.clients.size > 0));
    socket.on('error', () => {});
  });

  return {
    get linked() {
      return server.clients.size > 0;
    },
    send(message) {
      const text = JSON.stringify(message);
      for (const socket of server.clients) {
        if (socket.readyState === 1) socket.send(text);
      }
    },
  };
};
