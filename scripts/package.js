// Packages the app into a folder (the same as `npm run build`, but the output folder is chosen
// by the caller, which helps when dist/ is locked by a running copy of the app):
//   node scripts/package.js dist-1.3
const { packager } = require('@electron/packager');
const path = require('path');

const out = process.argv[2] || 'dist';
packager({
  dir: path.join(__dirname, '..'),
  name: 'BLOWOUT',
  platform: 'win32',
  arch: 'x64',
  out: path.join(__dirname, '..', out),
  overwrite: true,
  icon: path.join(__dirname, '..', 'icon.ico'),
  extraResource: [path.join(__dirname, '..', 'extension')],
  download: { mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/' } },
  // Keep build output, the phone site, the extension source, scripts and tools out of the app.
  ignore: [/^\/dist[^/]*(\/|$)/, /^\/docs(\/|$)/, /^\/extension(\/|$)/, /^\/scripts(\/|$)/, /^\/selftest(\/|$)/, /^\/\.claude(\/|$)/, /^\/\.github(\/|$)/],
}).then((paths) => console.log('packaged', paths.join(', ')));
