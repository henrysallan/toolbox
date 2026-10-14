// skia-harness — plays a toolbox → React Native Skia export
// (specdocs/101326_skia-target.md). The same App runs on iOS / Android dev
// builds and on the web (CanvasKit).
//
// Sizes are DEVICE PIXELS: the canvas is size / PixelRatio points, so a
// capture at size=512 is a 512×512 snapshot on a 3× iPhone, a 2.625×
// Android emulator and the 1× web page alike, sampling the shader at the
// same uv as toolbox's 512² render (the export's iResolution is in points).
//
// Web query params: ?t=<seconds> freezes the clock at that time, ?size=<px>
// sets the canvas edge (default: the export's canvas width), ?chrome=0 hides
// the label, ?segment=<name> loops that named segment (the export's
// SEGMENTS, from the composition's timeline markers) instead of the whole
// timeline. With the chrome on, a button row drives the clock's controls
// (loopSegment / playAll / pause / play), and window.__toolboxHarness.clock()
// returns the live clock for scripts. For parity:skia,
// window.__toolboxHarness.capture(t) seeks, waits for Skia to draw, and
// returns the canvas pixels (RGBA8, unpremultiplied, row 0 = top).
//
// ?bundle=scene | atlas | text | baked | image | procedural | procedural-baked |
// filters picks another export on the same master clock (procedural: Aurora
// on LFO / Expression / Scene Time drivers compiled to worklets; -baked: the
// same drivers in the SkSL; filters: the Skia filter family's web-playable
// stack, src/bundle-filters).
//
// ?bundle=native | native-easings | native-scene plays a Reanimated-native export instead
// (native-harness.tsx; with ?clock=fake its capture steps Reanimated's own
// clock frame by frame — the `time` freeze below doesn't apply; with
// ?segment=<name> it plays playSegment(name) instead of play()).
//
// Native: deep links drive the same capture (capture.ts has the contract):
//   toolboxharness://capture?t=1.25&run=<id>&host=http://127.0.0.1:<port>&frame=75&size=512
// The first capture freezes the clock for the rest of the session.
import React, { useEffect, useRef, useState } from "react";
import { Linking, PixelRatio, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { useCanvasRef, type CanvasRef } from "react-native-skia";
import * as Effect from "./src/bundle";
import * as Scene from "./src/bundle-scene";
import * as AtlasScene from "./src/bundle-atlas";
import * as TextScene from "./src/bundle-text";
import * as Filters from "./src/bundle-filters";
import * as Baked from "./src/bundle-baked";
import * as ImageBundle from "./src/bundle-image";
import * as Procedural from "./src/bundle-procedural";
import * as ProceduralBaked from "./src/bundle-procedural-baked";
import * as NativeAurora from "./src/bundle-native";
import { evaluateTrack as nativeAuroraTrack } from "./src/bundle-native/toolbox-timeline";
import * as NativeEasings from "./src/bundle-native-easings";
import { evaluateTrack as nativeEasingsTrack } from "./src/bundle-native-easings/toolbox-timeline";
import * as NativeScene from "./src/bundle-native-scene";
import { evaluateTrack as nativeSceneTrack } from "./src/bundle-native-scene/toolbox-timeline";
import { NativeHarness, type NativeBundle } from "./native-harness";
import { deviceInfo, loopbackHost, nextFrames, parseLink, postJson, snapshot, toBase64, type Snapshot } from "./capture";

const query =
  Platform.OS === "web" && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : null;
const webFrozenAt = query?.get("t") != null ? Number(query.get("t")) : null;
// Which export plays: the M0 SkSL Shader bundle (src/bundle) or a
// Skia-layer scene bundle (src/bundle-scene with ?bundle=scene). Fixed for
// the page's lifetime, so the hook choice below is stable.
// ?bundle=atlas: Copy to Points (Skia) — sprite-sheet atlases (useTexture +
// useRSXformBuffer) and vector copy groups in one scene (src/bundle-atlas,
// `export-skia.mts --fixture atlas`).
// ?bundle=text: the Text (Skia) scene bundle (src/bundle-text, `--fixture
// text`: paragraphs, anchors, letter spacing, a blend group, bundled fonts).
// ?bundle=filters: the Skia filter family's web-playable scene
// (src/bundle-filters: keyframed Blur, Drop Shadow, Morphology and Color
// Matrix on Group layers; `export-skia.mts --fixture filters`).
const SceneBundle =
  query?.get("bundle") === "scene"
    ? Scene
    : query?.get("bundle") === "atlas"
      ? AtlasScene
      : query?.get("bundle") === "text"
        ? TextScene
        : query?.get("bundle") === "filters"
          ? Filters
          : null;
// ?bundle=baked: the same SkSL Shader export with animation "baked"
// (src/bundle-baked) — the timeline inside the SkSL, driven by iTime alone.
// ?bundle=image: an SkSL Shader sampling a bundled image (iImage1, an
// ImageShader of assets/iImage1.png) through ramp / curve LUT children
// (src/bundle-image, `export-skia.mts --fixture image`).
// ?bundle=procedural: Aurora on procedural drivers (LFO, Expressions, Scene
// Time) compiled to worklets (src/bundle-procedural); procedural-baked: the
// same drivers as SkSL (src/bundle-procedural-baked).
const EffectBundle =
  query?.get("bundle") === "baked"
    ? Baked
    : query?.get("bundle") === "image"
      ? ImageBundle
      : query?.get("bundle") === "procedural"
        ? Procedural
        : query?.get("bundle") === "procedural-baked"
          ? ProceduralBaked
          : Effect;
const { CANVAS, NAME, TIMELINE } = SceneBundle ?? EffectBundle;
// (The atlas slot has no markers — its SEGMENTS is {} — so read every slot's
// table as the Aurora one; the chrome lists only the names it really has.)
const SEGMENTS = (SceneBundle ?? EffectBundle).SEGMENTS as typeof Effect.SEGMENTS;
const ToolboxEffect = SceneBundle ? SceneBundle.ToolboxScene : EffectBundle.ToolboxEffect;
// (Likewise its SegmentName is `never`.)
const useToolboxClock = (SceneBundle ? SceneBundle.useToolboxClock : EffectBundle.useToolboxClock) as typeof Effect.useToolboxClock;
// Native-mode slots (animation: "native" exports, native-harness.tsx):
// ?bundle=native (Aurora, src/bundle-native), ?bundle=native-easings (every
// easing kind, src/bundle-native-easings) and ?bundle=native-scene (Aurora
// as a Skia layer, src/bundle-native-scene).
const NATIVE: NativeBundle | null =
  query?.get("bundle") === "native"
    ? { ...NativeAurora, evaluateTrack: nativeAuroraTrack }
    : query?.get("bundle") === "native-easings"
      ? { ...NativeEasings, evaluateTrack: nativeEasingsTrack }
      : query?.get("bundle") === "native-scene"
        ? { ...NativeScene, ToolboxEffect: NativeScene.ToolboxScene, evaluateTrack: nativeSceneTrack }
        : null;
const initialSize = Number(query?.get("size") ?? CANVAS.width);
// Both harness bundles are exported with the same markers (AURORA_MARKERS).
type SegmentName = Effect.SegmentName;
type ToolboxClock = Effect.ToolboxClock;
const SEGMENT_NAMES = Object.keys(SEGMENTS) as SegmentName[];
const webSegment = SEGMENT_NAMES.find((n) => n === query?.get("segment"));

type Capture = (t: number, sizePx?: number) => Promise<Snapshot>;

// The playing clock, for scripts: window.__toolboxHarness.clock().
let liveClock: ToolboxClock | null = null;

// The live master clock. Freezing swaps this component out for <Frozen>
// (a capture owns its own shared value) rather than pausing it.
function Playing({
  size,
  canvasRef,
  chrome,
}: {
  size: number;
  canvasRef: React.RefObject<CanvasRef | null>;
  chrome: boolean;
}) {
  const clock = useToolboxClock({ playing: true, loop: true, segment: webSegment });
  useEffect(() => {
    liveClock = clock;
    return () => {
      if (liveClock === clock) liveClock = null;
    };
  }, [clock]);
  return (
    <>
      <ToolboxEffect time={clock.time} width={size} height={size} canvasRef={canvasRef} />
      {chrome && <ClockControls clock={clock} />}
    </>
  );
}

// The clock's controls as a button row: loop a segment, the whole timeline,
// pause / play. The highlight is this row's own state (shared values don't
// re-render React).
function ClockControls({ clock }: { clock: ToolboxClock }) {
  const [active, setActive] = useState<SegmentName | "all">(webSegment ?? "all");
  const [paused, setPaused] = useState(false);
  const button = (key: string, label: string, on: boolean, onPress: () => void) => (
    <Pressable key={key} onPress={onPress} style={[styles.button, on && styles.buttonOn]}>
      <Text style={[styles.buttonText, on && styles.buttonTextOn]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.controls}>
      {button("all", "all", active === "all", () => {
        clock.playAll({ loop: true });
        setActive("all");
        setPaused(false);
      })}
      {SEGMENT_NAMES.map((name) => {
        const [a, b] = SEGMENTS[name];
        return button(name, `${name} ${a}–${b}s`, active === name, () => {
          clock.loopSegment(name);
          setActive(name);
          setPaused(false);
        });
      })}
      {button("pause", paused ? "play" : "pause", paused, () => {
        if (paused) clock.play();
        else clock.pause();
        setPaused(!paused);
      })}
    </View>
  );
}

function Frozen({
  time,
  size,
  canvasRef,
}: {
  time: SharedValue<number>;
  size: number;
  canvasRef: React.RefObject<CanvasRef | null>;
}) {
  return <ToolboxEffect time={time} width={size} height={size} canvasRef={canvasRef} />;
}

export default function App() {
  return NATIVE ? <NativeHarness bundle={NATIVE} chrome={query?.get("chrome") !== "0"} segment={query?.get("segment")} /> : <ClockApp />;
}

function ClockApp() {
  const canvasRef = useCanvasRef();
  const frozenTime = useSharedValue(webFrozenAt ?? 0);
  const [frozen, setFrozen] = useState(webFrozenAt !== null);
  const [sizePx, setSizePx] = useState(initialSize);
  const sizePt = sizePx / PixelRatio.get();
  // What the last committed render shows — a capture waits for its own
  // state changes to land before snapshotting.
  const shown = useRef({ frozen, sizePx });
  useEffect(() => {
    shown.current = { frozen, sizePx };
  }, [frozen, sizePx]);

  const capture = useRef<Capture>(async () => {
    throw new Error("not ready");
  });
  capture.current = async (t, px) => {
    const want = px && px > 0 ? Math.round(px) : sizePx;
    if (!frozen) setFrozen(true);
    if (want !== sizePx) setSizePx(want);
    for (let i = 0; i < 120 && (!shown.current.frozen || shown.current.sizePx !== want); i++) await nextFrames(1);
    frozenTime.value = t;
    return snapshot(canvasRef, { expectWidth: Platform.OS === "web" ? undefined : want });
  };

  // ---- web: the parity:skia hook -------------------------------------------
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const w = window as unknown as Record<string, unknown>;
    w.__toolboxHarness = {
      name: NAME,
      timeline: TIMELINE,
      segments: SEGMENTS,
      size: initialSize,
      // The live clock (null while frozen) — its shared values and controls.
      clock: () => liveClock,
      async capture(t: number) {
        const s = await capture.current(t);
        return { width: s.width, height: s.height, rgba: toBase64(s.rgba), attempts: s.attempts };
      },
    };
    w.__toolboxHarnessReady = true;
  }, []);

  // ---- native: deep links (scripts/skia-device-parity.mjs) ------------------
  useEffect(() => {
    if (Platform.OS === "web") return;
    let queue = Promise.resolve();
    const onLink = async (url: string) => {
      const link = parseLink(url);
      if (!link) return;
      const host = loopbackHost(link.params.host);
      if (!host) {
        console.warn(`skia-harness: ignoring ${link.action} link — host must be loopback, got ${link.params.host}`);
        return;
      }
      const run = link.params.run ?? "";
      const frame = link.params.frame != null ? Number(link.params.frame) : null;
      try {
        if (link.action === "hello") {
          await postJson(`${host}/hello`, { run, name: NAME, timeline: TIMELINE, canvas: CANVAS, ...deviceInfo() });
        } else if (link.action === "capture") {
          const t = Number(link.params.t);
          if (!Number.isFinite(t)) throw new Error(`capture needs t=<seconds>, got "${link.params.t}"`);
          const size = link.params.size ? Number(link.params.size) : undefined;
          const s = await capture.current(t, size);
          await postJson(`${host}/frame`, {
            run,
            frame,
            t,
            width: s.width,
            height: s.height,
            pixelRatio: PixelRatio.get(),
            attempts: s.attempts,
            rgba: toBase64(s.rgba),
          });
        } else {
          throw new Error(`unknown action "${link.action}"`);
        }
      } catch (e) {
        await postJson(`${host}/error`, { run, frame, message: e instanceof Error ? e.message : String(e) }).catch(
          () => {}
        );
      }
    };
    const enqueue = (url: string | null | undefined) => {
      if (url) queue = queue.then(() => onLink(url));
    };
    Linking.getInitialURL().then(enqueue, () => {});
    const sub = Linking.addEventListener("url", (e) => enqueue(e.url));
    return () => sub.remove();
  }, []);

  const chrome = query ? query.get("chrome") !== "0" : !frozen;
  return (
    <View style={styles.root}>
      {frozen ? (
        <Frozen time={frozenTime} size={sizePt} canvasRef={canvasRef} />
      ) : (
        <Playing size={sizePt} canvasRef={canvasRef} chrome={chrome} />
      )}
      {chrome && (
        <Text style={styles.label}>
          {NAME} · toolbox export ·{" "}
          {webSegment
            ? `segment "${webSegment}" [${SEGMENTS[webSegment][0]}–${SEGMENTS[webSegment][1]}s) looping`
            : `${TIMELINE.durationSec}s loop`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#111" },
  label: { color: "#bbb", marginTop: 12, fontSize: 12 },
  controls: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 12 },
  button: { borderWidth: 1, borderColor: "#555", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  buttonOn: { borderColor: "#a78bfa", backgroundColor: "#2a1f4a" },
  buttonText: { color: "#bbb", fontSize: 12 },
  buttonTextOn: { color: "#c4b5fd" },
});
