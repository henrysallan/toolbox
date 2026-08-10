// The audio engine — the ONE module that touches Tone.js
// (specdocs/080826_audio-nodes.md).
//
// Audio node defs emit AudioChainNode descriptors; evaluateGraph hands the
// descriptor roots that arrived this eval (plus which of them landed on an
// Output node's `audio` socket) to `audioEngine.reconcile()`. This module
// diffs the resulting plan against the previous one (audio-chain.ts, pure)
// and applies the ops to a persistent Tone.js graph: create / dispose
// stages, ramp params (setTargetAtTime-style — no zipper noise), rewire
// connections, and gate the master output.
//
// Rules of the room:
//  - Tone is loaded LAZILY (dynamic import) on the first eval that carries
//    an audio chain. A project without chains never pays for the bundle.
//  - Tone mounts on the SHARED AudioContext from audio-analysis.ts — a
//    MediaElementSource binds its element to one context forever, so the
//    analysis taps and the chain graph must live together.
//  - The transport is SLAVED to the scene clock (play/pause/seek/loop
//    arrive via AudioTransportState). Audio never advances the scene.
//  - Chains reach the speakers only through `master`, and only while the
//    scene plays AND at least one routed sink exists. Unrouted chains stay
//    built-but-disconnected so analysis taps keep reading (M2).
//  - `Tone.Offline` renders the same descriptors deterministically for
//    export. While an offline render is in flight, live reconciles are
//    deferred — Tone.Offline swaps the AMBIENT context, and a live create
//    during that window would land nodes in the offline context.
//
// Adding a stage adapter (M1): add an entry to the family module for your
// stage kind (audio-adapters-{generators,instruments,effects-tone,
// effects-time,routing}.ts), keyed by `stageShapeKey()` output. The
// closure returned by `create` owns every Tone object it made and how
// params map onto them; nothing else needs to know. The shared contract
// (StageHandles etc.) lives in audio-adapter-types.ts. Only the element
// leaf adapter stays here — it rides the shared element-source registry.

import type { AudioChainNode, RenderContext } from "./types";
import {
  type AudioAutomationTimeline,
  type AudioChainRoot,
  type AudioGraphPlan,
  buildAudioGraphPlan,
  chainSignature,
  DEFAULT_BPM,
  diffAudioGraphPlans,
  diffIsEmpty,
  diffStageParams,
  emptyAudioGraphPlan,
  sinkReachableIds,
  stageShapeKey,
} from "./audio-chain";
import {
  getOrCreateElementSource,
  getSharedAudioContext,
  setChainTapProvider,
} from "./audio-analysis";
import { pushMediaSettle } from "./offline-settle";
import {
  type AdapterEnv,
  type AdapterFactory,
  type AudioTimebase,
  type OutputNodeT,
  type InputNodeT,
  type StageHandles,
  type ToneModule,
  RAMP_SEC,
} from "./audio-adapter-types";
import { generatorAdapters } from "./audio-adapters-generators";
import { instrumentAdapters } from "./audio-adapters-instruments";
import { toneEffectAdapters } from "./audio-adapters-effects-tone";
import { timeEffectAdapters } from "./audio-adapters-effects-time";
import { routingAdapters } from "./audio-adapters-routing";

type ToneGain = InstanceType<ToneModule["Gain"]>;

export interface AudioTransportState {
  playing: boolean;
  timeSec: number;
  bpm: number;
  fps: number;
  ticksPerFrame: number;
}

