import type { ImageValue, NodeDefinition } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { makeMaterialDesc } from "@/engine/three-geometry";
import type { ColorRampInterp, ColorRampStop } from "@/engine/color-ramp";

// =====================================================================
// Material — flow-through PBR shader node (081026 spec §6.1)
// =====================================================================
//
// `geometry → Material → geometry`: the Houdini Material-SOP model.
// Copies the value (same BufferGeometry ref, same transform — no buffer
// work) with material slot 0 replaced by a MaterialDesc built from the
// params, each texture-capable channel overridable by wiring an image
// into its `*_map` input (the wire beats the scalar/color param, the
// universal precedence feel). Application is positional: split the geo
// stream AFTER this node ⇒ same material on both branches; BEFORE ⇒
// different per branch.
//
// The desc is pure CPU data — the actual three material (and the
// engine→three texture crossing, §6.2) is resolved at the object3d wrap
// or in 3D Copy to Points via engine/three-geometry.ts, so this node
// costs nothing per eval. transmission > 0 upgrades the resolved
// material to MeshPhysicalMaterial (glass); `ior` rides along with it.
// Emissive / normal map / clearcoat are backlog — the desc shape extends
// without ripple.

export const material3DNode: NodeDefinition = {
  type: "material-3d",
  name: "Material",
  category: "3d",
  description:
    "Material for 3D geometry — PBR (base color, roughness, metalness, transmission/glass, alpha), Toon (bands authored as a color ramp — multi-stop, tinted, hard or blended), or Matcap (view-space clay/studio look; wire an image into base color map to use it as the matcap). Lineart toggle adds outlines: fast silhouette hull or quality silhouette + crease lines. Flows through: wire geometry in, the styled geometry out.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "geometry", type: "geometry", required: true },
    { name: "base_color_map", type: "image", required: false, label: "base color map" },
    { name: "roughness_map", type: "image", required: false, label: "roughness map" },
    { name: "metalness_map", type: "image", required: false, label: "metalness map" },
    { name: "alpha_map", type: "image", required: false, label: "alpha map" },
  ],
  params: [
    {
      name: "shading",
      label: "Shading",
      type: "enum",
      options: ["standard", "toon", "matcap"],
      default: "standard",
      control: "segmented",
    },
    { name: "base_color", label: "Base color", type: "color", default: "#cccccc" },
    {
      name: "roughness",
      label: "Roughness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
      visibleIf: (p) => (p.shading ?? "standard") === "standard",
    },
    {
      name: "metalness",
      label: "Metalness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => (p.shading ?? "standard") === "standard",
    },
    {
      name: "transmission",
      label: "Transmission",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => (p.shading ?? "standard") === "standard",
    },
    {
      name: "ior",
      label: "IOR",
      type: "scalar",
      min: 1,
      max: 2.5,
      step: 0.01,
      default: 1.5,
      visibleIf: (p) =>
        (p.shading ?? "standard") === "standard" &&
        ((p.transmission as number) ?? 0) > 0,
    },
    // Toon band structure as a full color ramp (2026-08-17 — replaces
    // the step-count scalar): stops ARE the bands — position picks where
    // each band starts along the light response, color tints it (cool
    // shadows, warm lights). Constant interpolation = the classic hard
    // bands; linear/ease melt them into painterly gradient shading. Wire
    // a Color Ramp node's `ramp` output to share a palette.
    {
      name: "toon_ramp",
      label: "Toon bands",
      type: "color_ramp",
      default: [
        { id: "toon-a", position: 0, color: "#000000" },
        // Perceptual mid — the sRGB value whose linear intensity is ~0.5,
        // matching the retired 3-step grayscale default.
        { id: "toon-b", position: 0.3333, color: "#bcbcbc" },
        { id: "toon-c", position: 0.6667, color: "#ffffff" },
      ] as ColorRampStop[],
      visibleIf: (p) => p.shading === "toon",
    },
    {
      name: "toon_interp",
      label: "Band interpolation",
      type: "enum",
      options: ["constant", "linear", "ease"],
      default: "constant",
      visibleIf: (p) => p.shading === "toon",
    },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    // -- Lineart --------------------------------------------------------
    // Realized at the object3d boundary as extra retained objects (see
    // engine/three-geometry.ts): "fast" = inverted-hull silhouette (one
    // extra draw, no CPU cost); "quality" adds crease lines from an edge
    // extraction at the crease-angle threshold (hairline width; meshes
    // only — instanced copies draw the silhouette without creases).
    {
      name: "lineart",
      label: "Lineart",
      type: "boolean",
      default: false,
    },
    {
      name: "lineart_technique",
      label: "Technique",
      type: "enum",
      options: ["fast", "quality"],
      default: "fast",
      control: "segmented",
      visibleIf: (p) => !!p.lineart,
    },
    {
      name: "lineart_color",
      label: "Line color",
      type: "color",
      default: "#000000",
      visibleIf: (p) => !!p.lineart,
    },
    {
      name: "lineart_thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 0.2,
      softMax: 0.08,
      step: 0.001,
      default: 0.02,
      visibleIf: (p) => !!p.lineart,
    },
    {
      name: "lineart_opacity",
      label: "Line opacity",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) => !!p.lineart,
    },
    {
      name: "lineart_angle",
      label: "Crease angle (°)",
      type: "scalar",
      min: 1,
      max: 120,
      step: 1,
      default: 40,
      visibleIf: (p) => !!p.lineart && p.lineart_technique === "quality",
    },
  ],
  primaryOutput: "geometry",
  auxOutputs: [],

  compute({ inputs, params, nodeId }) {
    const src = inputs.geometry as GeometryValue | undefined;
    if (!src || src.kind !== "geometry") return {};

    const img = (name: string): ImageValue | undefined => {
      const v = inputs[name];
      return v && v.kind === "image" ? (v as ImageValue) : undefined;
    };

    const shading = ((params.shading as string) ?? "standard") as
      | "standard"
      | "toon"
      | "matcap";
    const desc = makeMaterialDesc({
      baseColor: img("base_color_map") ?? ((params.base_color as string) ?? "#cccccc"),
      roughness: img("roughness_map") ?? ((params.roughness as number) ?? 0.5),
      metalness: img("metalness_map") ?? ((params.metalness as number) ?? 0),
      // Toon/matcap have no transmission path — force 0 so the class
      // choice (materialClassFor) is unambiguous.
      transmission:
        shading === "standard" ? ((params.transmission as number) ?? 0) : 0,
      ior: (params.ior as number) ?? 1.5,
      alpha: img("alpha_map") ?? ((params.alpha as number) ?? 1),
      shading,
      toonRamp:
        shading === "toon"
          ? {
              stops: Array.isArray(params.toon_ramp)
                ? (params.toon_ramp as ColorRampStop[])
                : [],
              interp: ((params.toon_interp as string) ??
                "constant") as ColorRampInterp,
            }
          : undefined,
      // Preserve a Bump node's contribution when Material is downstream
      // of it (slot-0 rebuild would otherwise drop it).
      bump: src.materials[0]?.bump,
      lineart: params.lineart
        ? {
            technique:
              ((params.lineart_technique as string) ?? "fast") === "quality"
                ? "quality"
                : "fast",
            color: (params.lineart_color as string) ?? "#000000",
            thickness: (params.lineart_thickness as number) ?? 0.02,
            opacity: (params.lineart_opacity as number) ?? 1,
            angle: (params.lineart_angle as number) ?? 40,
          }
        : undefined,
    });

    // Slot 0 replaced, other slots (future multi-material imports) kept.
    const out: GeometryValue = {
      ...src,
      nodeId,
      materials: [desc, ...src.materials.slice(1)],
    };
    return { primary: out };
  },
};
