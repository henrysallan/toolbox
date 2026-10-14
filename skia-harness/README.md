# skia-harness

A minimal Expo app that plays a toolbox → React Native Skia export
(`src/bundle/`, written by `npm run export:skia` in the toolbox root) on
a master Reanimated clock. Spec: `../specdocs/101326_skia-target.md`.

- `npm run web` — play it in a browser (CanvasKit / WebGL).
- `npm run export:web` — static build in `dist/`; the toolbox root's
  `npm run parity:skia` serves it, captures frames, and diffs them against
  toolbox's own render.
- `npx expo run:ios` — dev build on the iOS Simulator (needs Xcode). React
  Native Skia v3 does not run in Expo Go.

Two more slots, chosen on the web with `?bundle=`: `scene` plays
`src/bundle-scene/` (`--fixture aurora-scene`), `baked` plays
`src/bundle-baked/` — the same Aurora node exported with
`--animation baked`, its timeline compiled into the SkSL and driven by
iTime alone (`npm run parity:skia -- --bundle baked`), and `text` plays
`src/bundle-text/` (`--fixture text`: Text (Skia) paragraphs with
leading, anchors, letter spacing and a blend group; its fonts ship in
`assets/` — `npm run parity:skia -- --bundle text`).

`src/bundle/` is generated; regenerate instead of editing it. Install
packages with `npx expo install` (`.npmrc` sets `legacy-peer-deps`:
Reanimated 4.7's peer range rejects the RN 0.88 release candidate).

## Capture mode (device parity)

`capture.ts` holds the one snapshot routine every platform uses:
`makeImageSnapshot().readPixels()` as RGBA8 unpremultiplied, retried until
two consecutive snapshots are identical. Sizes are **device pixels** — the
canvas is `size / PixelRatio` points — so a 512 capture is 512×512 on a 3×
iPhone, a 2.625× emulator and the 1× web page alike.

- **Web**: `?t=<sec>&size=<px>&chrome=0`, then
  `window.__toolboxHarness.capture(t)` (used by `npm run parity:skia`).
  `?segment=<name>` loops one of the bundle's SEGMENTS (the composition's
  timeline markers) instead of the whole timeline; with the chrome on, a
  button row drives the clock (`loopSegment` / `playAll` / `pause` /
  `play`), and `window.__toolboxHarness.clock()` is the live
  `useToolboxClock()` object.
- **Native**: deep links (scheme `toolboxharness`, set in `app.json`):
  - `toolboxharness://hello?run=<id>&host=<url>` → `POST <host>/hello`
  - `toolboxharness://capture?t=<sec>&frame=<n>&size=<px>&run=<id>&host=<url>`
    → freezes the clock at `t` (for the rest of the session), waits for
    Skia, `POST <host>/frame` with the pixels as base64
  - failures → `POST <host>/error`

  `host` must be loopback (`127.0.0.1` / `localhost` from the iOS
  Simulator, `10.0.2.2` from the Android emulator). Release builds reach it
  over plain http through `NSAllowsLocalNetworking` (iOS) and
  `plugins/with-loopback-http.js` (Android: a network security config that
  permits cleartext to those three hosts only).

`npm run parity:skia:device -- --platform ios|android` (toolbox root,
`scripts/skia-device-parity.mjs`) drives all of it: `expo prebuild`, a
Release build, simulator/emulator boot, install, the links, and the
comparison against `scripts/fixtures/skia/golden/`. It needs Xcode (iOS) or
the Android SDK + an emulator; on this project it runs in GitHub Actions
(`.github/workflows/skia-device-parity.yml`, dispatch only).

**What a native snapshot is.** react-native-skia 3.4.0 replays a declarative
canvas into an offscreen **sRGB** surface for `makeImageSnapshot()`, even
when the on-screen view renders in Display P3 (iOS picks P3 whenever the
screen's gamut is P3; there is no Canvas prop to pin sRGB). The captures
measure the device GPU's math in sRGB, not the screen's colors.
