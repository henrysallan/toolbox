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
// the label. For parity:skia, window.__toolboxHarness.capture(t) seeks,
// waits for Skia to draw, and returns the canvas pixels (RGBA8,
// unpremultiplied, row 0 = top).
//
// Native: deep links drive the same capture (capture.ts has the contract):
//   toolboxharness://capture?t=1.25&run=<id>&host=http://127.0.0.1:<port>&frame=75&size=512
// The first capture freezes the clock for the rest of the session.
import React, { useEffect, useRef, useState } from "react";
import { Linking, PixelRatio, Platform, StyleSheet, Text, View } from "react-native";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { useCanvasRef, type CanvasRef } from "react-native-skia";
import * as Effect from "./src/bundle";
import * as Scene from "./src/bundle-scene";
import * as Baked from "./src/bundle-baked";
import { deviceInfo, loopbackHost, nextFrames, parseLink, postJson, snapshot, toBase64, type Snapshot } from "./capture";

const query =
  Platform.OS === "web" && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : null;
const webFrozenAt = query?.get("t") != null ? Number(query.get("t")) : null;
// Which export plays: the M0 SkSL Shader bundle (src/bundle) or the
// Skia-layer scene bundle (src/bundle-scene) with ?bundle=scene. Fixed for
// the page's lifetime, so the hook choice below is stable.
const SCENE = query?.get("bundle") === "scene";
// ?bundle=baked: the same SkSL Shader export with animation "baked"
// (src/bundle-baked) — the timeline inside the SkSL, driven by iTime alone.
const EffectBundle = query?.get("bundle") === "baked" ? Baked : Effect;
const { CANVAS, NAME, TIMELINE } = SCENE ? Scene : EffectBundle;
const ToolboxEffect = SCENE ? Scene.ToolboxScene : EffectBundle.ToolboxEffect;
const useToolboxClock = SCENE ? Scene.useToolboxClock : EffectBundle.useToolboxClock;
const initialSize = Number(query?.get("size") ?? CANVAS.width);

type Capture = (t: number, sizePx?: number) => Promise<Snapshot>;

// The live master clock. Its frame callback is armed once at mount
// (useFrameCallback ignores later autostart changes), so freezing swaps
// this component out for <Frozen> rather than flipping a prop.
function Playing({ size, canvasRef }: { size: number; canvasRef: React.RefObject<CanvasRef | null> }) {
  const time = useToolboxClock({ playing: true });
  return <ToolboxEffect time={time} width={size} height={size} canvasRef={canvasRef} />;
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
      size: initialSize,
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
        <Playing size={sizePt} canvasRef={canvasRef} />
      )}
      {chrome && (
        <Text style={styles.label}>
          {NAME} · toolbox export · {TIMELINE.durationSec}s loop
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#111" },
  label: { color: "#bbb", marginTop: 12, fontSize: 12 },
});