// Seek drift beyond this re-syncs the slaved transport (same 100ms-class
// tolerance the Audio Source element nudge uses).
const DRIFT_SEC = 0.12;
// Element-backed source entering a chain. LIVE: reuses the SHARED
// per-element WebAudio wrap (audio-analysis.ts) — and while this stage is
// alive, the element's default direct-to-speakers path is muted so the dry
// signal doesn't double the processed one. Mic leaves tap the stream (no
// direct path to mute). OFFLINE (080926 M-B): a url-backed leaf re-creates
// the element's timeline behavior from its snapshot hints — a synced
// transport Player skipping `startOffset` into the file, honoring loop and
// volume. Mic (url null) renders silent, the standing rule.
function elementAdapter(
  T: ToneModule,
  stage: AudioChainNode,
  env: AdapterEnv
): StageHandles | null {
  if (stage.kind !== "element") return null;
  const through = new T.Gain(1);
  let direct: GainNode | null = null;
  let muted = false;
  let offlinePlayer: InstanceType<ToneModule["Player"]> | null = null;

  if (env.offline) {
    if (stage.url) {
      through.gain.value = Math.max(0, Math.min(1, stage.volume ?? 1));
      offlinePlayer = new T.Player({
        url: stage.url,
        loop: stage.loop === true,
      });
      offlinePlayer.connect(through);
      // sync !== false: skip startOffset into the file (Audio Source's
      // sync mode). Free-run plays from 0 — mirroring export-audio.ts.
      const offset =
        stage.sync !== false ? Math.max(0, stage.startOffset ?? 0) : 0;
      offlinePlayer.sync().start(0, offset);
    }
  } else if (env.renderCtx) {
    const entry = getOrCreateElementSource(env.renderCtx, stage.element, stage.source);
    if (entry) {
      T.connect(entry.source, through);
      direct = entry.direct;
    }
  }

  const setDirect = (mute: boolean) => {
    if (!direct || muted === mute) return;
    muted = mute;
    direct.gain.setTargetAtTime(
      mute ? 0 : 1,
      direct.context.currentTime,
      RAMP_SEC
    );
  };

  return {
    output: through,
    inputAt: () => null,
    update() {
      // The element's own volume/mute/seek behavior stays on the source
      // node (audio.ts / video.ts); the leaf has no params of its own.
    },
    claim: setDirect,
    dispose() {
      setDirect(false);
      offlinePlayer?.unsync();
      offlinePlayer?.dispose();
      through.dispose();
    },
  };
}

