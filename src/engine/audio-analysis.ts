import { pushMediaSettle } from "./offline-settle";
import type { AudioChainNode, AudioValue, RenderContext } from "./types";

// =====================================================================
// Shared audio-analysis layer
// =====================================================================
//
// One place that turns an `AudioValue` (a live HTMLMediaElement) into an
// analysis frame — time-domain samples plus a lazily-computed magnitude
// spectrum. This is the single source of analysis for BOTH the
// `audio → scalar` coercion (RMS loudness) and the audio analysis nodes
// (Bands / Pitch / Spectral), so there is exactly one AnalyserNode per
// element and the spectrum is computed at most once per frame no matter
// how many consumers read it.
//
// Two backends sit behind `getAudioFrame`:
//
//   live    — taps the element through a WebAudio AnalyserNode and reads
//             its float time-domain buffer. (This pass.)
//   offline — decodes the source file into an AudioBuffer and slices the
//             sample window for ctx.time, so audio-reactive params render
//             deterministically during frame-stepped export. (Milestone 5
//             — see TODO in getAudioFrame.)
//
// IMPORTANT: the magnitude spectrum is ALWAYS computed by our own JS FFT
// over the time-domain buffer (not the AnalyserNode's getFloatFrequencyData).
// That keeps live preview and offline export bit-for-bit consistent once
// the offline backend lands — both run the identical FFT, differing only
// in where the time-domain samples come from.

// ---------------------------------------------------------------------
// AudioContext / AnalyserNode machinery (lifted from coerce.ts)
// ---------------------------------------------------------------------
//
//   file source → MediaElementSource → Analyser → Destination
//   mic source  → MediaStreamSource  → Analyser  (no destination — the
//                                                 element already plays
//                                                 live via srcObject and
//                                                 routing the mic to the
//                                                 speakers would feed back)

const AUDIO_CTX_KEY = "__audio_ctx__";
const ANALYSER_MAP_KEY = "__audio_analysers__";
const ELEMENT_SOURCE_KEY = "__audio_element_sources__";
const FRAME_CACHE_KEY = "__audio_frame_cache__";
const CHAIN_FRAME_CACHE_KEY = "__audio_chain_frame_cache__";
const DECODE_MAP_KEY = "__audio_decoded__";

// ---------------------------------------------------------------------
// Chain taps (080926_audio-v2-integration.md M-A)
// ---------------------------------------------------------------------
//
// Synth-chain AudioValues carry no media element — their analysis source
// is the live Tone graph (an analyser on the stage's output) or, offline,
// a deterministic render of the chain sliced per frame. Both live in
// audio-engine.ts, which this module cannot import (it imports US for the
// shared context / element sources) — so the engine INJECTS itself here
// at module load. Provider absent (engine chunk not loaded yet, stage not
// built yet) → callers fall back to the element passthrough or emit rest
// values; the engine's pipeline-bump re-evals once it comes up.

export interface ChainTapProvider {
  // Latest time-domain window from the live stage's analyser tap, or null
  // while the stage isn't built.
  readLiveTap(
    chainNodeId: string
  ): { timeDomain: Float32Array; sampleRate: number } | null;
  // Deterministic offline buffer for the chain covering at least
  // [0, minEndSec). Null while rendering (a settle promise is registered
  // on ctx so the export driver waits) or when rendering is impossible.
  getOfflineChainBuffer(
    chain: AudioChainNode,
    ctx: RenderContext,
    minEndSec: number
  ): AudioBuffer | null;
}

let chainTapProvider: ChainTapProvider | null = null;
export function setChainTapProvider(p: ChainTapProvider): void {
  chainTapProvider = p;
}

// FFT window size for the analyser and the JS spectrum. 2048 samples ≈
// 46 ms at 44.1 kHz — a reasonable time/frequency tradeoff for control
// signals. Bin resolution is sampleRate / fftSize ≈ 21.5 Hz.
export const ANALYSIS_FFT_SIZE = 2048;

