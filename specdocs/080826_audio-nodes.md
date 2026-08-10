# Audio nodes — a node-based DAW layer (synthesis, effects, notes)

Spec — 2026-08-08. Status: **M0 + M1 shipped** (M1 2026-08-09, five
parallel build tracks + orchestrator integration). Design decisions at the
bottom.

## M1 as built

All 19 nodes shipped and registered: Noise, Player (generators — offset
now matches Audio Source's skip-into-file meaning) · Synth, FM Synth,
Sampler (instruments) · EQ, Distortion, BitCrusher, Compressor, Limiter,
Channel (tone-shaping) · Delay (+ping-pong via fx-key fold), Reverb
(seeded convolution IR — never Tone.Reverb), Chorus, Phaser (time-based) ·
Audio Merge, Crossfade, Step Pattern, Transpose (routing/notes — the
routing pair are pure descriptor composition onto the `mix` adapter).

Adapters live in per-family modules (`audio-adapters-{generators,
instruments,effects-tone,effects-time,routing}.ts`, contract in
`audio-adapter-types.ts`); `npm run check:audio-live` covers an
osc→filter chain, a notes→synth→delay→reverb live chain, and offline
determinism including the BitCrusher worklet.

Hard-won engine facts recorded during integration:
- **dB-unit Tone Params (Compressor/Limiter threshold, knee) must not
  `rampTo`** — exponential ramps clamp/fail across 0 and sign changes;
  use `targetRampTo`/`setTargetAtTime`.
- **AudioWorklet stages (BitCrusher) render SILENCE offline unless the
  render awaits worklet readiness** — renderOffline now awaits
  `workletsAreReady` (and a data:-URL page is not a secure context, so
  the harness loads from file://).
- Adapter factories are guarded — one throwing stage warns and stays
  silent instead of aborting the diff / zeroing the mixdown.

Deferred out of M1, still owed: **Audio LFO + audio-rate param-mod
inputs** (descriptor schema extension — design before building);
**Audio Merge per-lane strip UI + solo** (lanes are plain numbered params
v1; solo resolves def-side when it lands); **unrouted-chain indicator**
on audio node headers; M2 as specced (chain analysis taps, export
mixdown collection widened to layer/active sinks, export-template
bundling, LiveViewer transport).

## M0 as built — deltas discovered during implementation

Everything below shipped as specced, with four corrections/refinements the
code forced (M1 agents: these are binding):

1. **The app already had ONE AudioContext** — audio-analysis.ts creates it
   for the analyser taps and binds elements via one-shot
   `createMediaElementSource`. So the engine does NOT own a context: Tone
   mounts on `getSharedAudioContext()` and element wraps go through the
   (new) shared `getOrCreateElementSource()` registry, whose `direct` gain
   is the element's gateable default speaker path.
2. **Bare element leaves never enter the engine.** Audio/Video Source
   attach an `element`-kind leaf chain to their AudioValue, but the
   evaluator skips chain roots whose root IS the leaf — a plain
   Source → Output wire keeps the legacy element-direct path and never
   loads Tone. The leaf participates only embedded in a processing chain.
3. **Element claiming follows ROUTED reachability, not stage existence**
   (`sinkReachableIds`): an element feeding an analysis-only (inaudible)
   chain keeps its normal direct path — muting it would silence a
   legitimate parallel Source → Output wire.
4. **`audioRoutedToOutput` walks transitively** through audio-typed inputs
   (source → filter → Output keeps the source unmuted — a muted element
   feeds silence into its MediaElementSource capture too). Dynamic audio
   sockets must resolve from params alone (merge.ts pattern) so the
   pre-pass sees them.
5. **Audibility rule REVISED after first hands-on** (owner decision,
   2026-08-08): requiring a composition-level Output hookup was wrong —
   comp scope is rarely visited. A chain is audible when it reaches ANY
   of: (a) the root Output's `audio` socket (kept, and still what export
   mixes down — M2 must widen export collection to (b)/(c)); (b) a
   **Layer Output boundary's `audio` socket** — wiring audio inside the
   layer is enough. `collectLayerAudioAuditions` (flatten.ts) resolves
   boundary wires to real producers on the RAW graph (the boundary
   dissolves at flatten, so the evaluator also forces these producers
   into the needed set — without that, an unpulled chain never even
   evaluates); clip-gated layers drop their audition (cut out = silent);
   (c) the **Active node** — audition any audio node/chain by making it
   active, no wiring at all. Note (c) also un-mutes an ACTIVE Video/Audio
   Source's element (active = audition applies to element sources too).

Shipped files: engine/audio-chain.ts (pure plans/diff, guarded by
scripts/check-audio-chain.mts — 29 cases in `npm run check`),
engine/audio-engine.ts (Tone reconciler + adapters osc/filter/mix/element,
transport slave, tap + offline APIs), types.ts (`notes` socket, NoteEvent,
AudioValue.chain, AudioChainNode family, ctx.bpm), evaluator reconcile
hook + transitive routing, project bpm (scene block + Project Settings
UI), Oscillator + Filter proving nodes. Gates green (typecheck / check /
lint-ratchet). Live audibility check (Oscillator→Filter→Output in the
browser) still pending — do it before starting M1.

## Why

The app already closes half the audio loop: Audio/Video Source play media,
Audio Bands/Pitch/Spectral read it, and scalars drive visual params. What it
cannot do is *make or transform* sound. The `audio` socket today is an opaque
reference to a playing `HTMLMediaElement`
([types.ts:252](../src/engine/types.ts#L252)) — the wire is a permission slip
("un-mute this element when routed to Output"), not a signal path. Nothing
between a source and the Output node can touch the signal.

This spec upgrades `audio` into a processable signal chain and adds a first
batch of synthesis / effect / note nodes on top of Tone.js — a node DAW that
lives in the same graph as the visuals. The differentiating payoff: a synth
chain's bass line driving a visual param through Audio Bands, authored,
played back, and **exported deterministically**, in one graph. No other tool
does that.

## The core constraint: two clocks

The visual engine evaluates at frame rate (pull-based, fingerprint-cached).
Audio runs at 48kHz on a realtime thread. Audio samples can never be computed
inside `compute()`. Therefore:

**Audio node defs emit descriptors; a reconciler owns the live graph.**

Every audio node's `compute()` returns a cheap immutable CPU value describing
its stage — `{ kind: "effect", effect: "filter", nodeId, params, input:
<upstream descriptor> }`. One engine module (`engine/audio-engine.ts`, the
audio analog of gl.ts's `EngineBackend`) receives the descriptor tree that
arrives at the Output node each eval and reconciles a persistent Tone.js
graph against it: new stage → instantiate, removed stage → dispose, changed
param → ramp (`setTargetAtTime`-style smoothing, no zipper noise).

This is the codebase's established pattern for "describe now, execute
elsewhere":

- SDF nodes build ASTs; SDF Rasterize compiles the tree (zero GL in defs).
- Particle force/emitter/collider nodes emit CPU structs; the simulator
  consumes them.

And it is what makes the two hard requirements fall out naturally:

1. **Deterministic export.** The same descriptor tree is instantiated into
   `Tone.Offline` and rendered to an AudioBuffer for the export window,
   feeding the existing WAV-mux path
   ([export-audio.ts](../src/lib/export-audio.ts)) unchanged. An imperative
   "each node owns live Tone objects in ctx.state" design cannot do this
   without a second parallel implementation of every node.
2. **Fingerprint caching just works.** Descriptors are plain values. An
   unchanged chain is a cache hit end-to-end; an animated cutoff changes one
   descriptor field and the reconciler turns it into a param ramp, not a
   rebuild.

### INVARIANT: node defs never import Tone

All Tone.js usage lives behind `audio-engine.ts`. Audio node defs are pure
descriptor emitters — no AudioContext, no Tone import, no `ctx.state` audio
objects. This is what keeps live and offline rendering unified, keeps node
files trivially parallel-buildable, and keeps Tone out of chunks that don't
need it (lazy-import the engine on first audio sink, like vector-kernel's
lazy init).

## Data types — three domains

| Domain | Visual analog | Socket type | Value |
|---|---|---|---|
| Notes (symbolic) | `spline` (vector) | **new `notes`** | `NotesValue`: `{ notes: { pitch, velocity, startTick, durationTicks }[] }`. Times are integer **ticks** — the app's existing timebase (keyframes/clips), exact equality, no float drift. `pitch` is a MIDI note number (float allowed for detune). |
| Audio (signal) | `image` (raster) | existing `audio`, extended | `AudioValue` grows an optional `chain?: AudioChainNode` alongside the legacy `element`. Element-only values keep today's behavior verbatim. |
| Control | `scalar` | existing | Frame-rate modulation is already free: wire any scalar into an exposed audio param (Audio Bands → cutoff works by existing convention). Audio-rate modulation (FM, wobble) stays inside the audio domain via the Audio LFO node — never crosses the socket boundary at frame rate. |

**Instruments are the rasterizers.** Synth/FM/Sampler consume `notes` and
emit `audio` — the one domain-crossing node kind, easy to explain, enforced
by the type system (notes into a delay is a type error, as it should be).
Oscillator/Noise deliberately do NOT consume notes: a free-running drone
through a filter is the "hello world" of the system, and keeping
Instrument = notes→audio keeps the mental model crisp.

No `notes` coercions in v1. No new coercions for `audio`.

### Descriptor shape (engine/audio-chain.ts)

```ts
type AudioChainNode =
  | { kind: "leaf-element"; nodeId: string; source: "file"|"mic"|"video" }
  | { kind: "generator"; nodeId: string; gen: "osc"|"noise"|"player";
      params: AudioParams }
  | { kind: "instrument"; nodeId: string; inst: "synth"|"fm"|"sampler";
      notes: NotesValue; params: AudioParams }
  | { kind: "effect"; nodeId: string; fx: "filter"|"delay"|…;
      params: AudioParams; input: AudioChainNode }
  | { kind: "mix"; nodeId: string;
      inputs: { chain: AudioChainNode; gain: number; pan: number;
                mute: boolean }[] };
```

- `nodeId` (graph node id) is the **reconciliation key** — stable across
  frames, so a param change updates the same live Tone object in place.
  (Iterate/group flatten mints suffixed ids; that's fine — stability across
  frames is what matters, and flatten ids are stable while structure is.)
- Descriptors are immutable; a cache-hit upstream returns the identical
  object, so the reconciler's diff short-circuits on identity before
  comparing fields.
- The `leaf-element` kind is how today's Audio Source / Video Source audio
  enters a chain (see one-way door below). The element itself is looked up
  from the emitting AudioValue, not stored in the descriptor.

### audio-engine.ts API (sketch)

```ts
reconcile(sinks: AudioChainNode[], t: TransportState): void
  // TransportState = { playing, preroll, timeSec, tick, bpm }
getTapAnalyser(chainNodeId: string): AnalyserNode | null   // analysis nodes
renderOffline(chain: AudioChainNode, durationSec, startSec): Promise<AudioBuffer>
dispose(): void
```

## Sync model (decision: timeline-slaved only)

The transport is slaved to the scene clock, never the reverse:

- **Play** → `Tone.start()` if needed (autoplay policy: the context can only
  start on a user gesture — the Play click is one), schedule each
  instrument's notes (Tone.Part) offset to the current scene position.
- **Pause/stop** → cancel scheduled events, `releaseAll()` voices, ramp the
  master gain to 0 over ~30ms (fast enough to feel immediate, slow enough to
  avoid a click). Graph stays built.
- **Seek/scrub** → silence + cancel; reschedule on next play. A scrubbed
  synth stab is worse than silence.
- **Loop** → the scene loop already snaps `time`; the >100ms drift-nudge
  discipline from Audio Source applies to Player-style buffer playback.
- **Layer pre-roll** (`ctx.preroll`) → never audible, never advancing —
  same rule media nodes already obey.

**Audibility keeps the existing convention**: a chain reaches the speakers
only when its AudioValue lands on the Output node's `audio` socket. The
evaluator's routing detection
([evaluator.ts:969](../src/engine/evaluator.ts#L969)) stays; unrouted chains
stay **built but disconnected from destination** so analysis taps and
audio→scalar keep reading live data — the chain equivalent of today's
"advances muted" element behavior.

### Tempo (decision: project BPM setting)

One project-level `bpm` (serialized additively on SavedProject, default 120,
exposed next to fps/duration; `ctx.bpm`). Note-domain nodes author in
beats/divisions and convert to ticks at compute time — so a BPM change
re-generates patterns (Step Pattern output moves), while the stored data
type stays ticks. Whether the future piano-roll stores beats or ticks is
deferred to that conversation.

## Export

- **Mixdown**: if the value on Output's `audio` socket carries a `chain`,
  the exporter calls `renderOffline` for the export window → AudioBuffer →
  existing WAV/mediabunny mux path. Element-only values keep the current
  `ExportAudioSpec` path untouched.
- **Element leaves inside chains** render offline by decoding their URL
  (exactly what export-audio.ts does today) into a BufferSource. Mic leaves
  are silent offline (existing rule).
- **Offline analysis of synth chains**: audio-reactive visuals driven by a
  chain need that chain's samples during offline frame rendering. The
  export's one `renderOffline` pass (or a per-tap render when the tap point
  isn't the sink) produces the buffer; `getAudioFrame` gains a chain-keyed
  offline backend that slices it — riding the existing offline-settle
  mechanism (first frame kicks the render, settle pass captures real data).
  One render serves both mux and analysis.
- **Exported standalone apps**: Tone.js joins the export-template bundle;
  the LiveViewer transport maps play/pause the same way.

## Analysis loop-back (the killer feature)

Audio Bands / Pitch / Spectral and the audio→scalar RMS coercion currently
key on the media element. They learn a second key: chain values resolve
through `getTapAnalyser(chainNodeId)` — the reconciler inserts an
AnalyserNode at that chain point on demand (consumption-gated: no tap, no
analyser). Live and offline backends both extend; the nodes themselves
barely change (audio-analysis.ts already abstracts the two backends behind
`getAudioFrame`).

## Audio Merge (mixer)

Mirrors visual Merge deliberately:

- Dynamic N audio inputs (same add-socket UX as merge.ts).
- Per-input **gain / pan / mute / solo**, keyframable via the virtual-key
  pattern (`mix_gain:<id>` etc. — same machinery as `layer_opacity:<id>`).
- Descriptor: one `mix` node with per-child gain/pan — the reconciler builds
  per-input Gain→Panner into a sum. Solo is resolved at descriptor-build
  time (soloed set mutes the rest), so the engine only ever sees gains.

Crossfade (A/B, equal-power) is the audio Switch/lerp — separate small node.

## Feedback

The evaluator is a DAG; there are no wire cycles. Feedback is a *param*
inside effect nodes (Delay's feedback knob, Reverb decay), same rule the
visual graph lives by. Cross-node feedback routing (sends/returns) is a
future conversation.

## Sharp edges (recorded up front)

- **The MediaElementSource one-way door.** Wrapping an `HTMLMediaElement` in
  a `MediaElementAudioSourceNode` permanently binds it to that AudioContext
  and silences its direct output; wrapping the same element twice throws.
  The reconciler owns a `WeakMap<element, MediaElementAudioSourceNode>` and
  wraps **only when a chain actually processes the element** — a bare
  Audio Source → Output wire keeps today's element-direct path bit-for-bit
  (existing projects keep their sound path and latency).
- **Tone.Reverb generates its IR from random noise** → nondeterministic
  across runs. Generate the IR once per (decay, preDelay) and cache the
  buffer; reuse it for live and offline. Same for **Noise**: build our own
  seeded noise buffers (LCG is fine; pcg3d precedent exists) shared
  live/offline instead of Tone's random buffers.
- **Free-running oscillator phase** is not reproducible live anyway; offline
  render starts phase at the window origin. Accepted divergence — envelopes
  and note timing (the audible structure) are exact.
- **Polyphony/CPU guard**: PolySynth `maxPolyphony` capped (32); reconciler
  disposes stages that leave the descriptor tree; instruments release voices
  on pause.
- **Autoplay policy**: `Tone.start()` must ride a user gesture — the Play
  button click. First-ever play may need one retry frame (same pattern as
  Audio Source's `el.play().catch`).
- **Bundle**: Tone is ~150KB gz. Lazy-load audio-engine on first audio-node
  eval; export-template carries it only when the project uses audio chains
  (packager already does per-feature gating for fonts/wasm — follow that).

## V1 node batch (22 nodes)

All `category: "audio"`, standard subcategories. Every node = one small
descriptor-emitting file; no Tone imports.

**Generators** (subcategory `generator`):
| Node | Emits | Notes |
|---|---|---|
| Oscillator | audio | sine/square/saw/tri + fat/pwm variants, freq (Hz or note), detune |
| Noise | audio | white/pink/brown, seeded buffer |
| Audio LFO | audio | audio-rate modulator; consumed by mod inputs on effects/instruments (audio-domain, never a scalar) |
| Player | audio | url-backed buffer playback through the chain (rate/pitch, loop); the processable sibling of Audio Source |

**Instruments** (`generator`, consume `notes`):
| Node | Wraps |
|---|---|
| Synth | Tone.PolySynth(Tone.Synth) — osc type + ADSR |
| FM Synth | Tone.PolySynth(Tone.FMSynth) — harmonicity, mod index |
| Sampler | Tone.Sampler — pitched one-shot from an audio file param |

**Effects** (`modifier`, audio in → audio out, all with wet/dry where
sensible):
Filter (LP/HP/BP/notch, cutoff, Q, rolloff) · EQ3 (low/mid/high ± crossovers)
· Delay (time, feedback; ping-pong toggle) · Reverb (decay, pre-delay,
cached IR) · Distortion (drive, oversample) · BitCrusher (bits) · Chorus
(rate, depth, spread) · Phaser (rate, octaves, base freq) · Compressor
(threshold, ratio, attack, release, knee) · Limiter (threshold) · Channel
(gain dB, pan, mute — the utility strip).

**Routing & notes-lite** (`utility` unless noted):
| Node | Role |
|---|---|
| Audio Merge | the mixer (above) |
| Crossfade | equal-power A/B blend, fade scalar-drivable |
| Step Pattern (`generator`, emits `notes`) | deliberately dumb v1 trigger: text pattern (`"x..x..x."`), division (1/4, 1/8, 1/16 vs bpm), pitch + scale/octave params, velocity, swing. Param-panel-only UI. The real sequencer replaces it later; the `notes` type is the contract. |
| Transpose (`modifier`, notes→notes) | ± semitones/octaves; the first pure notes-domain transform, proving that domain composes |

**Deferred, by decision**: Sequencer and piano-roll MIDI Editor — they need
their own UI conversation. The `notes` type + tick timebase + BPM setting
designed here are their landing pad. Also deferred: sends/returns, sidechain
routing, WebMIDI hardware input, audio-rate scalar bridging.

## Milestones

- **M0 — Foundation (sequential, one owner).** `notes` type + AudioValue
  `chain` field (types.ts), `engine/audio-chain.ts` (descriptor types +
  pure diff), `engine/audio-engine.ts` (reconciler, transport slave, taps,
  offline render, element WeakMap), evaluator/Output integration (routing
  detection over chains), project `bpm` (+ctx), Tone.js dep (lazy),
  `scripts/check-audio-chain.mts` covering the pure diff/reconcile-plan
  logic. Exit: Oscillator→Filter→Output audible, param ramp click-free,
  offline render byte-identical across two runs.
- **M1 — Node batch (four parallel tracks, one agent each).**
  A: Generators (4). B: Instruments (3). C: Effects (11). D: Routing +
  notes-lite (4). Each track: node files + registration + docs
  descriptions. C is the biggest — can split C1 (tone-shaping: filter, EQ3,
  distortion, bitcrusher, compressor, limiter, channel) / C2 (time-based:
  delay, reverb, chorus, phaser).
- **M2 — Integration (after M1 lands).** Analysis-node chain taps +
  audio→scalar over chains, export mixdown via renderOffline + offline
  analysis slicing, export-template bundling, LiveViewer transport, devguide
  update.

**Orchestrator checklist for M1 agents** (the "line up to the overall
logic" pass): no Tone/AudioContext imports in node files; descriptor
conforms to audio-chain.ts types; `nodeId` threaded; params are declared
ParamDefs (keyframable scalars, enums for modes, `visibleIf` for dependent
rows); registered in index.ts; `category: "audio"` + correct subcategory;
description present; wet/dry + OPACITY_PARAM conventions checked (opacity
does not apply to audio — do NOT declare it); no `ctx.state` audio objects;
back-compat untouched (Audio Source/Video Source behavior identical when no
chain processes them).

## Decisions (recorded 2026-08-08)

1. **Backend: Tone.js**, reconciled from descriptors. Raw WebAudio rejected
   (3–4× foundation work for a worse-sounding v1).
2. **Playback: timeline-slaved only.** No free-running jam transport in v1;
   it can layer on later without unwinding anything.
3. **Tempo: project-level BPM setting** (default 120). Note data stays in
   ticks; authoring nodes convert beats→ticks at compute time.
4. **V1 triggering: minimal Step Pattern node** (text pattern, no custom
   editor UI). Real sequencer/piano-roll deferred to a dedicated UI
   conversation; `notes` is designed now as their contract.