const ADAPTERS: Record<string, AdapterFactory> = {
  ...generatorAdapters,
  ...instrumentAdapters,
  ...toneEffectAdapters,
  ...timeEffectAdapters,
  ...routingAdapters,
  "element:file": elementAdapter,
  "element:video": elementAdapter,
  "element:mic": elementAdapter,
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface LiveStage {
  shapeKey: string;
  stage: AudioChainNode;
  handles: StageHandles;
  // Connections made INTO this stage: [laneIndex] -> upstream output we
  // connected from. Torn down before re-making on rewire.
  inConns: { fromId: string; from: OutputNodeT; to: InputNodeT }[];
  isSink: boolean;
  tap: AnalyserNode | null;
}

class AudioEngine {
  private tone: ToneModule | null = null;
  private toneLoading = false;
  private contextMounted = false;

  private live = new Map<string, LiveStage>();
  private plan: AudioGraphPlan = emptyAudioGraphPlan();
  private master: ToneGain | null = null;
  private lastTransport: AudioTransportState | null = null;

  private offlineInFlight = false;
  private offlineQueue: Promise<unknown> = Promise.resolve();
  private captureDest: MediaStreamAudioDestinationNode | null = null;
  private capturedElements = new WeakSet<HTMLMediaElement>();
  // Audition path (080926_midi-editor.md M2): an ALWAYS-OPEN gain to the
  // destination, bypassing the transport-gated master so note previews
  // sound while the timeline is stopped. Chain sinks connect into it only
  // for the preview's window (refcounted; see previewNote); the fallback
  // synth lives on it permanently.
  private previewGain: ToneGain | null = null;
  private previewTaps = new Map<string, { count: number; timer: number }>();
  private previewSynth: {
    triggerAttackRelease: (
      f: number,
      d: number,
      t: undefined,
      v: number
    ) => void;
  } | null = null;
  private pendingReconcile: {
    roots: AudioChainRoot[];
    transport: AudioTransportState;
    renderCtx: RenderContext;
  } | null = null;
  // Offline analysis-tap buffers, keyed by chain root nodeId and
  // invalidated by content signature / window growth (M-A). Small LRU —
  // a 30s stereo buffer is ~10MB.
  private offlineTapCache = new Map<
    string,
    {
      signature: string;
      endSec: number;
      buffer: AudioBuffer | null;
      pending: boolean;
      job: Promise<void>;
    }
  >();

  // Called once per top-level eval (evaluator.ts) with every chain root
  // produced this pass. Cheap when nothing changed: plan build is O(stages)
  // over tiny trees and the diff short-circuits on descriptor identity.
  reconcile(
    roots: AudioChainRoot[],
    transport: AudioTransportState,
    renderCtx: RenderContext
  ): void {
    if (this.offlineInFlight) {
      this.pendingReconcile = { roots, transport, renderCtx };
      return;
    }
    const plan = buildAudioGraphPlan(roots);
    if (plan.stages.size === 0 && this.live.size === 0) {
      // No chains anywhere — never load Tone for a chainless project.
      this.lastTransport = transport;
      return;
    }
    if (!this.tone) {
      this.loadTone(renderCtx);
      // Record the transport even though we can't act on it yet — without
      // this, a user who pressed Play before Tone finished loading would
      // leave a stale `playing: true` behind, and syncTransport would
      // never see the play TRANSITION it keys context-resume off of.
      this.lastTransport = transport;
      return;
    }
    if (!this.contextMounted) this.mountContext(renderCtx);

    const diff = diffAudioGraphPlans(this.plan, plan);
    if (!diffIsEmpty(diff)) {
      this.applyDiff(plan, diff, renderCtx);
      // Element leaves mute their direct speaker path only while they feed
      // an AUDIBLE chain; recomputed on any structural/sink change.
      const audibleIds = sinkReachableIds(plan);
      for (const [id, ls] of this.live) {
        ls.handles.claim?.(audibleIds.has(id));
      }
    }
    this.plan = plan;
    this.syncTransport(transport, diff.create.length > 0);
    this.lastTransport = transport;
  }

  // Live analyser tap on any stage's output (analysis nodes, M2). Created
  // on demand; lives until the stage is disposed.
  getTapAnalyser(nodeId: string): AnalyserNode | null {
    const T = this.tone;
    const ls = this.live.get(nodeId);
    if (!T || !ls) return null;
    if (ls.tap) return ls.tap;
    try {
      const raw = T.getContext().rawContext as AudioContext;
      const analyser = raw.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.3;
      T.connect(ls.handles.output, analyser);
      ls.tap = analyser;
      return analyser;
    } catch {
      return null;
    }
  }

  // One-shot note audition for the piano roll (080926_midi-editor.md M2).
  // Fires through the LIVE wired instrument stage when it exists — the
  // preview rides the user's own chain (filter, reverb, …) — else through
  // a quiet built-in synth so sketching before wiring still auditions.
  //
  // The stopped-transport problem: master gain is 0 while the scene is
  // paused, exactly when authoring happens. While NOT playing, the
  // instrument's chain SINK is temporarily connected into `previewGain`
  // (always open) for the note's window + release tail, refcounted so
  // rapid previews share one connection. While playing, master is open —
  // no extra route, no doubling. Accepted edge (spec): a free-running
  // generator sharing the chain sounds during the preview window.
  previewNote(
    instrumentStageId: string | null,
    pitch: number,
    velocity: number,
    durationSec: number
  ): void {
    const T = this.tone;
    if (!T || !this.contextMounted || this.offlineInFlight) return;
    // Called from a click/keypress — safe (and necessary on first use) to
    // resume a suspended context.
    if (T.getContext().state !== "running") void T.start().catch(() => {});
    if (!this.previewGain) {
      this.previewGain = new T.Gain(1);
      this.previewGain.connect(T.getDestination());
    }

    const ls = instrumentStageId ? this.live.get(instrumentStageId) : undefined;
    if (ls?.handles.triggerNote) {
      if (!this.lastTransport?.playing && instrumentStageId) {
        // Route this instrument's chain sink through the preview gain for
        // the note's audible window.
        const reach = sinkReachableIds(this.plan);
        const sinkId = this.plan.sinks.find((s) => {
          if (!reach.has(instrumentStageId)) return false;
          const own = sinkReachableIds({
            stages: this.plan.stages,
            sinks: [s],
          });
          return own.has(instrumentStageId);
        });
        const sink = sinkId ? this.live.get(sinkId) : undefined;
        if (sink && sinkId) {
          const holdMs = Math.ceil((durationSec + 1.5) * 1000);
          const tap = this.previewTaps.get(sinkId);
          if (tap) {
            tap.count += 1;
            clearTimeout(tap.timer);
          } else {
            try {
              T.connect(sink.handles.output, this.previewGain);
            } catch {
              // sink just disposed — the trigger below still fires dry
            }
            this.previewTaps.set(sinkId, { count: 1, timer: 0 });
          }
          const entry = this.previewTaps.get(sinkId)!;
          entry.timer = setTimeout(() => {
            this.previewTaps.delete(sinkId);
            try {
              T.disconnect(sink.handles.output, this.previewGain!);
            } catch {
              // already gone with a disposed stage — nothing to sever
            }
          }, holdMs) as unknown as number;
        }
      }
      ls.handles.triggerNote(pitch, velocity, durationSec);
      return;
    }

    // Fallback: nothing wired (or the stage isn't live yet) — a quiet
    // built-in synth on the preview path keeps sketching audible.
    if (!this.previewSynth) {
      const synth = new T.PolySynth({
        voice: T.Synth,
        maxPolyphony: 8,
        options: { oscillator: { type: "triangle" }, volume: -10 },
      });
      synth.connect(this.previewGain);
      this.previewSynth = synth;
    }
    this.previewSynth.triggerAttackRelease(
      440 * Math.pow(2, (pitch - 69) / 12),
      Math.max(0.02, durationSec),
      undefined,
      Math.max(0, Math.min(1, velocity))
    );
  }

  // Live capture of the audible mix for the Fast (MediaRecorder) export
  // path (080926 M-B): a MediaStreamDestination fed by the chain MASTER,
  // plus any bare element sources handed in (their shared wraps connect in
  // alongside the direct speaker path — the recording hears them without
  // double-audibility). One track carries the whole mix. Note this WRAPS a
  // previously-unbound element (the one-way door) — its direct gain keeps
  // it audible, same as the analysis taps.
  getCaptureTrack(
    renderCtx: RenderContext,
    elements: { element: HTMLMediaElement; source: "file" | "mic" | "video" }[]
  ): MediaStreamTrack | null {
    const T = this.tone;
    if (!T || !this.contextMounted || !this.master) return null;
    try {
      if (!this.captureDest) {
        const raw = T.getContext().rawContext as AudioContext;
        this.captureDest = raw.createMediaStreamDestination();
        T.connect(this.master, this.captureDest);
      }
      for (const e of elements) {
        if (this.capturedElements.has(e.element)) continue;
        const entry = getOrCreateElementSource(renderCtx, e.element, e.source);
        if (!entry) continue;
        entry.source.connect(this.captureDest);
        this.capturedElements.add(e.element);
      }
      return this.captureDest.stream.getAudioTracks()[0] ?? null;
    } catch {
      return null;
    }
  }

  // Latest time-domain window from a live stage's tap — the ChainTapProvider
  // live half (audio-analysis.ts getAudioFrame's chain branch).
  readLiveTap(
    chainNodeId: string
  ): { timeDomain: Float32Array; sampleRate: number } | null {
    const tap = this.getTapAnalyser(chainNodeId);
    if (!tap) return null;
    const timeDomain = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(timeDomain);
    return { timeDomain, sampleRate: tap.context.sampleRate };
  }

  // Deterministic offline buffer for a tapped chain covering at least
  // [0, minEndSec) — the ChainTapProvider offline half. Renders from scene
  // t=0 (notes are absolute, so the prefix is identical no matter the
  // requested window) with CHUNKED growth: a later frame slicing past the
  // buffer's end re-renders a doubled window, whose prefix matches the old
  // buffer sample-for-sample, so analysis never sees a seam. Rendering is
  // async and this is sync — first call kicks the render, registers a
  // settle (the export driver's re-render pass captures real data), and
  // returns null.
  getOfflineChainBuffer(
    chain: AudioChainNode,
    ctx: RenderContext,
    minEndSec: number
  ): AudioBuffer | null {
    const sig = chainSignature(chain);
    let entry = this.offlineTapCache.get(chain.nodeId);
    if (!entry || entry.signature !== sig || entry.endSec < minEndSec) {
      const endSec = Math.max(30, Math.ceil(minEndSec * 2));
      const e = {
        signature: sig,
        endSec,
        buffer: null as AudioBuffer | null,
        pending: true,
        job: Promise.resolve(),
      };
      e.job = this.renderOffline([{ chain, routed: true }], endSec, 0, {
        bpm: ctx.bpm ?? DEFAULT_BPM,
        fps: ctx.fps,
        ticksPerFrame: ctx.ticksPerFrame,
      }).then((buf) => {
        e.buffer = buf;
        e.pending = false;
      });
      // LRU-ish cap: drop the oldest entry beyond 4 chains (~10MB each).
      if (this.offlineTapCache.size >= 4 && !this.offlineTapCache.has(chain.nodeId)) {
        const oldest = this.offlineTapCache.keys().next().value;
        if (oldest !== undefined) this.offlineTapCache.delete(oldest);
      }
      this.offlineTapCache.set(chain.nodeId, e);
      entry = e;
    }
    if (entry.pending) {
      // Settle with a ceiling so a wedged render can't hang the export —
      // same discipline as the decode path (audio-analysis.ts).
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
          entry!.job.then(finish, finish);
          setTimeout(finish, 30000);
        })
      );
      return null;
    }
    return entry.buffer;
  }

  // Deterministic offline render of the given roots over
  // [startSec, startSec + durationSec) — the export mixdown and the
  // analysis-tap buffers. Builds a FRESH graph inside Tone.Offline via the
  // same adapters that drive live playback. Live reconciles are deferred
  // while a render runs (ambient-context swap), and concurrent calls are
  // SERIALIZED through a queue for the same reason — two Tone.Offline
  // callbacks racing would create stages in each other's contexts.
  renderOffline(
    roots: AudioChainRoot[],
    durationSec: number,
    startSec: number,
    timebase: { bpm: number; fps: number; ticksPerFrame: number },
    // Keyframed-param automation replayed as scheduled ramps (M-B).
    automation?: AudioAutomationTimeline
  ): Promise<AudioBuffer | null> {
    const run = this.offlineQueue.then(() =>
      this.renderOfflineNow(roots, durationSec, startSec, timebase, automation)
    );
    this.offlineQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async renderOfflineNow(
    roots: AudioChainRoot[],
    durationSec: number,
    startSec: number,
    timebase: { bpm: number; fps: number; ticksPerFrame: number },
    automation?: AudioAutomationTimeline
  ): Promise<AudioBuffer | null> {
    if (durationSec <= 0) return null;
    const T = await this.loadToneModule();
    if (!T) return null;
    this.offlineInFlight = true;
    try {
      const rendered = await T.Offline(async () => {
        const plan = buildAudioGraphPlan(roots);
        const built = new Map<string, StageHandles>();
        for (const [id, sp] of plan.stages) {
          const factory = ADAPTERS[stageShapeKey(sp.stage)];
          try {
            const handles = factory?.(T, sp.stage, {
              renderCtx: null,
              offline: true,
            });
            if (handles) built.set(id, handles);
          } catch (err) {
            // One broken stage must not silently zero the whole mixdown —
            // its consumers see silence at that input, everything else
            // renders, and the cause is on the console.
            console.warn(`[audio-engine] offline stage "${id}" failed to build:`, err);
          }
        }
        for (const [id, sp] of plan.stages) {
          const h = built.get(id);
          if (!h) continue;
          sp.inputIds.forEach((fromId, lane) => {
            const from = built.get(fromId);
            const to = h.inputAt(lane);
            if (from && to) T.connect(from.output, to);
          });
          for (const m of sp.modConns) {
            const from = built.get(m.fromId);
            const to = h.modTarget?.(m.param) ?? null;
            if (from && to) T.connect(from.output, to);
          }
          // Notes sit at ABSOLUTE transport seconds (offset 0); the
          // transport starts at the export window's startSec below, so
          // pre-window events are skipped and in-window events land at
          // the right render time. Don't also shift the events.
          h.schedule?.(sp.stage, 0, timebase);
        }
        for (const sink of plan.sinks) {
          const h = built.get(sink);
          if (h) T.connect(h.output, T.getDestination());
        }
        // Automation replay (M-B): schedule keyframed param values at
        // their context times. The offline context's clock starts at the
        // export window's start, so `at` = timeSec − startSec (pre-window
        // frames clamp to 0 — the diff against the previous frame keeps
        // that a single settled value, not a pile-up). Consecutive frames
        // diff so unchanged params schedule nothing.
        if (automation) {
          for (const [nodeId, frames] of automation) {
            const h = built.get(nodeId);
            const sp = plan.stages.get(nodeId);
            if (!h || !sp) continue;
            const stage = sp.stage;
            if (stage.kind === "element" || stage.kind === "mix") continue;
            let prevParams = stage.params;
            for (const f of frames) {
              const merged = { ...prevParams, ...f.params };
              const changed = diffStageParams(prevParams, merged);
              if (changed.length === 0) continue;
              const patched = { ...stage, params: merged } as AudioChainNode;
              h.update(
                patched,
                {
                  nodeId,
                  params: changed,
                  mixLanesChanged: false,
                  notesChanged: false,
                },
                Math.max(0, f.timeSec - startSec)
              );
              prevParams = merged;
            }
          }
        }
        // Sample-holding stages (Player buffers, Sampler files) load
        // async even in the offline context — settle before rolling.
        await T.loaded().catch(() => {});
        // AudioWorklet-backed stages (BitCrusher) register their processor
        // module asynchronously too; without this the worklet node renders
        // pure silence. `workletsAreReady` is protected in Tone's typings —
        // reach it structurally, tolerate absence (older Tone) and failure
        // (insecure context: the affected stage stays silent, warned above).
        try {
          await (
            T.getContext() as unknown as {
              workletsAreReady?: () => Promise<void>;
            }
          ).workletsAreReady?.();
        } catch {
          // Worklets unavailable — worklet stages render silent.
        }
        T.getTransport().bpm.value = timebase.bpm;
        T.getTransport().start(0, startSec);
      }, durationSec);
      return rendered.get() ?? null;
    } catch {
      return null;
    } finally {
      this.offlineInFlight = false;
      const pending = this.pendingReconcile;
      this.pendingReconcile = null;
      if (pending) {
        this.reconcile(pending.roots, pending.transport, pending.renderCtx);
      }
    }
  }

  // ---------------------------------------------------------------- private

  private loadTone(renderCtx: RenderContext): void {
    if (this.toneLoading) return;
    this.toneLoading = true;
    void this.loadToneModule().then((T) => {
      if (!T) return;
      this.mountContext(renderCtx);
      // Re-enter through a fresh eval so the deferred plan applies with
      // current descriptors (same async-result pattern as font loads).
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("pipeline-bump"));
      }
    });
  }

  private async loadToneModule(): Promise<ToneModule | null> {
    if (this.tone) return this.tone;
    try {
      const T = await import("tone");
      this.tone = T;
      return T;
    } catch (err) {
      // Surface this loudly: a swallowed load failure presents as "audio
      // nodes silently do nothing", which is undebuggable from the UI.
      console.warn("[audio-engine] Tone.js failed to load — audio chains disabled:", err);
      this.toneLoading = false;
      return null;
    }
  }

  // Devtools/debug snapshot of the live audio graph — the audio sibling of
  // window.__perf. `window.__audio.report()` answers "why is it silent":
  // is Tone loaded, is the context running, did the master gain open, which
  // stages exist, which are sinks.
  report(): Record<string, unknown> {
    const T = this.tone;
    return {
      toneLoaded: !!T,
      contextMounted: this.contextMounted,
      contextState: T && this.contextMounted ? T.getContext().state : "n/a",
      masterGain: this.master ? this.master.gain.value : null,
      stages: [...this.live.entries()].map(([id, ls]) => ({
        id,
        shape: ls.shapeKey,
        sink: ls.isSink,
        inputs: ls.inConns.map((c) => c.fromId),
      })),
      sinks: this.plan.sinks,
      transport: this.lastTransport,
    };
  }

  private mountContext(renderCtx: RenderContext): void {
    const T = this.tone;
    if (!T || this.contextMounted) return;
    const raw = getSharedAudioContext(renderCtx);
    if (!raw) return;
    T.setContext(raw);
    this.master = new T.Gain(0);
    this.master.connect(T.getDestination());
    this.contextMounted = true;
    if (typeof window !== "undefined") {
      (window as unknown as { __audio: unknown }).__audio = {
        report: () => this.report(),
      };
    }
  }

  private applyDiff(
    plan: AudioGraphPlan,
    diff: ReturnType<typeof diffAudioGraphPlans>,
    renderCtx: RenderContext
  ): void {
    const T = this.tone;
    if (!T || !this.master) return;

    for (const id of diff.dispose) this.disposeStage(id);

    for (const id of diff.create) {
      const sp = plan.stages.get(id);
      if (!sp) continue;
      const factory = ADAPTERS[stageShapeKey(sp.stage)];
      let handles: StageHandles | null | undefined;
      try {
        handles = factory?.(T, sp.stage, { renderCtx, offline: false });
      } catch (err) {
        // A throwing adapter must not abort the whole diff — the other
        // stages still build/retune; this one stays absent (silent) and
        // the cause is on the console.
        console.warn(`[audio-engine] stage "${id}" failed to build:`, err);
        continue;
      }
      if (!handles) continue; // unknown adapter key — nothing to run
      this.live.set(id, {
        shapeKey: stageShapeKey(sp.stage),
        stage: sp.stage,
        handles,
        inConns: [],
        isSink: false,
        tap: null,
      });
    }

    for (const u of diff.update) {
      const ls = this.live.get(u.nodeId);
      const sp = plan.stages.get(u.nodeId);
      if (!ls || !sp) continue;
      ls.handles.update(sp.stage, u);
      ls.stage = sp.stage;
      if (u.notesChanged && this.lastTransport?.playing) {
        this.scheduleStage(ls, sp.stage);
      }
    }

    for (const id of diff.rewire) {
      const ls = this.live.get(id);
      const sp = plan.stages.get(id);
      if (!ls || !sp) continue;
      for (const conn of ls.inConns) {
        try {
          T.disconnect(conn.from, conn.to);
        } catch {
          // Already gone (upstream disposed) — nothing to sever.
        }
      }
      ls.inConns = [];
      sp.inputIds.forEach((fromId, lane) => {
        const from = this.live.get(fromId);
        const to = ls.handles.inputAt(lane);
        if (!from || !to) return;
        T.connect(from.handles.output, to);
        ls.inConns.push({ fromId, from: from.handles.output, to });
      });
      // Mod edges: modulator output → named Tone Signal, where WebAudio
      // sums it with the knob value. Tracked in inConns like any other
      // incoming connection so teardown covers them.
      for (const m of sp.modConns) {
        const from = this.live.get(m.fromId);
        const to = ls.handles.modTarget?.(m.param) ?? null;
        if (!from || !to) continue;
        T.connect(from.handles.output, to);
        ls.inConns.push({ fromId: m.fromId, from: from.handles.output, to });
      }
      ls.stage = sp.stage;
    }

    if (diff.sinksChanged) {
      const sinkSet = new Set(plan.sinks);
      for (const [id, ls] of this.live) {
        const shouldBeSink = sinkSet.has(id);
        if (ls.isSink === shouldBeSink) continue;
        try {
          if (shouldBeSink) T.connect(ls.handles.output, this.master);
          else T.disconnect(ls.handles.output, this.master);
        } catch {
          // Disconnect of a never-connected pair — harmless.
        }
        ls.isSink = shouldBeSink;
      }
    }
  }

  private disposeStage(id: string): void {
    const T = this.tone;
    const ls = this.live.get(id);
    if (!T || !ls) return;
    if (ls.tap) {
      try {
        T.disconnect(ls.handles.output, ls.tap);
      } catch {
        // output already disposed — tap dies with it
      }
      ls.tap = null;
    }
    if (ls.isSink && this.master) {
      try {
        T.disconnect(ls.handles.output, this.master);
      } catch {
        // already disconnected
      }
    }
    for (const conn of ls.inConns) {
      try {
        T.disconnect(conn.from, conn.to);
      } catch {
        // already disconnected
      }
    }
    ls.handles.releaseAll?.();
    ls.handles.dispose();
    this.live.delete(id);
  }

  private timebase(): AudioTimebase {
    const t = this.lastTransport;
    return {
      bpm: t?.bpm ?? DEFAULT_BPM,
      fps: t?.fps ?? 60,
      ticksPerFrame: t?.ticksPerFrame ?? 1000,
    };
  }

  private scheduleStage(ls: LiveStage, stage: AudioChainNode): void {
    if (stage.kind !== "instrument" || !ls.handles.schedule) return;
    ls.handles.schedule(stage, 0, this.timebase());
  }

  private scheduleAll(): void {
    for (const [id, ls] of this.live) {
      const sp = this.plan.stages.get(id);
      if (sp) this.scheduleStage(ls, sp.stage);
    }
  }

  private releaseAllInstruments(): void {
    for (const ls of this.live.values()) ls.handles.releaseAll?.();
  }

  private syncTransport(t: AudioTransportState, createdStages: boolean): void {
    const T = this.tone;
    if (!T || !this.master) return;
    const transport = T.getTransport();
    const was = this.lastTransport;

    transport.bpm.value = t.bpm;

    // Belt-and-braces context resume: whenever the scene is playing and the
    // context isn't running, try to start it — NOT just on the play
    // transition. The context can be created suspended (autoplay policy)
    // and a resume tied only to the transition edge is easy to miss when
    // stages/Tone arrive after the user already pressed Play. Legal here:
    // by the time the scene is playing the page has sticky user activation.
    if (t.playing && T.getContext().state !== "running") {
      void T.start().catch(() => {});
    }

    if (t.playing && !was?.playing) {
      transport.seconds = t.timeSec;
      this.scheduleAll();
      transport.start();
    } else if (!t.playing && was?.playing) {
      transport.pause();
      this.releaseAllInstruments();
    } else if (t.playing) {
      const drift = Math.abs(transport.seconds - t.timeSec);
      if (drift > DRIFT_SEC) {
        // Scene seek or loop wrap — re-sync and cut held voices so notes
        // from the pre-seek position don't hang over.
        transport.seconds = t.timeSec;
        this.releaseAllInstruments();
      }
      if (createdStages) this.scheduleAll();
    }

    const audible = t.playing && this.plan.sinks.length > 0;
    this.master.gain.rampTo(audible ? 1 : 0, RAMP_SEC);
  }
}

// Singleton, like the EngineBackend — one live audio graph per app.
export const audioEngine = new AudioEngine();

// Hand the analysis layer its chain-tap backend (audio-analysis.ts cannot
// import this module — it would cycle through the shared-context imports —
// so the dependency is injected at load; this module is always loaded via
// the evaluator).
setChainTapProvider({
  readLiveTap: (chainNodeId) => audioEngine.readLiveTap(chainNodeId),
  getOfflineChainBuffer: (chain, ctx, minEndSec) =>
    audioEngine.getOfflineChainBuffer(chain, ctx, minEndSec),
});
