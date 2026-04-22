import { registerNode } from "@/engine/registry";
import { imageSourceNode } from "./source/image-source";
import { paintNode } from "./source/paint";
import { solidColorNode } from "./source/solid-color";
import { gradientNode } from "./source/gradient";
import { perlinNoiseNode } from "./source/perlin-noise";
import { sceneTimeNode } from "./source/scene-time";
import { bloomNode } from "./effect/bloom";
import { mergeNode } from "./effect/merge";
import { gaussianBlurNode } from "./effect/gaussian-blur";
import { ditherNode } from "./effect/dither";
import { colorRampNode } from "./effect/color-ramp";
import { colorCorrectionNode } from "./effect/color-correction";
import { transformNode } from "./effect/transform";
import { outputNode } from "./output/output";

let registered = false;

export function registerAllNodes() {
  if (registered) return;
  registerNode(imageSourceNode);
  registerNode(paintNode);
  registerNode(solidColorNode);
  registerNode(gradientNode);
  registerNode(perlinNoiseNode);
  registerNode(sceneTimeNode);
  registerNode(bloomNode);
  registerNode(mergeNode);
  registerNode(gaussianBlurNode);
  registerNode(ditherNode);
  registerNode(colorRampNode);
  registerNode(colorCorrectionNode);
  registerNode(transformNode);
  registerNode(outputNode);
  registered = true;
}
