// Live audio-path harness (specdocs/080826_audio-nodes.md M0 exit check).
// Runs inside a hidden Electron renderer with a REAL AudioContext:
//
//   1. reconcile() a routed Oscillator → Filter chain exactly the way the
//      evaluator does (lazy Tone load included) and wait for stages,
//   2. read real time-domain samples from the filter stage's analyser tap
//      → proves osc generates, the connection graph carries signal, and
//      the master gate opened (report.masterGain),
//   3. renderOffline() the same descriptors twice → proves the offline
//      path produces signal and is sample-exact deterministic.
//
// This can't prove SPEAKERS work (no audio output device in CI), but it
// proves everything up to the destination node.

import { audioEngine } from "@/engine/audio-engine";
import { getAudioFrame } from "@/engine/audio-analysis";
import { audioBufferToWav } from "@/lib/export-audio";
import type { AudioChainRoot } from "@/engine/audio-chain";
import type {
  AudioChainEffect,
  AudioChainElementLeaf,
  AudioChainGenerator,
  AudioChainInstrument,
  AudioValue,
  NoteEvent,
  RenderContext,
} from "@/engine/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rmsOf(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export async function run(): Promise<Record<string, unknown>> {
  // Minimal ctx: the engine only touches ctx.state (shared AudioContext
  // registry). Everything else on RenderContext is GL-side and unused here.
  const ctx = { state: {} } as unknown as RenderContext;

  const osc: AudioChainGenerator = {
    kind: "generator",
    nodeId: "o1",
    gen: "osc",
    params: { wave: "sine", freq: 220, detune: 0, level: 0.5 },
  };
  const filter: AudioChainEffect = {
    kind: "effect",
    nodeId: "f1",
    fx: "filter",
    params: { type: "lowpass", cutoff: 2000, q: 1, rolloff: -12 },
    input: osc,
  };
  const roots: AudioChainRoot[] = [{ chain: filter, routed: true }];
  const transport = {
    playing: true,
    timeSec: 0,
    bpm: 120,
    fps: 60,
    ticksPerFrame: 1000,
  };
  const timebase = { bpm: 120, fps: 60, ticksPerFrame: 1000 };

  // Reconcile until the stages come up (first call kicks the lazy Tone
  // import; subsequent calls apply the plan).
  const deadline = Date.now() + 10000;
  let tap: AnalyserNode | null = null;
  while (Date.now() < deadline) {
    audioEngine.reconcile(roots, transport, ctx);
    tap = audioEngine.getTapAnalyser("f1");
    if (tap) break;
    await sleep(100);
  }
  if (!tap) {
    return {
      ok: false,
      error: "stages never came up (Tone load or applyDiff failed)",
      report: audioEngine.report(),
    };
  }

  // Let the graph run, then sample the filter output several times and
  // keep the max RMS (the first reads can race the ramp-in).
  await sleep(400);
  let liveRms = 0;
  const td = new Float32Array(tap.fftSize);
  for (let i = 0; i < 6; i++) {
    tap.getFloatTimeDomainData(td);
    liveRms = Math.max(liveRms, rmsOf(td));
    await sleep(60);
  }

  // Offline path: same descriptors, rendered twice — must be non-silent
  // and sample-exact across runs.
  const a = await audioEngine.renderOffline(roots, 0.5, 0, timebase);
  const b = await audioEngine.renderOffline(roots, 0.5, 0, timebase);
  let offlineRms = 0;
  let deterministic = false;
  if (a && b) {
    offlineRms = rmsOf(a.getChannelData(0) as unknown as Float32Array);
    const ca = a.getChannelData(0);
    const cb = b.getChannelData(0);
    deterministic = ca.length === cb.length;
    if (deterministic) {
      for (let i = 0; i < ca.length; i++) {
        if (ca[i] !== cb[i]) {
          deterministic = false;
          break;
        }
      }
    }
  }

  // ---- Scenario 7 (M-B): keyframed-param automation in offline renders ---
  // A cutoff sweep 150→4000 Hz over 1s, replayed as scheduled ramps. A
  // working replay renders a buffer whose LAST quarter is much louder than
  // its first (the lowpass opens over the saw); a broken one renders the
  // start-of-window snapshot — flat, quiet, ratio ~1.
  const autoOsc: AudioChainGenerator = {
    kind: "generator",
    nodeId: "ao1",
    gen: "osc",
    params: { wave: "sawtooth", freq: 440, detune: 0, level: 0.5 },
  };
  const autoFilter: AudioChainEffect = {
    kind: "effect",
    nodeId: "af1",
    fx: "filter",
    params: { type: "lowpass", cutoff: 80, q: 1, rolloff: -24 },
    input: autoOsc,
  };
  const autoFrames: { timeSec: number; params: Record<string, number> }[] = [];
  for (let f = 0; f <= 60; f++) {
    autoFrames.push({
      timeSec: f / 60,
      params: { cutoff: 80 + (4000 - 80) * (f / 60) },
    });
  }
  const autoBuf = await audioEngine.renderOffline(
    [{ chain: autoFilter, routed: true }],
    1.0,
    0,
    timebase,
    new Map([["af1", autoFrames]])
  );
  let autoFirstQ = 0;
  let autoLastQ = 0;
  if (autoBuf) {
    const ch = autoBuf.getChannelData(0);
    const rmsRange = (a: number, b: number): number => {
      let s = 0;
      for (let i = a; i < b; i++) s += ch[i] * ch[i];
      return Math.sqrt(s / Math.max(1, b - a));
    };
    // The sweep crosses the 440Hz fundamental within ~100ms, so quarters
    // average mostly-open — compare the first 5% (cutoff ≤ ~275Hz, still
    // choked) against the last quarter (wide open).
    autoFirstQ = rmsRange(0, Math.floor(ch.length * 0.05));
    autoLastQ = rmsRange(ch.length - Math.floor(ch.length / 4), ch.length);
  }

  // ---- Scenario 6 (M-B): element leaf rendered OFFLINE from its url ------
  // Synthesizes a 1s 440Hz WAV, wraps it in a blob URL, and renders an
  // element-leaf chain offline — the export path for Audio/Video Source
  // audio flowing through processing chains. startOffset skips 0.25s in.
  const wavBuf = new AudioBuffer({ length: 44100, sampleRate: 44100 });
  {
    const ch = wavBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      ch[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100);
    }
  }
  const wavUrl = URL.createObjectURL(
    new Blob([audioBufferToWav(wavBuf) as unknown as BlobPart], { type: "audio/wav" })
  );
  const leaf: AudioChainElementLeaf = {
    kind: "element",
    nodeId: "el1",
    element: document.createElement("audio"),
    source: "file",
    url: wavUrl,
    sync: true,
    loop: false,
    startOffset: 0.25,
    volume: 1,
  };
  const leafChain: AudioChainEffect = {
    kind: "effect",
    nodeId: "lf1",
    fx: "filter",
    params: { type: "lowpass", cutoff: 4000, q: 1, rolloff: -12 },
    input: leaf,
  };
  const leafRender = await audioEngine.renderOffline(
    [{ chain: leafChain, routed: true }],
    0.5,
    0,
    timebase
  );
  const leafOfflineRms = leafRender
    ? rmsOf(leafRender.getChannelData(0) as unknown as Float32Array)
    : 0;
  URL.revokeObjectURL(wavUrl);

  const report = audioEngine.report();
  const masterGain = (report.masterGain as number | null) ?? 0;

  // ---- Scenario 2 (M1): notes → Synth → Delay → Reverb, LIVE -------------
  // Covers the instrument Part scheduling path (play transition schedules,
  // notes fire at absolute transport seconds) and two M1 effect adapters.
  const notes: NoteEvent[] = [
    { pitch: 60, velocity: 0.9, startTick: 0, durationTicks: 12000 },
    { pitch: 64, velocity: 0.9, startTick: 15000, durationTicks: 12000 },
    { pitch: 67, velocity: 0.9, startTick: 30000, durationTicks: 12000 },
    { pitch: 72, velocity: 0.9, startTick: 45000, durationTicks: 12000 },
  ];
  const synth: AudioChainInstrument = {
    kind: "instrument",
    nodeId: "s1",
    inst: "synth",
    params: { wave: "sawtooth", attack: 0.01, decay: 0.15, sustain: 0.5, release: 0.3, level: 0.7 },
    notes,
  };
  const delay: AudioChainEffect = {
    kind: "effect",
    nodeId: "d1",
    fx: "delay",
    params: { time: 0.2, feedback: 0.3, wet: 0.4 },
    input: synth,
  };
  const reverb: AudioChainEffect = {
    kind: "effect",
    nodeId: "r1",
    fx: "reverb",
    params: { decay: 1.5, pre_delay: 0.01, wet: 0.35 },
    input: delay,
  };
  const synthRoots: AudioChainRoot[] = [{ chain: reverb, routed: true }];

  // Pause (releases scenario 1's graph implicitly via the new plan), then a
  // clean play TRANSITION at t=0 so the notes get scheduled from the top.
  audioEngine.reconcile(synthRoots, { ...transport, playing: false }, ctx);
  audioEngine.reconcile(synthRoots, { ...transport, playing: true, timeSec: 0 }, ctx);
  const synthTap = audioEngine.getTapAnalyser("r1");
  let synthRms = 0;
  if (synthTap) {
    // Sample across ~1.3s so at least two notes (0s, 0.25s, …) land.
    const buf = new Float32Array(synthTap.fftSize);
    for (let i = 0; i < 12; i++) {
      await sleep(110);
      synthTap.getFloatTimeDomainData(buf);
      synthRms = Math.max(synthRms, rmsOf(buf));
    }
  }

  // ---- Scenario 4 (M-A): getAudioFrame chain taps ------------------------
  // The analysis path Bands/Pitch/Spectral ride: a chain-bearing AudioValue
  // (no element) must produce real frames — live via the stage tap while
  // scenario 2's graph still plays, offline by slicing the chain's
  // deterministic render (first call kicks it; poll until it lands).
  const chainValue: AudioValue = { kind: "audio", chain: reverb };
  const ctxAt = (frame: number, offline: boolean, time: number): RenderContext =>
    ({
      ...(ctx as unknown as Record<string, unknown>),
      frame,
      offline,
      time,
      fps: 60,
      ticksPerFrame: 1000,
      bpm: 120,
    }) as unknown as RenderContext;
  let tapLiveRms = 0;
  for (let i = 0; i < 8; i++) {
    const f = getAudioFrame(chainValue, ctxAt(1000 + i, false, 0));
    if (f) tapLiveRms = Math.max(tapLiveRms, rmsOf(f.timeDomain));
    await sleep(80);
  }
  let tapOfflineRms = -1;
  for (let waited = 0; waited < 20000; waited += 250) {
    const f = getAudioFrame(chainValue, ctxAt(5000 + waited, true, 0.3));
    if (f) {
      tapOfflineRms = rmsOf(f.timeDomain);
      break;
    }
    await sleep(250);
  }

  // ---- Scenario 5 (M-C): audio-rate modulation — LFO wobbles a cutoff ----
  // A working mod shows as RMS that OSCILLATES across reads (the sweep
  // dips the lowpass under the tone); a dead mod connection reads as a
  // near-constant level. The reconcile may be deferred behind scenario
  // 4's offline tap render (ambient-context guard) — retry the tap until
  // the plan lands.
  const lfoStage: AudioChainGenerator = {
    kind: "generator",
    nodeId: "lfo1",
    gen: "lfo",
    params: { shape: "sine", rate: 4, min: -700, max: 700, phase: 0 },
  };
  const wobOsc: AudioChainGenerator = {
    kind: "generator",
    nodeId: "wo1",
    gen: "osc",
    params: { wave: "sawtooth", freq: 440, detune: 0, level: 0.5 },
  };
  const wobble: AudioChainEffect = {
    kind: "effect",
    nodeId: "wf1",
    fx: "filter",
    params: { type: "lowpass", cutoff: 800, q: 2, rolloff: -24 },
    input: wobOsc,
    mods: [{ param: "cutoff", chain: lfoStage }],
  };
  audioEngine.reconcile(
    [{ chain: wobble, routed: true }],
    { ...transport, playing: true, timeSec: 0 },
    ctx
  );
  let wobTap: AnalyserNode | null = null;
  for (let waited = 0; waited < 5000 && !wobTap; waited += 200) {
    audioEngine.reconcile(
      [{ chain: wobble, routed: true }],
      { ...transport, playing: true, timeSec: 0 },
      ctx
    );
    wobTap = audioEngine.getTapAnalyser("wf1");
    if (!wobTap) await sleep(200);
  }
  let wobMin = 1;
  let wobMax = 0;
  if (wobTap) {
    await sleep(300);
    const wb = new Float32Array(wobTap.fftSize);
    for (let i = 0; i < 14; i++) {
      wobTap.getFloatTimeDomainData(wb);
      const r = rmsOf(wb);
      wobMin = Math.min(wobMin, r);
      wobMax = Math.max(wobMax, r);
      await sleep(90);
    }
  }
  const wobbleSpread = wobTap ? wobMax - wobMin : -1;

  // ---- Scenario 8 (midi-editor M2): previewNote while transport STOPPED --
  // The piano roll's audition: master is gated to 0 when paused, so the
  // preview must ride the always-open preview path. Reconcile a routed
  // synth chain PAUSED, fire previewNote at the instrument stage, and
  // assert real samples at the stage tap (the voice fired outside the
  // transport). Also exercise the no-instrument fallback for no-throw.
  const previewRoots: AudioChainRoot[] = [{ chain: reverb, routed: true }];
  audioEngine.reconcile(
    previewRoots,
    { ...transport, playing: false, timeSec: 0 },
    ctx
  );
  await sleep(150);
  audioEngine.previewNote("s1", 64, 0.9, 0.25);
  let previewRms = 0;
  const pvTap = audioEngine.getTapAnalyser("s1");
  if (pvTap) {
    const pb = new Float32Array(pvTap.fftSize);
    for (let i = 0; i < 8; i++) {
      await sleep(60);
      pvTap.getFloatTimeDomainData(pb);
      previewRms = Math.max(previewRms, rmsOf(pb));
    }
  }
  audioEngine.previewNote(null, 72, 0.8, 0.2); // fallback synth — no-throw

  // ---- Scenario 3 (M1): offline determinism incl. the BitCrusher worklet --
  // notes → Synth → BitCrusher → Reverb rendered twice. BitCrusher is an
  // AudioWorklet — this is the canary for worklet readiness inside
  // Tone.Offline (flagged by the C1 build report).
  const crushed: AudioChainEffect = {
    kind: "effect",
    nodeId: "b1",
    fx: "bitcrusher",
    params: { bits: 6, wet: 1 },
    input: synth,
  };
  const crushedVerb: AudioChainEffect = {
    kind: "effect",
    nodeId: "r2",
    fx: "reverb",
    params: { decay: 1.5, pre_delay: 0.01, wet: 0.35 },
    input: crushed,
  };
  const offlineRoots: AudioChainRoot[] = [{ chain: crushedVerb, routed: true }];
  const oa = await audioEngine.renderOffline(offlineRoots, 1.0, 0, timebase);
  const ob = await audioEngine.renderOffline(offlineRoots, 1.0, 0, timebase);
  let synthOfflineRms = 0;
  let synthDeterministic = false;
  if (oa && ob) {
    synthOfflineRms = rmsOf(oa.getChannelData(0) as unknown as Float32Array);
    const ca = oa.getChannelData(0);
    const cb = ob.getChannelData(0);
    synthDeterministic = ca.length === cb.length;
    if (synthDeterministic) {
      for (let i = 0; i < ca.length; i++) {
        if (ca[i] !== cb[i]) {
          synthDeterministic = false;
          break;
        }
      }
    }
  }

  return {
    ok:
      liveRms > 0.02 &&
      offlineRms > 0.02 &&
      deterministic &&
      masterGain > 0.9 &&
      synthRms > 0.02 &&
      synthOfflineRms > 0.005 &&
      synthDeterministic &&
      tapLiveRms > 0.02 &&
      tapOfflineRms > 0.005 &&
      wobMax > 0.05 &&
      wobbleSpread > 0.03 &&
      leafOfflineRms > 0.1 &&
      autoLastQ > 0.1 &&
      autoLastQ > autoFirstQ * 2.5 &&
      previewRms > 0.02,
    liveRms,
    offlineRms,
    deterministic,
    masterGain,
    synthRms,
    synthOfflineRms,
    synthDeterministic,
    tapLiveRms,
    tapOfflineRms,
    wobMax,
    wobbleSpread,
    leafOfflineRms,
    autoFirstQ,
    autoLastQ,
    previewRms,
    report,
  };
}
