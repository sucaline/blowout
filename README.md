# BLOWOUT

Bass boost and loud the hell out of any song, live. Clipping is a feature.

Paste a YouTube, YouTube Music or Spotify link (or open an audio file) and it plays inside the
app with its sound pushed through:

```
media ─► low-shelf (bass) ─► drive (loudness) ─► clipper ─► output volume ─► speakers
```

Nothing is downloaded or saved. The real page plays as normal and only the sound on its way to
your speakers is changed.

## Desktop app (Windows)

```bash
npm install
npm start
```

`npm run build` makes a double-click `BLOWOUT.exe` in `dist/BLOWOUT-win32-x64`.

`npm run installer` makes `dist/installer/BLOWOUT-Setup-1.0.0.exe`, a one-click installer that puts
BLOWOUT in the Start menu and on the desktop, with an uninstaller. It is not code-signed, so
Windows SmartScreen will warn the first time it runs (More info, then Run anyway).

- **Links:** the address bar takes a link, a `spotify:` URI, or plain words (searches YouTube).
- **Files:** OPEN FILE or drag one in (.mp3, .wav, .flac, .ogg, .m4a).
- **Controls:** BASS and LOUD go to +40 dB each, three clip styles, four presets.
- **Output volume** comes after the clipper, so you can keep the crunch and turn the level down.

### Signing in

Sign in on the site's own page inside the app (YouTube Music, Spotify). Your details go straight
to that site; BLOWOUT never sees them. Google blocks sign-ins from browsers embedded in apps, so
Google's sign-in pages (and only those) are shown a Firefox identity. Google can change that
check at any time.

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
