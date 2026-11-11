# BLOWOUT

Bass boost and loud the hell out of any song, live. Clipping is a feature.

> **Disclaimer: the Chrome extension (BLOWOUT Link) is not on the Chrome Web Store.** You load it
> yourself as an unpacked extension in Developer mode, so Chrome will show a "disable developer
> mode extensions" warning at startup. It is open source (see `extension/`), only runs on
> music.youtube.com, www.youtube.com and open.spotify.com, and only talks to the BLOWOUT app on
> your own PC. Setup steps are [below](#signing-in-and-using-your-real-chrome-blowout-link).
> BLOWOUT is not affiliated with YouTube, Google or Spotify.

Paste a YouTube, YouTube Music or Spotify link (or open an audio file) and it plays inside the
app with its sound pushed through:

```
media ─► low-shelf (bass) ─► drive (loudness) ─► clipper ─► output volume ─► speakers
```

Nothing is downloaded or saved. The real page plays as normal and only the sound on its way to
your speakers is changed.

## Desktop app (Windows)

**[Download the installer](https://github.com/sucaline/blowout/releases/latest)** and run it. It is
not code-signed, so Windows SmartScreen will warn the first time: More info, then Run anyway.

Or run it from source:

```bash
npm install
npm start
```

`npm run build` makes a double-click `BLOWOUT.exe` in `dist/BLOWOUT-win32-x64`.

`npm run installer` makes `dist/installer/BLOWOUT-Setup-<version>.exe`, a one-click installer that
puts BLOWOUT in the Start menu and on the desktop, with an uninstaller. It is not code-signed, so
Windows SmartScreen will warn the first time it runs (More info, then Run anyway).

- **Links:** the address bar takes a link, a `spotify:` URI, or plain words (searches YouTube).
- **Files:** OPEN FILE or drag one in (.mp3, .wav, .flac, .ogg, .m4a).
- **Controls:** BASS and LOUD go to +40 dB each, three clip styles, four presets.
- **Output volume** comes after the clipper, so you can keep the crunch and turn the level down.

### Now Playing and lyrics

Pick a song on YouTube Music or Spotify, or open a file, and the app switches to a Now Playing
screen: artwork, transport, and timed lyrics that follow the song. Everything on it moves with the
bass and glitches when the signal clips. NOW PLAYING in the top bar brings it up for any page
that reports a song (including plain YouTube); OPEN PAGE goes back to the site.

- **Lyrics** come from [LRCLIB](https://lrclib.net), a free open lyrics database. Click a line to
  jump there. LYRICS TIMING nudges them when a video has an intro the album version doesn't.
- **TRANSLATE** shows a translation under each line, using Google Translate's free web endpoint.
  That endpoint is unofficial and may be rate limited or stop working; `translate()` in
  `lyrics.js` is the one place to swap in another service.
- **Privacy:** to do this the app sends the song's title and artist to LRCLIB, and the lyric lines
  to Google when TRANSLATE is on. Nothing else leaves your PC.
- Files only have their name to go on, so name them `Artist - Song.mp3` for lyrics to be found.

### Signing in, and using your real Chrome (BLOWOUT Link)

Spotify: sign in on Spotify's own page inside the app. Your details go straight to Spotify.

Google (YouTube, YouTube Music): **not possible inside the app.** Google refuses sign-ins from any
browser embedded in an app ("This browser or app may not be secure"). Signed out, they still play
in the app, with ads and without your library.

To use your signed-in account, play the music in your real Chrome and let the app run it from
there. The **BLOWOUT Link** extension (the `extension/` folder, also bundled with the installed
app) boosts the audio inside Chrome and connects to the app, which stays the control panel:
sliders, presets, Now Playing, lyrics, play/pause/seek/skip.

1. Open the BLOWOUT app, click **USE MY SIGNED-IN CHROME INSTEAD**, then **SHOW THE FOLDER**.
2. In Chrome open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose that BLOWOUT Link folder.
4. Open YouTube Music (or YouTube, or Spotify) in Chrome and play something. Tabs that were
   already open need one refresh.

The app shows **CHROME LINKED** and jumps to Now Playing. Edge and other Chromium browsers work
the same way. How it's wired:

- The extension only runs on music.youtube.com, www.youtube.com and open.spotify.com.
- It talks to the app over a connection that never leaves your PC (`127.0.0.1:38765`), and the
  app only accepts browser extensions on it, not websites.
- With the app closed, the extension leaves the page's audio untouched.
- Chrome may nag about "developer mode extensions" at startup; that is the price of loading an
  extension that isn't from the Chrome Web Store.

### Spotify

Spotify's web player is DRM-protected, so the app runs on the
[castlabs Electron build](https://github.com/castlabs/electron-releases), which adds Google's
Widevine module (fetched from Google on first launch). The build here is not VMP-signed; if
Spotify ever refuses to play, that is the first thing to look at.

## Phone web app (iPhone, Android)

`docs/` is a small installable web app with the same chain for audio files on your phone, live at
**https://sucaline.github.io/blowout/**. It cannot do links: phone browsers don't let a page touch
another site's audio.

### Install on iPhone / iPad

There is no App Store download. It installs from Safari in under a minute:

1. On the iPhone, open **https://sucaline.github.io/blowout/** in **Safari**.
2. Tap the **Share** button (the square with an arrow pointing up).
3. Scroll down and tap **Add to Home Screen**, then **Add**.
4. Open **BLOWOUT** from the Home Screen. It runs full screen like a normal app and works offline
   after the first launch.

Using it:

1. Tap **CHOOSE A SONG** and pick an audio file from the Files app (.mp3, .m4a, .wav).
2. Pick a preset or drag BASS and LOUD. Start with OUTPUT VOLUME low: it comes after the clipper,
   so the crunch stays and only the level drops.

Good to know:

- **It needs actual audio files.** Songs inside Apple Music, Spotify or YouTube are not files and
  can't be picked. Get files onto the phone with AirDrop, iCloud Drive, or by saving a download to
  Files.
- **Nothing is uploaded.** The song is processed on the phone.
- **Updates are automatic.** Opening the app with a connection picks up the latest version.
- **To remove it,** press and hold the icon and tap Remove App.
- If there is no sound, tap the play button once more (iOS only starts audio from a tap) and check
  the phone's volume.
- Playback may pause when the screen locks or you switch apps; iOS decides that for web apps.

On Android the same link works in Chrome: menu, then **Add to Home screen** / **Install app**.

## Self-test

`npm run selftest` opens the app muted and checks that sound really flows through the chain for a
file, a YouTube video, an off-page player, and DRM-protected audio. It uses a throwaway profile.

## License

[GNU General Public License v3.0](LICENSE) or later.
