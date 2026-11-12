// Builds docs/bookmarklet.txt: the extension's page script as a javascript: bookmark, for
// browsers that cannot install the extension (iPhone Safari). Run: node scripts/build-bookmarklet.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let code = fs.readFileSync(path.join(root, 'extension/page.js'), 'utf8');
code = code.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
const bookmarklet = 'javascript:' + encodeURIComponent('window.__blowoutBookmarklet=1;' + code);
fs.writeFileSync(path.join(root, 'docs/bookmarklet.txt'), bookmarklet);
console.log('bookmarklet.txt', bookmarklet.length, 'chars');