// The ONE AudioContext for the whole app. Shared by the analysis taps here,
// the audio→scalar coercion, AND the audio-chain engine (audio-engine.ts
// mounts Tone.js on this same raw context) — a MediaElementSource is bound
// to its context forever, so everything that touches elements must agree on
// one. Exported for audio-engine.ts only; everyone else goes through
// getAudioFrame.
export function getSharedAudioContext(ctx: RenderContext): AudioContext | null {
  const existing = ctx.state[AUDIO_CTX_KEY] as AudioContext | undefined;
  if (existing) {
    if (existing.state === "suspended") existing.resume().catch(() => {});
    return existing;
  }
  try {
    const audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    ctx.state[AUDIO_CTX_KEY] = audioCtx;
    return audioCtx;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Shared per-element source registry
// ---------------------------------------------------------------------
//
// createMediaElementSource is ONE-SHOT per element (a second call throws)
// and permanently diverts the element's direct audio output through the
// context. So the element's WebAudio wrap is a shared resource: analysis
// taps read from it, and an audio chain (Filter etc. downstream of an
// Audio/Video Source) claims it as a chain leaf. The `direct` gain is the
// element's default path to the speakers (source → direct → destination);
// audio-engine.ts zeroes it while a chain is processing the element so the
// dry signal doesn't leak alongside the processed one, and restores it when
// the chain goes away. Mic elements tap their MediaStream instead (no
// direct gain — the mic never had a default speaker path here; routing it
// to the destination would feed back).

export interface ElementSourceEntry {
  source: AudioNode;
  direct: GainNode | null;
}

export function getOrCreateElementSource(
  ctx: RenderContext,
  element: HTMLMediaElement,
  sourceKind: "file" | "mic" | "video"
): ElementSourceEntry | null {
  const map = (ctx.state[ELEMENT_SOURCE_KEY] ??= new Map()) as Map<
    HTMLMediaElement,
    ElementSourceEntry
  >;
  const cached = map.get(element);
  if (cached) return cached;

  const audioCtx = getSharedAudioContext(ctx);
  if (!audioCtx) return null;

  try {
    let entry: ElementSourceEntry;
    if (sourceKind === "mic") {
      const stream = (element as HTMLMediaElement & {
        srcObject: MediaStream | null;
      }).srcObject;
      if (!stream) return null;
      entry = { source: audioCtx.createMediaStreamSource(stream), direct: null };
    } else {
      const source = audioCtx.createMediaElementSource(element);
      const direct = audioCtx.createGain();
      direct.gain.value = 1;
      source.connect(direct);
      direct.connect(audioCtx.destination);
      entry = { source, direct };
    }
    map.set(element, entry);
    return entry;
  } catch {
    return null;
  }
}

interface AnalyserEntry {
  analyser: AnalyserNode;
}

function getOrCreateAnalyser(
  ctx: RenderContext,
  value: AudioValue
): AnalyserEntry | null {
  const element = value.element;
  if (!element) return null;
  const map = (ctx.state[ANALYSER_MAP_KEY] ??= new Map()) as Map<
    HTMLMediaElement,
    AnalyserEntry
  >;
  const cached = map.get(element);
  if (cached) return cached;

  const audioCtx = getSharedAudioContext(ctx);
  if (!audioCtx) return null;

  try {
    const src = getOrCreateElementSource(ctx, element, value.source ?? "file");
    if (!src) return null;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = ANALYSIS_FFT_SIZE;
    analyser.smoothingTimeConstant = 0.3;
    src.source.connect(analyser);
    const entry: AnalyserEntry = { analyser };
    map.set(element, entry);
    return entry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Analysis frame
// ---------------------------------------------------------------------

export interface AudioFrame {
  // Time-domain samples in [-1, 1], length === fftSize.
  timeDomain: Float32Array;
  sampleRate: number;
  fftSize: number;
  // Linear magnitude spectrum (length fftSize/2), Hann-windowed, computed
  // on first access and memoized for the rest of this frame. Pitch
  // detection works on the time domain and never triggers this, so the
  // FFT is paid for only when a consumer (Bands / Spectral) needs it.
  freq(): Float32Array;
}

type FrameCacheEntry = { frame: number; value: AudioFrame };

function frameCache(ctx: RenderContext): Map<HTMLMediaElement, FrameCacheEntry> {
  return (ctx.state[FRAME_CACHE_KEY] ??= new Map()) as Map<
    HTMLMediaElement,
    FrameCacheEntry
  >;
}

function makeFrame(timeDomain: Float32Array, sampleRate: number): AudioFrame {
  let memoMag: Float32Array | null = null;
  return {
    timeDomain,
    sampleRate,
    fftSize: timeDomain.length,
    freq() {
      return (memoMag ??= magnitudeSpectrum(timeDomain));
    },
  };
}

// Resolve the analysis frame for an audio value at the current ctx.frame.
// Returns null when no data is available (mic stream not yet granted, or
// the offline buffer still decoding) — callers emit their rest value.
// Cached per element per frame so Bands + Pitch + Spectral on the same
// source share one read/FFT.
export function getAudioFrame(
  value: AudioValue,
  ctx: RenderContext
): AudioFrame | null {
  // Chain tap WINS over the element passthrough (080926 M-A): an effect's
  // AudioValue carries both, and the tap reads the POST-effect signal —
  // the one a reactive visual should follow — where the element is the
  // raw source. Falls through to the element when the tap isn't up yet
  // (engine loading, stage not built) so chainless/legacy values behave
  // exactly as before.
  if (value.chain) {
    const frame = chainFrame(value.chain, ctx);
    if (frame) return frame;
  }
  if (!value.element) return null;
  const cache = frameCache(ctx);
  const cached = cache.get(value.element);
  if (cached && cached.frame === ctx.frame) return cached.value;

  const frame = ctx.offline ? offlineFrame(value, ctx) : liveFrame(value, ctx);
  if (!frame) return null;
  cache.set(value.element, { frame: ctx.frame, value: frame });
  return frame;
}

function chainFrameCache(
  ctx: RenderContext
): Map<string, FrameCacheEntry> {
  return (ctx.state[CHAIN_FRAME_CACHE_KEY] ??= new Map()) as Map<
    string,
    FrameCacheEntry
  >;
}

// Analysis frame for a chain value at the current ctx.frame — live via the
// engine's stage analyser, offline by slicing the chain's deterministic
// render at the scene time. Cached per chain root per frame (Bands + Pitch
// + Spectral on one chain share a read, same as elements).
function chainFrame(chain: AudioChainNode, ctx: RenderContext): AudioFrame | null {
  if (!chainTapProvider) return null;
  const cache = chainFrameCache(ctx);
  const cached = cache.get(chain.nodeId);
  if (cached && cached.frame === ctx.frame) return cached.value;

  let frame: AudioFrame | null = null;
  if (ctx.offline) {
    const buf = chainTapProvider.getOfflineChainBuffer(chain, ctx, ctx.time + 1);
    if (buf) frame = sliceBufferAt(buf, ctx.time);
  } else {
    const tap = chainTapProvider.readLiveTap(chain.nodeId);
    if (tap) frame = makeFrame(tap.timeDomain, tap.sampleRate);
  }
  if (!frame) return null;
  cache.set(chain.nodeId, { frame: ctx.frame, value: frame });
  return frame;
}

// Offline-only: chain-analysis frame at an arbitrary time (Spectral's
// deterministic spectrogram history — the chain sibling of offlineFrameAt).
export function offlineChainFrameAt(
  chain: AudioChainNode,
  ctx: RenderContext,
  timeSec: number
): AudioFrame | null {
  if (!chainTapProvider) return null;
  const buf = chainTapProvider.getOfflineChainBuffer(chain, ctx, ctx.time + 1);
  return buf ? sliceBufferAt(buf, Math.max(0, timeSec)) : null;
}

// Live backend: read the most recent samples from the per-element analyser.
function liveFrame(value: AudioValue, ctx: RenderContext): AudioFrame | null {
  const entry = getOrCreateAnalyser(ctx, value);
  if (!entry) return null;
  const fftSize = entry.analyser.fftSize;
  const timeDomain = new Float32Array(fftSize);
  entry.analyser.getFloatTimeDomainData(timeDomain);
  return makeFrame(timeDomain, entry.analyser.context.sampleRate);
}

// ---------------------------------------------------------------------
// Offline backend (deterministic export)
// ---------------------------------------------------------------------
//
// The live AnalyserNode is meaningless during frame-stepped export (the
// element isn't playing in realtime). Instead we decode the source file
// into an AudioBuffer ONCE and, each frame, slice the fftSize-sample
// window centered on the element's playhead. The Audio/Video Source node
// runs in compute() before its consumers and seeks `element.currentTime`
// to the (looped) scene time, so currentTime is the authoritative
// playhead here — no need to re-derive loop/offset.
//
// Decode is async; getAudioFrame is sync. So the first offline call kicks
// off the decode, registers an offline-settle promise (the export driver
// renders once to issue it, awaits, then re-renders), and returns null.
// Subsequent frames find the cached buffer synchronously. Mic input has
// no offline representation and returns null (node emits its rest value).

interface DecodeEntry {
  buffer: AudioBuffer | null;
  status: "pending" | "ready" | "failed";
}

function getDecodedBuffer(value: AudioValue, ctx: RenderContext): AudioBuffer | null {
  if (value.source === "mic" || !value.element) return null;
  const element = value.element;
  const map = (ctx.state[DECODE_MAP_KEY] ??= new Map()) as Map<
    HTMLMediaElement,
    DecodeEntry
  >;
  const existing = map.get(element);
  if (existing) return existing.status === "ready" ? existing.buffer : null;

  const url = element.currentSrc || element.src;
  if (!url) {
    map.set(element, { buffer: null, status: "failed" });
    return null;
  }
  const entry: DecodeEntry = { buffer: null, status: "pending" };
  map.set(element, entry);

  const audioCtx = getSharedAudioContext(ctx);
  const job: Promise<void> = audioCtx
    ? fetch(url)
        .then((r) => r.arrayBuffer())
        .then((bytes) => audioCtx.decodeAudioData(bytes))
        .then((buf) => {
          entry.buffer = buf;
          entry.status = "ready";
        })
        .catch(() => {
          entry.status = "failed";
        })
    : Promise.resolve().then(() => {
        entry.status = "failed";
      });

  // Register a settle promise so the export driver waits for the decode,
  // with a safety timeout so a wedged fetch can't hang the whole export.
  pushMediaSettle(
    ctx,
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      job.then(finish, finish);
      setTimeout(finish, 10000);
    })
  );
  return null;
}

// Slice an fftSize window centered on `timeSec` (clamped to ≥0) and mix up
// to two channels to mono.
function sliceBufferAt(buf: AudioBuffer, timeSec: number): AudioFrame {
  const sampleRate = buf.sampleRate;
  const fftSize = ANALYSIS_FFT_SIZE;
  const timeDomain = new Float32Array(fftSize);
  const center = Math.floor(Math.max(0, timeSec) * sampleRate);
  const start = center - (fftSize >> 1);
  const chCount = Math.min(2, buf.numberOfChannels);
  for (let c = 0; c < chCount; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      if (s >= 0 && s < ch.length) timeDomain[i] += ch[s];
    }
  }
  if (chCount > 1) {
    for (let i = 0; i < fftSize; i++) timeDomain[i] /= chCount;
  }
  return makeFrame(timeDomain, sampleRate);
}

function offlineFrame(value: AudioValue, ctx: RenderContext): AudioFrame | null {
  const buf = getDecodedBuffer(value, ctx);
  if (!buf || !value.element) return null;
  // The source node seeks element.currentTime to the deterministic playhead.
  return sliceBufferAt(buf, value.element.currentTime || 0);
}

// Offline-only: analysis frame at an arbitrary time, for reconstructing a
// history window deterministically (Spectral's spectrogram). Returns null
// until the buffer is decoded — the same one-time settle handshake as
// offlineFrame (the first getDecodedBuffer call registers it). Mic input
// has no decoded buffer, so this is always null there.
export function offlineFrameAt(
  value: AudioValue,
  ctx: RenderContext,
  timeSec: number
): AudioFrame | null {
  const buf = getDecodedBuffer(value, ctx);
  if (!buf) return null;
  return sliceBufferAt(buf, timeSec);
}

// ---------------------------------------------------------------------
// FFT (dependency-free, iterative radix-2 Cooley–Tukey)
// ---------------------------------------------------------------------

// In-place complex FFT. re/im must be the same power-of-two length.
function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Hann-windowed linear magnitude spectrum of a real signal. Output length
// is timeDomain.length / 2 (the non-redundant half). Scaled by 2/N so a
// full-scale sinusoid reads ≈ its amplitude at its bin.
export function magnitudeSpectrum(timeDomain: Float32Array): Float32Array {
  const n = timeDomain.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
    re[i] = timeDomain[i] * w;
  }
  fftInPlace(re, im);
  const half = n >> 1;
  const mag = new Float32Array(half);
  const norm = 2 / n;
  for (let i = 0; i < half; i++) {
    mag[i] = Math.hypot(re[i], im[i]) * norm;
  }
  return mag;
}

