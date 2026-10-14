// skia-harness — plays a toolbox → React Native Skia export
// (specdocs/101326_skia-target.md). The same App runs on iOS / Android dev
// builds and on the web (CanvasKit).
//
// Web query params: ?t=<seconds> freezes the clock at that time, ?size=<pt>
// sets the canvas edge (default: the export's canvas width). For the parity
// script, window.__toolboxHarness.capture(t) seeks, waits for Skia to draw,
// and returns the canvas pixels (RGBA8, unpremultiplied, row 0 = top).
import React, { useEffect } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { AlphaType, ColorType, useCanvasRef } from "react-native-skia";
import { CANVAS, NAME, TIMELINE, ToolboxEffect, useToolboxClock } from "./src/bundle";

const query =
  Platform.OS === "web" && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : null;
const frozenAt = query?.get("t") != null ? Number(query.get("t")) : null;
const size = Number(query?.get("size") ?? CANVAS.width);

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

export default function App() {
  const time = useToolboxClock({ playing: frozenAt === null, start: frozenAt ?? 0 });
  const canvasRef = useCanvasRef();

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const w = window as unknown as Record<string, unknown>;
    w.__toolboxHarness = {
      name: NAME,
      timeline: TIMELINE,
      size,
      async capture(t: number) {
        time.value = t;
        await nextFrames(4);
        const img = canvasRef.current?.makeImageSnapshot();
        if (!img) throw new Error("makeImageSnapshot returned nothing");
        const width = img.width();
        const height = img.height();
        const px = img.readPixels(0, 0, {
          width,
          height,
          colorType: ColorType.RGBA_8888,
          alphaType: AlphaType.Unpremul,
        });
        if (!(px instanceof Uint8Array)) throw new Error("readPixels returned no 8-bit data");
        return { width, height, rgba: toBase64(px) };
      },
    };
    w.__toolboxHarnessReady = true;
  }, [time, canvasRef]);

  return (
    <View style={styles.root}>
      <ToolboxEffect time={time} width={size} height={size} canvasRef={canvasRef} />
      {query?.get("chrome") !== "0" && (
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
