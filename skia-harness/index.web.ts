// Web entry: CanvasKit must be loaded before any react-native-skia module
// evaluates (the bundle calls Skia.RuntimeEffect.Make at import time).
import { registerRootComponent } from "expo";
import { LoadSkiaWeb } from "react-native-skia/lib/module/web";

LoadSkiaWeb({ locateFile: (file: string) => `/${file}` }).then(async () => {
  const { default: App } = await import("./App");
  registerRootComponent(App);
});
