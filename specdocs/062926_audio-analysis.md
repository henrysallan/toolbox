# Audio analysis nodes — bands, pitch, spectrum (snapshot 2026-06-29)

Covers devlist **33** (audio decomposition → low/mid/high + pitch
quantization) and **33.1** (spectral converter → scalar field). Read
`061226_devguide.md` first — this assumes the engine mental model.

## Goal

Let audio drive the graph with more than one number. Today the only audio
analysis is the `audio → scalar` coercion in
[coerce.ts](../src/engine/coerce.ts), which returns a single time-domain
RMS (loudness). We want:

1. **Audio Bands** — split a signal into Low / Mid / High energy → **3
   scalar outputs** to drive separate params.
2. **Audio Pitch** — detect fundamental frequency, **quantize to musical
   intervals**, emit a scalar so pitch can step a parameter.
3. **Audio Spectral** — turn the FFT into a **spectrum texture** (a spatial
   scalar field on `image`/`mask`) under several layout algorithms, for
   displacement / Copy-to-Points / gradients / etc.

Resolved design forks (2026-06-29 owner Q&A):
- Bands emit **scalars**, not audible filtered streams. (Audible per-band
  filtering would need to extend `AudioValue` to carry a WebAudio filter
  chain + teach Output/export-audio about it — deferred, see Future work.)
- Spectral emits a **texture field only** (no parallel feature-scalar bank
  this pass; centroid/onset/etc. noted as a follow-up node).
- Audio-reactive params **must render frame-accurately in offline export**
  → build the offline-FFT path (§ The analysis layer).

