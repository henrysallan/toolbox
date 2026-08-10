# Audio v2 — closing the loop (taps, export, modulation, polish)

Spec — 2026-08-09. Status: **M-A, M-C, M-D and the core of M-B shipped**
(same day). Parent: [080826_audio-nodes.md](080826_audio-nodes.md) (M0+M1
shipped — descriptor/reconciler engine, 21 nodes, revised audibility).

## As built (deltas from the sections below)

- **M-A shipped as designed.** ChainTapProvider is INJECTED into
  audio-analysis.ts by audio-engine.ts at load (a static import would
  cycle through the shared-context imports). Offline tap buffers render
  from scene t=0 with CHUNKED growth (30s min, doubled on overrun —
  deterministic prefix means no analysis seam), invalidated by
  `chainSignature` (content, not identity — stable:false upstreams churn
  identity every eval), capped at 4 buffers. renderOffline calls are now
  SERIALIZED through a queue (two Tone.Offline callbacks racing would
  create stages in each other's contexts).
- **M-C shipped as designed** (`mods` on generator/effect/instrument;
  modConns as a second plan edge class; `modTarget` adapter opt-in;
  Audio LFO + cutoff/freq/level/gain/pan mod sockets). One unit nuance:
  Channel's gain mod sums on a LINEAR unity post-stage, not the dB
  volume Param — summing linear signal into dB units is nonsense.
- **M-D shipped with one scope change**: Audio Merge KEEPS numbered lane
  params (they're in saved projects and already keyframe) — solo1..8 +
  def-side resolution landed; the per-lane strip UI is demoted to an
  owner UI conversation. Indicator rides a new module store
  (src/state/audio-audibility.ts, playbackClock pattern) because the
  CustomEvent channels don't replay to late-mounting nodes — and a
  freshly dropped unwired node is exactly who needs the badge.
- **M-B core shipped**: element leaves carry offline playback hints
  (sync/loop/startOffset/volume snapshots) and render offline from their
  url via a transport-synced Player; the evaluator exposes
  `exportAudioChains` (authored-audible roots — Output + layer boundary,
  active EXCLUDED); the export path renders all chains in ONE offline
  pass and sums with the legacy element buffer via `mixAudioBuffers`
  (OfflineAudioContext does the resampling).
- **M-B automation SHIPPED** (second pass, same day): keyframed audio
  params render in exports. Design delta from the section below: no
  frame-loop recorder — `lib/export-audio-automation.ts` samples the
  animation blocks DIRECTLY across the export window (pure data, no
  second render pass) into an `AudioAutomationTimeline`;
  `renderOffline` replays it as scheduled ramps via the adapters'
  `update(next, u, at)` third argument (continuous params schedule at
  `at`, discrete params guard `at === undefined` — enum keyframing is
  not supported automation). Coverage is keyframes only, by design:
  wire-driven params, Crossfade `fade` / Merge lane gains (their knobs
  land in mix lanes, not stage params), and enums still export as
  start-of-window snapshots. Harness proof: an 80→4000Hz keyframed
  cutoff sweep renders with a 39× RMS ratio between its choked opening
  and open tail.
- **M-B fast path SHIPPED**: the MediaRecorder tier captures chain audio
  via a master MediaStreamDestination (`audioEngine.getCaptureTrack`),
  folding bare element sources into the same track through the shared
  element-source registry.
- **M-B remaining — exported APPS (deferred by owner decision,
  2026-08-09)**: Tone in the export-template bundle + LiveViewer
  transport + manifest bpm. Editor exports sound; exported standalone
  apps stay mute until this lands.
- Verification: `check-audio-chain.mts` now 43 cases (mod edges);
  `check:audio-live` runs 13 metrics across six scenarios — osc→filter,
  notes→synth→delay→reverb live, offline determinism incl. the
  BitCrusher worklet, getAudioFrame chain taps live+offline, LFO wobble
  (RMS spread proves the mod MOVES), element-leaf offline from a
  synthesized WAV url.

## Why

M0+M1 made sound. Three loops are still open, and they are the ones that
make the audio system *matter* in a motion-design tool:

1. **Audio-reactive visuals from synthesized audio.** Audio Bands/Pitch/
   Spectral and the audio→scalar coercion still read only media ELEMENTS.
   A synth chain's AudioValue carries no element, so the app's whole
   reason for having audio — driving visuals — doesn't work for the
   sounds the app itself makes. (M1's effects pass the raw source element
   through as a stopgap, which analyzes the PRE-effect signal — wrong the
   moment a filter sweep is the thing you want to react to.)
2. **Export doesn't know the new audio exists.** Mixdown still reads only
   the legacy ExportAudioSpec path (one element on Output's audio
   socket). Chains, layer-level audibility, multiple simultaneous sinks,
   keyframed audio params — none of it reaches an exported file or an
   exported app.
3. **No audio-rate modulation.** Frame-rate scalar wires can drive audio
   params (and do, via Bands→cutoff), but a 6Hz wobble or smooth riser
   needs modulation inside the audio clock domain. This was deferred from
   M1 because it extends the descriptor SCHEMA — designed here, not
   improvised.

Plus two UX debts from M1: Audio Merge's numbered-param lanes, and the
silent-when-unrouted failure mode that has already cost one debugging
session.

Out of scope, unchanged: the Sequencer and piano-roll MIDI editor (their
own UI conversation, per the original decision); WebMIDI hardware input;
sends/returns.

## M-A — Chain analysis taps (the killer feature)

`getAudioFrame(value, ctx)` learns a second source: when `value.chain`
exists, resolve through the chain instead of the element.

- **Live**: `audioEngine.getTapAnalyser(chain.nodeId)` (exists since M0)
  — the reconciler drops an AnalyserNode on that stage's output. The
  per-frame cache keys by chain nodeId alongside the element WeakMap.
  Consumption-gated: no analysis consumer, no analyser.
- **Offline**: mirrors the element decode path's shape. At export start
  (or on first offline frame, same settle handshake as decode), render
  the tapped chain once via `renderOffline` over the export window into
  an AudioBuffer; each frame slices the fftSize window at
  `ctx.time` (buffer time = scene time − window start). One render per
  DISTINCT tapped chain root; the mixdown render (M-B) reuses the same
  buffers when the tap point is a sink.
- **Precedence**: chain tap WINS over the passthrough element when both
  are present — that flips the M1 stopgap from "analyzes the wrong
  signal" to "element is the fallback for chainless values". The
  passthrough on effect AudioValues then stays only as audio→scalar
  compatibility for exotic cases, and can be removed once verified
  unused.
- Audio Bands / Pitch / Spectral / coerce audio→scalar all ride
  `getAudioFrame`, so node changes are minimal (Spectral's offline
  history path also gains the chain branch).

## M-B — Export integration

- **Collection**: exports mix what the editor deems audible — the SAME
  three-sink rule (Output audio socket, layer-boundary audition
  producers, minus audition-by-active, which is an editor gesture and
  must NOT leak into exports). The evaluator already computes this;
  expose the audible chain roots + the legacy element specs from the
  final pre-export eval, and export both: chains via `renderOffline`,
  elements via the existing ExportAudioSpec path, summed into one
  mixdown buffer → existing WAV/mediabunny mux unchanged downstream.
- **Param automation** (the M0 spec's known gap): a keyframed cutoff
  sweep currently renders as a single start-of-window snapshot offline.
  Fix: during the export frame loop the evaluator already produces a
  descriptor per frame — record `(timeSec, stage params)` snapshots for
  audible stages (pure data, cheap), and `renderOffline` replays them as
  scheduled automation: `signal.setValueAtTime`-chains at frame
  boundaries (linearRampTo between, matching the live RAMP_SEC feel).
  Notes/mix-lane changes mid-window replay the same way (reschedule at
  snapshot time). Adapter contract change: `update` gains an optional
  `at?: number` transport-seconds argument — absent = live (ramp now),
  present = offline (schedule at time).
- **Element leaves offline**: finish the M0 TODO — a leaf with a url
  decodes (existing decode cache) and plays as a BufferSource scheduled
  to the element's timeline behavior (sync/loop/offset read from the
  source node's stage snapshot). Mic stays silent offline (rule stands).
- **Exported apps / LiveViewer**: Tone joins the export-template bundle
  ONLY when the project's graph contains audio-chain nodes (packager
  per-feature gating precedent: fonts/wasm). LiveViewer drives
  `audioEngine.reconcile` from its own clock (it already calls
  evaluateGraph, so this mostly falls out — verify autoplay gesture
  handling on the exported page's play button). Manifest carries `bpm`.
- **BitCrusher worklet caveat is already fixed** (M1) — offline renders
  await `workletsAreReady`; keep the harness scenario as the regression
  guard.

## M-C — Audio LFO + modulation inputs (schema extension)

The one descriptor-schema change of this spec, designed here so it stays
coherent:

```ts
// On generator / effect / instrument stages (types.ts):
mods?: { param: string; chain: AudioChainNode }[];
```

- **Audio LFO node** (`audio-lfo`, generator): params `shape` (sine /
  square / sawtooth / triangle), `rate` (Hz, 0.01..40 — audio-rate FM via
  higher rates is future scope), `min` / `max` (the output RANGE, in the
  destination param's units), `phase`. Emits a generator descriptor
  (`gen:"lfo"`); adapter = Tone.LFO (`.start()`, deterministic phase-0
  offline).
- **Mod input sockets**: consumers declare optional `audio`-typed inputs
  named `<param>_mod` (`cutoff_mod` on Filter; `freq_mod`, `level_mod` on
  Oscillator; `gain_mod`, `pan_mod` on Channel — v1 set, chosen because
  each maps to a genuine Tone Signal). A def with a wired mod input adds
  `{ param: "cutoff", chain: modChain }` to its descriptor's `mods`.
  Type-wise it's just audio→audio, so no coercion/validation work; the
  socket NAME carries the meaning, mirroring how `in:param:` handles
  already work for scalar wires.
- **Semantics**: WebAudio a-rate summing — the engine connects the mod
  stage's output INTO the destination Tone Signal, where it SUMS with
  the base value. The LFO's min/max therefore express DEVIATION range
  around the knob value (min −1200/max +1200 on cutoff_mod = ±1200 Hz
  sweep). Attenuation lives on the LFO (source-side depth), not the
  destination — one less param per mod input, and matches how the LFO
  node reads as a "signal you shaped".
- **Engine**: plan/diff already treat inputs positionally; mods become a
  SECOND edge class — `AudioStagePlan.modConns: { param, fromId }[]`,
  diffed like inputIds (rewire on change), connected via
  `handles.modTarget(param)` (new optional StageHandles member returning
  the Tone Signal; adapters opt in per param). Any audio chain is legal
  as a modulator (an enveloped synth into cutoff is sidechain-flavored
  wobble — allowed, it's just a signal).
- **Audibility**: a chain consumed ONLY as a modulator is part of the
  routed graph for build purposes but never touches the master — it
  inherits reachability through its consumer (sinkReachableIds already
  walks plan edges; mod edges join that walk for element-claim purposes).

## M-D — Polish debts

- **Audio Merge strip UI + solo**: replace numbered gain1..8/pan/mute
  rows with a per-lane strip (label from the wired upstream node, gain
  slider, pan, M/S buttons) — the merge.ts layer-row pattern, including
  virtual-key keyframing (`mixlane_gain:<i>` etc., clone-and-override in
  evaluator + autokey mirror + per-item diamonds; copy `layer_opacity`).
  Solo resolves at DESCRIPTOR BUILD in the def (soloed set zeroes other
  lanes' gains) — engine untouched, as reserved in M1.
- **Unrouted-chain indicator**: the evaluator already knows the audible
  set (routed detection + audition producers). Expose
  `audibleAudioNodeIds` on EvalResult; EffectsApp stores it per eval;
  EffectNode renders a small muted-speaker glyph on audio-category nodes
  whose output chain reaches no sink (tooltip: "not audible — route to a
  Layer Output audio socket, the Output node, or set Active"). Chip only
  ever shows on `category: "audio"` nodes with audio-typed outputs, so
  the graph stays clean elsewhere.

## Milestones & build shape

- **M-A + M-B share the offline-buffer machinery** — build A first (tap
  + offline chain render + slicing), B rides it. One owner each,
  sequential-ish (B starts once A's render-and-slice lands).
- **M-C** is self-contained (schema + LFO node + adapter opt-ins) — one
  owner, can run parallel to A/B EXCEPT the types.ts/audio-chain.ts
  edits land first (same shared-file discipline as M1).
- **M-D** is two independent tasks, parallel-safe (UI files vs def
  files), good agent candidates once M-C's schema is frozen.
- Gates: extend `check-audio-chain.mts` (mod-edge plan/diff cases),
  extend the live harness (LFO→cutoff wobble RMS variance over time —
  a wobble's tap RMS oscillates, a broken mod doesn't; offline
  automation: render a keyframed-cutoff window twice, compare + assert
  spectral difference between window halves), plus the standing three
  gates.

## Open questions (non-blocking, defaults chosen)

1. Audition-by-active while PAUSED (one-shot note preview / brief drone
   audition on param touch) — deferred; timeline-slaved rule stands
   until it hurts.
2. Delay time in musical divisions (1/8 dotted…) — natural once a
   beats→seconds param convention exists; deferred to the sequencer
   conversation where musical-time UI gets decided.