// ---------------------------------------------------------------------
// Feature helpers (shared by the nodes)
// ---------------------------------------------------------------------

// Root-mean-square level of a time-domain buffer: 0 silent, ~1 saturated.
export function rms(timeDomain: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < timeDomain.length; i++) {
    const v = timeDomain[i];
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, timeDomain.length));
}

// Frequency (Hz) → spectrum bin index, clamped to [0, half-1].
export function hzToBin(hz: number, sampleRate: number, fftSize: number): number {
  const half = fftSize >> 1;
  const bin = Math.round((hz * fftSize) / sampleRate);
  return Math.max(0, Math.min(half - 1, bin));
}

// Spectrum bin index → center frequency (Hz).
export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

// Mean magnitude across the [loHz, hiHz] band of a magnitude spectrum.
export function bandEnergy(frame: AudioFrame, loHz: number, hiHz: number): number {
  const mag = frame.freq();
  const lo = hzToBin(Math.min(loHz, hiHz), frame.sampleRate, frame.fftSize);
  const hi = hzToBin(Math.max(loHz, hiHz), frame.sampleRate, frame.fftSize);
  let sum = 0;
  let count = 0;
  for (let i = lo; i <= hi; i++) {
    sum += mag[i];
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// ---------------------------------------------------------------------
// Pitch detection (McLeod Pitch Method / NSDF)
// ---------------------------------------------------------------------

export interface PitchResult {
  // Fundamental frequency in Hz, or 0 when no pitch is found in range.
  hz: number;
  // Clarity / periodicity confidence in [0,1] — use as a voiced gate.
  clarity: number;
}

// Estimate the fundamental frequency of a time-domain buffer using the
// McLeod Pitch Method: the normalized square-difference function (NSDF),
// key-maxima peak picking with a relative threshold (octave-safe), and
// parabolic interpolation for sub-sample accuracy. Works on the time
// domain — FFT bin resolution is far too coarse for low notes. `minHz`/
// `maxHz` bound the lag search (cheaper + fewer octave errors).
export function detectPitch(
  timeDomain: Float32Array,
  sampleRate: number,
  minHz = 50,
  maxHz = 2000
): PitchResult {
  const n = timeDomain.length;
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / Math.max(1, minHz)));
  const minLag = Math.max(1, Math.floor(sampleRate / Math.max(1, maxHz)));
  if (maxLag <= minLag) return { hz: 0, clarity: 0 };

  // NSDF over [0, maxLag]: nsdf[τ] = 2·Σ x[i]·x[i+τ] / Σ (x[i]² + x[i+τ]²).
  const nsdf = new Float32Array(maxLag + 1);
  for (let tau = 0; tau <= maxLag; tau++) {
    let acf = 0;
    let div = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = timeDomain[i];
      const b = timeDomain[i + tau];
      acf += a * b;
      div += a * a + b * b;
    }
    nsdf[tau] = div > 0 ? (2 * acf) / div : 0;
  }

  // Key maxima: the peak within each positive hump. Skip the initial hump
  // at τ≈0 (the autocorrelation self-peak), then accept only peaks whose
  // lag falls in [minLag, maxLag].
  const peaks: number[] = [];
  let tau = 0;
  while (tau <= maxLag && nsdf[tau] > 0) tau++; // skip the τ=0 hump
  while (tau <= maxLag) {
    while (tau <= maxLag && nsdf[tau] <= 0) tau++; // skip negative span
    let peakLag = -1;
    let peakVal = 0;
    while (tau <= maxLag && nsdf[tau] > 0) {
      if (nsdf[tau] > peakVal) {
        peakVal = nsdf[tau];
        peakLag = tau;
      }
      tau++;
    }
    if (peakLag >= minLag) peaks.push(peakLag);
  }
  if (peaks.length === 0) return { hz: 0, clarity: 0 };

  // Pick the FIRST key maximum above 0.9× the strongest one — biases
  // toward the true fundamental rather than a stronger octave-up partial.
  let maxVal = 0;
  for (const p of peaks) if (nsdf[p] > maxVal) maxVal = nsdf[p];
  const threshold = 0.9 * maxVal;
  let chosen = peaks[0];
  for (const p of peaks) {
    if (nsdf[p] >= threshold) {
      chosen = p;
      break;
    }
  }

  // Parabolic interpolation around the chosen lag for sub-sample accuracy.
  const x0 = chosen > 0 ? nsdf[chosen - 1] : nsdf[chosen];
  const x1 = nsdf[chosen];
  const x2 = chosen < maxLag ? nsdf[chosen + 1] : nsdf[chosen];
  const denom = x0 + x2 - 2 * x1;
  const shift = denom !== 0 ? (0.5 * (x0 - x2)) / denom : 0;
  const refinedLag = chosen + shift;

  return {
    hz: refinedLag > 0 ? sampleRate / refinedLag : 0,
    clarity: Math.max(0, Math.min(1, x1)),
  };
}

// Hz ↔ MIDI note number (A4 = 440 Hz = MIDI 69). Fractional MIDI allowed.
export function hzToMidi(hz: number): number {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : 0;
}
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
