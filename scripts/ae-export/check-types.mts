// The shared contracts in src/lib/ae-export/types.ts: the owner's §11
// decisions (2026-10-19) are the defaults, and the ladder order is complete.

import { makeChecker } from "./harness.mts";
import { AE_CLASS_ORDER, DEFAULT_AE_POLICY, type AeExportClass } from "@/lib/ae-export/types";

export default async function run(): Promise<number> {
  const c = makeChecker("types");
  const all: Record<AeExportClass, true> = {
    vector: true, style: true, transform: true, layer: true, mask: true, effect: true,
    expression: true, instances: true, text: true, shader: true, bake: true, unsupported: true,
  };
  c.check("ladder lists every class once", AE_CLASS_ORDER.length === Object.keys(all).length && new Set(AE_CLASS_ORDER).size === AE_CLASS_ORDER.length);
  c.check("ladder ends at shader → bake → unsupported", AE_CLASS_ORDER.slice(-3).join() === "shader,bake,unsupported");
  c.check("§11.3 default fidelity is Editable", DEFAULT_AE_POLICY.fidelity === "editable");
  c.check("§11.4 default color policy is auto (expression on shape/solid colors, dense elsewhere)", DEFAULT_AE_POLICY.color === "auto");
  c.check("§11.4 dense-key tolerance is 2/255", DEFAULT_AE_POLICY.colorTolerance === 2);
  c.check("§11.5 layer budget is 200", DEFAULT_AE_POLICY.layerBudget === 200);
  c.check("§11.5 bake warning is 500 MB", DEFAULT_AE_POLICY.bakeWarnMB === 500);
  return c.failures;
}