**No new SocketType.** Every output is `scalar` or `image`/`mask`. This
sidesteps the type-ripple invariant (#7) entirely — the work is one engine
helper plus three thin node defs.

## Current state (what we build on)

- `audio` socket = `AudioValue { element: HTMLMediaElement, source }`
  ([types.ts:186](../src/engine/types.ts#L186)) — a *live media element
  reference*, not sample data.
- Analyzer machinery lives in [coerce.ts:25-132](../src/engine/coerce.ts#L25)
  — one lazy `AudioContext`/tab, one `AnalyserNode`/element (fftSize 2048,
  smoothing 0.3), cached on `ctx.state`. Only `getByteTimeDomainData` (RMS)
  is read; **frequency-domain data is set up but never consumed.**
- **Offline export is a separate world.** [export-audio.ts](../src/lib/export-audio.ts)
  decodes the source URL into an `AudioBuffer` via `OfflineAudioContext`,
  but *only to mux audio into the video*. During a frame-stepped offline
  render the live `AnalyserNode` is not advancing in real time, so audio
  analysis would read silence. **Consequence today: any audio-reactive
  param renders as ~0 in high/max/gif/sequence exports.** Fixing this is a
  first-class goal here, not an afterthought.

## The analysis layer (the foundation)

New engine module **`src/engine/audio-analysis.ts`** — self-contained
(invariant #1: no imports from components/state/lib). It is the single
source of analysis for the coercion *and* all three nodes, so there is one
analyser per element and one decode per file.

```ts
interface AudioFrame {
  timeDomain: Float32Array;   // [-1,1] samples, length = fftSize
  freqDomain: Float32Array;   // magnitude in dB, length = fftSize/2
  sampleRate: number;
  fftSize: number;
  voiced: boolean;            // simple energy gate (for pitch)
}
// One call, two backends behind it:
function getAudioFrame(value: AudioValue, ctx: RenderContext): AudioFrame | null;
```

- **Live backend** (`!ctx.offline`): lift the analyser machinery out of
  coerce.ts into here; expose both `getFloatTimeDomainData` and
  `getFloatFrequencyData`. Coerce.ts's RMS path becomes a thin caller
  (keeps existing behavior, now shares one analyser).
- **Offline backend** (`ctx.offline`): decode the element's source URL once
  into an `AudioBuffer`, cache on `ctx.state` (reuse / mirror
  export-audio's decode). At each `ctx.time`, slice the `fftSize`-sample
  window centered on the current playhead (honoring the source node's
  loop / start_offset, same math as Audio Source) and run a **dependency-
  free radix-2 FFT** (~80 lines; the repo has no FFT yet — add one here,
  with a Hann window) to fill `freqDomain`. This makes export deterministic
  and frame-accurate.
  - Mic mode has no offline representation → offline returns `null` (node
    emits its rest value). Matches export-audio's mic handling.

Shared helpers in the same module (used by Bands + Spectral):
- `bandEnergy(frame, loHz, hiHz)` → integrate magnitude over a freq range.
- `binToHz` / `hzToBin`, `aWeight?`, dB↔linear, Hann window.

## Node 1 — Audio Bands

`src/nodes/audio/bands.ts`. `category: "audio"`, `subcategory: "utility"`,
`stable: false`, `fingerprintExtras` = `ctx.frame` (so independent
subgraphs don't churn; see LFO precedent).

- **Input:** `audio`.
- **Aux outputs (scalar):** `low`, `mid`, `high`.
- **Params:** `crossover_lo` (Hz, default ~250), `crossover_hi` (Hz,
  default ~4000), `gain` per band or one master, `smoothing`
  (attack/release one-pole on each band — persistent state in
  `ctx.state`), `scale` enum (linear / dB), `normalize` (auto-gain to
  ~[0,1]).
- **Compute:** `getAudioFrame` → `bandEnergy` for each of the three ranges
  → smooth → emit three scalars. No GL work.

## Node 2 — Audio Pitch

`src/nodes/audio/pitch.ts`. Same node skeleton as Bands.

- **Why not FFT bins:** at fftSize 2048 / 44.1 kHz ≈ 21.5 Hz/bin — far too
  coarse for low notes. Detect on the **time-domain** buffer with
  **autocorrelation / MPM (McLeod)** — robust, ~100 lines, returns f0 +
  a clarity/confidence value.
- **Input:** `audio`.
- **Aux outputs (scalar):** `pitch` (format per param), `confidence`
  (0..1), optional `gate` (1 when voiced).
- **Quantization params:** `quantize` enum (off / chromatic-12-TET /
  scale / N-EDO), `root` note, `scale` set (major/minor/penta/custom mask),
  `divisions` (for N-EDO). Snap detected Hz → nearest allowed pitch.
- **Output format param:** `as` enum — `midi` (0..127), `normalized`
  (over a `min_note`/`max_note` range — best for driving a [0,1] param),
  or `hz`.
- **Stability params:** `confidence_gate` (hold last pitch when unvoiced
  instead of dropping to 0), `glide` (portamento smoothing toward the
  target note). State (last pitch, glide value) in `ctx.state`.

This is the "pitch drives a parameter changing" feature: `normalized` +
chromatic quantize gives a stepped control signal that snaps between notes.

## Node 3 — Audio Spectral (spectrum field)

`src/nodes/audio/spectral.ts`. `category: "audio"`. Emits a **texture** —
the "various algorithms and compositions → scalar field" of devlist 33.1.

- **Input:** `audio`.
- **Primary output:** `image` (also exposable as `mask`; they coerce).
  Value is canvas-sized so it previews and composites normally.
- **`algorithm` enum** (the "various algorithms"):
  - `linear` — magnitude vs linear frequency along X.
  - `log` / `mel` — perceptual frequency axis (more low-end detail).
  - `waveform` — time-domain signal as a field.
  - `chroma` — 12 pitch-class bins (octave-folded) along X.
  - `spectrogram` — **2D** field: frequency on X, scrolling time history on
    Y (a real spatial field, ideal for displacement). *Phase 2* — needs a
    ring-buffer texture in `ctx.state` and a deterministic offline fill
    (re-analyze the preceding N frame windows); flagged for the offline
    caveat below.
- **Params:** `bins` / resolution, `db_floor` & `db_ceil` (range mapping),
  `smoothing`, `orientation` (X/Y), `mirror`, `gamma`/`curve`.
- **Compute:** `getAudioFrame` → build a CPU `Float32Array` of the chosen
  representation → upload to a small `bins×1` (or `bins×history`) texture
  (the `gl.texImage2D` + per-node cached texture pattern from
  [gradient.ts:179-207](../src/nodes/source/gradient.ts#L179)) → a
  fullscreen shader (`ctx.getShader` + `ctx.drawFullscreen`) maps `v_uv`
  → bin and writes the magnitude into a canvas-sized `ctx.allocImage`.
- Gate the (cheap) build on `consumedOutputs` per the evaluator convention;
  release the intermediate lookup texture appropriately (texture
  discipline, invariant #3).

Downstream this is immediately useful: spectrum → Displace, → Copy-to-
Points heights, → gradient stops, → SDF field, etc.

## Offline-export determinism (the load-bearing part)

The live `AnalyserNode` is meaningless during frame-stepped export.
`getAudioFrame`'s **offline backend** is what makes Bands/Pitch/Spectral
correct in high/max/gif/sequence renders:

1. On first offline call for an element, decode its URL → `AudioBuffer`
   (cache on `ctx.state`; reuse export-audio's decode where possible).
2. Each frame, compute the sample window for `ctx.time` using the *source
   node's* loop/start_offset/sync (same arithmetic as Audio Source) so the
   analyzed window matches what the muxed audio actually plays.
3. Windowed radix-2 FFT in JS → `freqDomain`. Pure, deterministic, no real-
   time dependency.

Caveats: mic input has no offline form (returns rest value, like
export-audio skips it). The `spectrogram` algorithm's time history must be
reconstructed from the preceding windows offline rather than a live ring
buffer — handle in its phase-2 work.

## Milestones

1. **[DONE]** **Analysis layer** — `audio-analysis.ts`: live backend
   (analyser lifted out of coerce, exposes time+freq) + `getAudioFrame`
   API + band/FFT helpers + radix-2 FFT. Coerce RMS repointed through it
   (numerically identical — byte→float time-domain).
2. **[DONE]** **Audio Bands** node — `level` primary + Low/Mid/High scalar
   aux, crossovers, smoothing, linear/dB. Registered in index.ts.
3. **[DONE]** **Audio Pitch** node — McLeod NSDF `detectPitch` +
   quantization (chromatic/scale/EDO) + output formats (midi/normalized/hz)
   + confidence gate + hold + glide.
4. **[DONE]** **Audio Spectral** node — linear/log/mel/waveform/chroma →
   spectrum image (8-bit lookup row sampled LINEAR into the 16F output).
5. **[DONE]** **Offline backend** — decode source URL → AudioBuffer once
   (offline-settle coordinated), slice fftSize window at
   `element.currentTime` each frame. All four consumers (RMS coercion +
   3 nodes) go frame-accurate in export via the one shared path.
6. **[DONE]** **Spectral `spectrogram`** (2D) — log-frequency × scrolling
   time history. Live: accumulate one column per scene frame in
   `state.rows` (advances on `ctx.frame` change, not param-edit re-evals).
   Offline: reconstruct the history deterministically via `offlineFrameAt`
   — one FFT per row at the preceding frame times (`now − age/fps`), so
   export matches preview. Cost scales with `history` rows/frame; export-
   only, acceptable. Uploaded as a bins×history texture, sampled by
   `FS_SPECTROGRAM` (orientation swaps freq/time axes; mirror on freq).
7. **[DONE]** devguide audio section + devlist 33/33.1 updated. (In-app
   docs render from node descriptions automatically.)

## Future work (out of scope this pass)

- **Audible band-split / audio filters** — extend `AudioValue` to carry an
  optional WebAudio node/filter description so Output + export-audio can
  play filtered streams (the "3 audio outputs, hearable" reading).
- **Feature-scalar bank** — centroid, flux/**onset & beat detection**,
  rolloff, flatness as a separate "Audio Features" node (great for
  triggering, but the owner chose texture-only for 33.1 this pass).
- Ties into devlist **92** (DAW-style / instrument node toolkit).

## Invariants touched

- #1 engine self-containment: `audio-analysis.ts` lives under `src/engine`,
  no app imports.
- #3 texture discipline: Spectral allocs a lookup tex + output image;
  release the intermediate, never the input.
- #7 *not* triggered — no new SocketType.
- Caching: all three nodes `stable:false` + `fingerprintExtras` (LFO/Audio
  Source precedent). Persistent smoothing/glide state in `ctx.state`,
  cleaned in `dispose`.
