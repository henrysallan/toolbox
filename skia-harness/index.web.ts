// Web entry: CanvasKit must be loaded before any react-native-skia module
// evaluates (the bundle calls Skia.RuntimeEffect.Make at import time).
//
// ?clock=fake (the native-mode parity slots): fake-clock.ts, imported
// first, installs the deterministic animation clock before any other module
// can capture requestAnimationFrame; Reanimated's timestamp is pointed at it
// once react-native-worklets has initialised (importing App does that).
import { fakeClock } from "./fake-clock";
import { registerRootComponent } from "expo";
import { LoadSkiaWeb } from "react-native-skia/lib/module/web";

LoadSkiaWeb({ locateFile: (file: string) => `/${file}` }).then(async () => {
  const { default: App } = await import("./App");
  fakeClock()?.bindReanimated();
  registerRootComponent(App);
});
