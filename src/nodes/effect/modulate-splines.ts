import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "@/engine/types";

// Per-subpath modulation. Treats each subpath as a discrete "instance"
// and scales / rotates it around its own centroid. Field samples are
// taken at the centroid; uniform inputs apply equally to every
// subpath. Modulation is destructive — the geometry comes out the
// other side actually transformed (unlike Modulate Points, which only
// tags points with metadata that consumers later bake in).
//
// Use case: drop after a Copy to Points (spline mode) to get the
// "Transform Instances" pattern — each copy lives in its own subpath
// and gets modulated per-instance via a field image.

interface SamplerState {
  scaleCanvas?: HTMLCanvasElement;
  rotCanvas?: HTMLCanvasElement;
}

function ensureState(ctx: RenderContext, nodeId: string): SamplerState {
  const key = `modulate-splines:${nodeId}`;
  let s = ctx.state[key] as SamplerState | undefined;
  if (!s) {
    s = {};
    ctx.state[key] = s;
  }
  return s;
}

function buildLumaSampler(
  ctx: RenderContext,
  canvas: HTMLCanvasElement,
  img: ImageValue
): ((u: number, v: number) => number) | null {
  if (img.width <= 0 || img.height <= 0) return null;
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  try {
    ctx.blitToCanvas(img, canvas);
  } catch {
    return null;
  }
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) return null;
  const data = c2d.getImageData(0, 0, canvas.width, canvas.height).data;
  const w = canvas.width;
  const h = canvas.height;
  return (u: number, v: number): number => {
    // Subpath centroid UVs are Y-DOWN. Sample directly without flipping.
    const px = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
    const py = Math.max(0, Math.min(h - 1, Math.floor(v * h)));
    const i = (py * w + px) * 4;
    return (
      (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
    );
  };
}

// Geometric centroid (mean of anchor positions). Empty subpaths get
// (0.5, 0.5) as a harmless fallback; nothing will be drawn anyway.
function subpathCentroid(sub: SplineSubpath): [number, number] {
  const a = sub.anchors;
  if (a.length === 0) return [0.5, 0.5];
  let cx = 0;
  let cy = 0;
  for (const an of a) {
    cx += an.pos[0];
    cy += an.pos[1];
  }
  return [cx / a.length, cy / a.length];
}

function transformSubpathAroundCentroid(
  sub: SplineSubpath,
  scale: number,
  rotation: number
): SplineSubpath {
  if (scale === 1 && rotation === 0) return sub;
  const [cx, cy] = subpathCentroid(sub);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const txPt = (p: [number, number]): [number, number] => {
    const dx = (p[0] - cx) * scale;
    const dy = (p[1] - cy) * scale;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const txOff = (h: [number, number]): [number, number] => {
    const dx = h[0] * scale;
    const dy = h[1] * scale;
    return [dx * cos - dy * sin, dx * sin + dy * cos];
  };
  const anchors: SplineAnchor[] = sub.anchors.map((an) => ({
    pos: txPt(an.pos),
    inHandle: an.inHandle ? txOff(an.inHandle) : undefined,
    outHandle: an.outHandle ? txOff(an.outHandle) : undefined,
  }));
  return { ...sub, anchors };
}

export const modulateSplinesNode: NodeDefinition = {
  type: "modulate-splines",
  name: "Modulate Splines",
  category: "spline",
  subcategory: "modifier",
  description:
    "Per-subpath scale and rotation around each subpath's centroid. Uniform inputs apply to every subpath; image fields are sampled at the centroid UV. Drop after Copy to Points (spline mode) for per-instance Transform — each copy is its own subpath. Stack to layer modulations.",
  backend: "webgl2",
  inputs: [
    { name: "splines", type: "spline", required: true },
    {
      name: "scale_mul",
      type: "scalar",
      required: false,
      label: "Scale × (uniform)",
    },
    {
      name: "rotate_add",
      type: "scalar",
      required: false,
      label: "Rotate + (uniform)",
    },
    {
      name: "scale_field",
      type: "image",
      required: false,
      label: "Scale field",
    },
    {
      name: "rotate_field",
      type: "image",
      required: false,
      label: "Rotate field",
    },
  ],
  resolveInputs(): InputSocketDef[] {
    return [
      { name: "splines", type: "spline", required: true },
      {
        name: "scale_mul",
        type: "scalar",
        required: false,
        label: "Scale × (uniform)",
      },
      {
        name: "rotate_add",
        type: "scalar",
        required: false,
        label: "Rotate + (uniform)",
      },
      {
        name: "scale_field",
        type: "image",
        required: false,
        label: "Scale field",
      },
      {
        name: "rotate_field",
        type: "image",
        required: false,
        label: "Rotate field",
      },
    ];
  },
  params: [
    {
      name: "scale_mul_default",
      label: "Scale × default",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
    {
      name: "rotate_add_default",
      label: "Rotate + default (rad)",
      type: "scalar",
      min: -Math.PI,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    {
      name: "scale_field_lo",
      label: "Scale field — black",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "scale_field_hi",
      label: "Scale field — white",
      type: "scalar",
      min: 0,
      max: 4,
      softMax: 2,
      step: 0.001,
      default: 1.5,
    },
    {
      name: "rotate_field_amount",
      label: "Rotate field amount (rad)",
      type: "scalar",
      min: 0,
      max: Math.PI,
      softMax: Math.PI,
      step: 0.001,
      default: Math.PI,
    },
  ],
  primaryOutput: "spline",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const src = inputs.splines;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }

    const uniformScale =
      inputs.scale_mul?.kind === "scalar"
        ? inputs.scale_mul.value
        : ((params.scale_mul_default as number) ?? 1);
    const uniformRot =
      inputs.rotate_add?.kind === "scalar"
        ? inputs.rotate_add.value
        : ((params.rotate_add_default as number) ?? 0);

    const scaleLo = (params.scale_field_lo as number) ?? 0.5;
    const scaleHi = (params.scale_field_hi as number) ?? 1.5;
    const rotAmount = (params.rotate_field_amount as number) ?? Math.PI;

    const state = ensureState(ctx, nodeId);
    let scaleSampler: ((u: number, v: number) => number) | null = null;
    if (inputs.scale_field?.kind === "image") {
      const c =
        state.scaleCanvas ?? document.createElement("canvas");
      state.scaleCanvas = c;
      scaleSampler = buildLumaSampler(ctx, c, inputs.scale_field);
    }
    let rotSampler: ((u: number, v: number) => number) | null = null;
    if (inputs.rotate_field?.kind === "image") {
      const c =
        state.rotCanvas ?? document.createElement("canvas");
      state.rotCanvas = c;
      rotSampler = buildLumaSampler(ctx, c, inputs.rotate_field);
    }

    const outSubpaths: SplineSubpath[] = src.subpaths.map((sub) => {
      const [cx, cy] = subpathCentroid(sub);
      let scaleFactor = uniformScale;
      if (scaleSampler) {
        const luma = scaleSampler(cx, cy);
        scaleFactor *= scaleLo + (scaleHi - scaleLo) * luma;
      }
      let rotAdd = uniformRot;
      if (rotSampler) {
        const luma = rotSampler(cx, cy);
        rotAdd += luma * rotAmount;
      }
      return transformSubpathAroundCentroid(sub, scaleFactor, rotAdd);
    });

    return {
      primary: { kind: "spline", subpaths: outSubpaths } satisfies SplineValue,
    };
  },
};
