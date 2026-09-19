import type { ImageValue, NodeDefinition } from "@/engine/types";
import type { GeometryValue } from "@/engine/three-types";
import { makeMaterialDesc } from "@/engine/three-geometry";
import {
  normalizeRampInterp,
  normalizeRampSpace,
  rampInterpParam,
  rampSpaceParam,
  type ColorRampStop,
} from "@/engine/color-ramp";

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
// costs nothing per eval. transmission / clearcoat / sheen / thickness
// upgrade the resolved material to MeshPhysicalMaterial. A wired bump
// map writes `MaterialDesc.bump`; an unwired socket preserves an
// upstream Bump node's channel so the two still chain in either order.
// Image maps (including an Ambient Occlusion bake) win over the
// matching scalar/color.

export const material3DNode: NodeDefinition = {
  type: "material-3d",
  name: "Material",
  category: "3d",
  description:
    "Material for 3D geometry — PBR (base color, roughness, metalness, transmission/glass, emissive, AO, clearcoat, sheen, alpha, bump/normal map), Toon (bands authored as a color ramp — multi-stop, tinted, hard or blended), or Matcap (view-space clay/studio look; wire an image into base color map to use it as the matcap). Lineart toggle adds outlines: fast silhouette hull or quality silhouette + crease lines. Flows through: wire geometry in, the styled geometry out. Image maps (AO bake, noise, photos) plug into any *_map socket.",
  searchAliases: ["pbr", "shader", "principled"],
  facts: {
    space: { "param:thickness": "world3d", "param:lineart_thickness": "world3d" },
    gotchas: [
      "Wired image maps override their matching scalar/color param outright; an unwired bump_map instead preserves an upstream Bump node's channel so the two still chain in either order.",
      "shading=toon or matcap forces transmission/clearcoat/sheen to 0 regardless of their param values, so the resolved material class stays unambiguous.",
      "Only material slot 0 is replaced; any other slots (multi-material imports) pass through untouched.",
      "Application is positional: split the geometry stream after Material for the same look on both branches, before it for a different material per branch.",
      "thickness (transmission volume) and lineart_thickness are both object-space offsets, so mesh scale scales them along with the geometry.",
      "lineart is extra retained draw calls at the object3d boundary, not a material property; the quality technique's crease lines only work on real meshes, instanced streams draw the silhouette hull only.",
    ],
  },
  backend: "webgl2",
  noMaskInput: true,
  inputs: [
    { name: "geometry", type: "geometry", required: true },
    { name: "base_color_map", type: "image", required: false, label: "base color map" },
    { name: "roughness_map", type: "image", required: false, label: "roughness map" },
    { name: "metalness_map", type: "image", required: false, label: "metalness map" },
    { name: "emissive_map", type: "image", required: false, label: "emissive map" },
    { name: "ao_map", type: "image", required: false, label: "AO map" },
    { name: "alpha_map", type: "image", required: false, label: "alpha map" },
    { name: "bump_map", type: "image", required: false, label: "bump map" },
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
    {
      name: "thickness",
      label: "Thickness",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 2,
      step: 0.01,
      default: 0,
      visibleIf: (p) =>
        (p.shading ?? "standard") === "standard" &&
        ((p.transmission as number) ?? 0) > 0,
    },
    {
      name: "attenuation_color",
      label: "Attenuation",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) =>
        (p.shading ?? "standard") === "standard" &&
        ((p.transmission as number) ?? 0) > 0 &&
        ((p.thickness as number) ?? 0) > 0,
    },
    {
      name: "emissive",
      label: "Emissive",
      type: "color",
      default: "#000000",
      visibleIf: (p) => (p.shading ?? "standard") !== "matcap",
    },
    {
      name: "emissive_intensity",
      label: "Emissive intensity",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p, meta) =>
        (p.shading ?? "standard") !== "matcap" &&
        (!!meta?.wired?.emissive_map ||
          (typeof p.emissive === "string" &&
            p.emissive.replace("#", "").replace(/0/g, "") !== "")),
    },
    {
      name: "ao_intensity",
      label: "AO intensity",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p, meta) =>
        (p.shading ?? "standard") !== "matcap" && !!meta?.wired?.ao_map,
    },
    {
      name: "clearcoat",
      label: "Clearcoat",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => (p.shading ?? "standard") === "standard",
    },
    {
      name: "clearcoat_roughness",
      label: "Coat roughness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) =>
        (p.shading ?? "standard") === "standard" &&
        ((p.clearcoat as number) ?? 0) > 0,
    },
    {
      name: "sheen",
      label: "Sheen",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
      visibleIf: (p) => (p.shading ?? "standard") === "standard",
    },
    {
      name: "sheen_color",
      label: "Sheen color",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) =>
        (p.shading ?? "standard") === "standard" &&
        ((p.sheen as number) ?? 0) > 0,
    },
    {
      name: "sheen_roughness",
      label: "Sheen roughness",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
      visibleIf: (p) =>
        (p.shading ?? "standard") === "standard" &&
        ((p.sheen as number) ?? 0) > 0,
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
    rampInterpParam({
      name: "toon_interp",
      label: "Band interpolation",
      default: "constant",
      visibleIf: (p) => p.shading === "toon",
    }),
    rampSpaceParam({
      name: "toon_space",
      label: "Band color space",
      visibleIf: (p) => p.shading === "toon",
    }),
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "bump_mode",
      label: "Bump",
      type: "enum",
      options: ["bump", "normal"],
      default: "bump",
      control: "segmented",
      visibleIf: (p, meta) => !!meta?.wired?.bump_map,
    },
    {
      name: "bump_strength",
      label: "Bump strength",
      type: "scalar",
      min: -3,
      max: 3,
      softMax: 2,
      step: 0.01,
      default: 1,
      visibleIf: (p, meta) => !!meta?.wired?.bump_map,
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
    const bumpMap = img("bump_map");
    const aoMap = img("ao_map");
    const emissiveMap = img("emissive_map");
    const shading = ((params.shading as string) ?? "standard") as
      | "standard"
      | "toon"
      | "matcap";
    const isPbr = shading === "standard";

    const desc = makeMaterialDesc({
      baseColor: img("base_color_map") ?? ((params.base_color as string) ?? "#cccccc"),
      roughness: img("roughness_map") ?? ((params.roughness as number) ?? 0.5),
      metalness: img("metalness_map") ?? ((params.metalness as number) ?? 0),
      // Toon/matcap have no transmission/coat/sheen path — force 0 so
      // the class choice (materialClassFor) is unambiguous.
      transmission: isPbr ? ((params.transmission as number) ?? 0) : 0,
      ior: (params.ior as number) ?? 1.5,
      thickness: isPbr ? ((params.thickness as number) ?? 0) : 0,
      attenuationColor: (params.attenuation_color as string) ?? "#ffffff",
      alpha: img("alpha_map") ?? ((params.alpha as number) ?? 1),
      emissive:
        shading === "matcap"
          ? undefined
          : (emissiveMap ?? ((params.emissive as string) ?? "#000000")),
      emissiveIntensity: (params.emissive_intensity as number) ?? 1,
      ao:
        shading === "matcap" || !aoMap
          ? undefined
          : {
              map: aoMap,
              intensity: (params.ao_intensity as number) ?? 1,
            },
      clearcoat: isPbr ? ((params.clearcoat as number) ?? 0) : 0,
      clearcoatRoughness: (params.clearcoat_roughness as number) ?? 0,
      sheen: isPbr ? ((params.sheen as number) ?? 0) : 0,
      sheenColor: (params.sheen_color as string) ?? "#ffffff",
      sheenRoughness: (params.sheen_roughness as number) ?? 1,
      shading,
      toonRamp:
        shading === "toon"
          ? {
              stops: Array.isArray(params.toon_ramp)
                ? (params.toon_ramp as ColorRampStop[])
                : [],
              interp: normalizeRampInterp(params.toon_interp ?? "constant"),
              space: normalizeRampSpace(params.toon_space),
            }
          : undefined,
      // Wired bump map wins; otherwise keep an upstream Bump node's
      // channel so Material after Bump still perturbs the surface.
      bump: bumpMap
        ? {
            map: bumpMap,
            strength: (params.bump_strength as number) ?? 1,
            mode:
              ((params.bump_mode as string) ?? "bump") === "normal"
                ? "normal"
                : "bump",
          }
        : src.materials[0]?.bump,
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
