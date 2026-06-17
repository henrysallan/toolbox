# Mouse-input UX (spec)

Snapshot 2026-06-17. The editor's pan/zoom is built entirely on the **trackpad
idiom** (plain scroll = pan, Cmd/Ctrl + scroll = zoom) across every surface.
This adds first-class **mouse** support without losing the trackpad behavior.

## Goals (owner)

1. Node editor + preview canvas: a **mouse wheel zooms** (not pan).
2. Layers / Tracks / Graph: **middle-drag pans that editor** — today a
   middle-drag there bleeds through and pans the preview canvas instead.
3. Layers / Tracks / Graph: **mouse wheel zooms**, and **Cmd/Ctrl + middle-drag
   zooms** (horizontal = time, vertical = value where applicable).

## Decisions (settled with owner)

- **Auto-detect device + manual override.** A heuristic classifies each wheel
  gesture as mouse vs trackpad; an `Input device: Auto / Mouse / Trackpad`
  setting can force it. Default Auto. Stored in **localStorage** (input device
  is physically per-machine — not an account-level pref; works signed-out).
- **Graph editor mouse-wheel zoom = both axes about the cursor** (uniform).
  Cmd/Ctrl + middle-drag keeps per-axis control there: horizontal = time zoom,
  vertical = value zoom.

## Current behavior (grounding)

- Node editor ([NodeEditor.tsx:1305](src/components/effects/NodeEditor.tsx#L1305)):
  `panOnScroll` + `zoomOnScroll={false}`; middle-drag pans (`panOnDrag={[1]}`).
- Preview canvas ([EffectsApp.tsx:7158](src/components/effects/EffectsApp.tsx#L7158)):
  window-level wheel (plain pan / Cmd zoom) + window-level middle-drag pan,
  both hit-tested against the viewport rect.
- Layers/Track/Playback/Graph each own a `pixelsPerTick`/`viewSpan` scale and a
  wheel handler (plain pan / Cmd zoom). **PlaybackBar + TrackEditor already
  middle-drag pan but don't `stopPropagation`**, so the window canvas pan
  handler fires too → bug #2. LayersEditor/GraphEditor middle-pan support is
  partial/absent.

## Design

### `input-device` module (new, `src/components/effects/input-device.ts`)

Single source of truth, usable from both React and raw window handlers.

- localStorage `toolbox:input-device` → `"auto" | "mouse" | "trackpad"`
  (default `"auto"`). `getInputOverride()` / `setInputOverride()`.
- `classifyWheel(e): "mouse" | "trackpad" | null` — heuristic:
  - `e.ctrlKey` → `null` (pinch-zoom / explicit zoom; don't classify).
  - **Legacy `wheelDeltaY` first — the only reliable signal on macOS**, where
    the OS smooths a physical mouse wheel into trackpad-like fractional
    `deltaY` that fools size/integer checks. Blink/WebKit trackpads satisfy
    `wheelDeltaY === deltaY * -3` exactly (→ trackpad); a mouse wheel reports
    notch-quantized `±120` multiples (→ mouse).
  - `e.deltaMode !== 0` (line/page) → `"mouse"` (e.g. Firefox).
  - `e.deltaX !== 0` → `"trackpad"`.
  - small (`|deltaY| < 8`) or fractional `deltaY` → `"trackpad"` (inertia).
  - large vertical-only integer delta → `"mouse"`.
- Sticky `detected`: the **first** classification latches immediately (so the
  first mouse notch zooms); later mouse↔trackpad flips need 2 agreeing events
  (hysteresis) so a single ambiguous event can't toggle mid-scroll.
- `getEffectiveDevice(): "mouse" | "trackpad"` = override==="auto" ?
  (detected ?? **"trackpad"**) : override. Defaults to trackpad until a mouse
  gesture is seen → no behavior change for existing trackpad users.
- `wheelWantsZoom(e)` = `e.ctrlKey || e.metaKey || getEffectiveDevice()==="mouse"`.
  The one predicate every wheel handler switches on.
- `subscribe(cb)` + `useEffectiveDevice()` / `useInputOverride()` hooks so the
  node editor re-renders when the device/override changes.
- One capture-phase window `wheel` listener (mounted once in EffectsApp) feeds
  `classifyWheel` so detection is current regardless of which handler consumes
  the event.

### Per-surface changes

- **Node editor**: `panOnScroll={device!=="mouse"}`, `zoomOnScroll={device==="mouse"}`
  (keep `zoomOnPinch`, keep middle `panOnDrag`). Cmd/Ctrl + middle-drag zooms
  (vertical drag; up = zoom in): a capture-phase `mousedown` listener on the
  wrapper steals the gesture from d3-zoom (which pans on `mousedown`) and drives
  `setViewport` about the press point.
- **Canvas viewport** (`useViewportGestures`): `isZoom = wheelWantsZoom(e)`;
  middle-drag pans, Cmd/Ctrl + middle-drag zooms about the press point
  (vertical drag; up = zoom in).
- **Timeline wheel handlers** (Layers/Track/Playback/Graph): swap the
  `metaKey||ctrlKey` zoom test for `wheelWantsZoom(e)`. Graph: when device is
  mouse, zoom **both** axes about the cursor with the dominant delta; trackpad
  + Cmd keeps the existing per-axis zoom.
- **Timeline middle-drag**:
  - Add `e.stopPropagation()` to every middle-`pointerdown` (fixes the canvas
    bleed-through — the window handler is bubble-phase, so this is sufficient).
  - Ensure all four pan on middle-drag (add to Layers/Graph as needed).
  - Cmd/Ctrl + middle-drag = zoom-drag, anchored at the press point. The
    time-only editors (Layers/Tracks/PlaybackBar) zoom on **vertical** drag
    (up = zoom in), matching the canvas + node editor. The Graph editor keeps
    per-axis control: horizontal = time zoom, vertical = value zoom.

### Settings UI

Add an `Input device` segmented control (Auto / Mouse / Trackpad) to
`UserPreferencesModal`. localStorage-backed, always editable (no sign-in gate,
unlike the API-key fields).

## Risks / test notes

- The mouse/trackpad heuristic is inherently imperfect (Magic Mouse, exotic
  wheels); the override is the escape hatch. Default-trackpad-until-proven-mouse
  guarantees no regression for current users.
- Manual test matrix: trackpad two-finger pan + pinch still work in all five
  surfaces; mouse wheel zooms in all five; middle-drag pans each timeline
  without moving the canvas; Cmd+middle-drag zooms time (and value in Graph).
- No automated tests in this repo — verify in-browser on both devices.
