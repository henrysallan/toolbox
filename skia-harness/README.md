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

`src/bundle/` is generated; regenerate instead of editing it.
