// Google refuses to sign anyone in from a browser it can tell is embedded in an app ("This browser
// or app may not be secure"). It reads the User-Agent and the Chromium client hints. Firefox is
// not an embeddable engine, so on Google's own sign-in pages only, the app introduces itself as
// Firefox and drops the Chromium hints (preload.js makes the page itself agree). Every other site
// still sees plain Chrome, and once you are signed in the cookies work everywhere (YouTube,
// YouTube Music).
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const SIGN_IN = ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'];

function allowGoogleSignIn(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: SIGN_IN }, (details, done) => {
    const headers = { ...details.requestHeaders, 'User-Agent': FIREFOX };
    for (const name of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(name)) delete headers[name];
    }
    done({ requestHeaders: headers });
  });
}

module.exports = { allowGoogleSignIn };
