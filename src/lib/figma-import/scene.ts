// The "Figma scene" contract: what the Figma plugin (figma-plugin/) writes to
// the clipboard and what toolbox's paste importer reads
// (specdocs/092326_figma-import.md).
//
// The plugin stays a thin EXTRACTOR — it copies Figma's own data (layer tree,
// node-local geometry, paints, text runs, image bytes) with as little
// interpretation as possible. Every mapping decision lives on the toolbox
// side (convert.ts), so improving an import never needs a plugin update.
//
// This file must stay dependency-free: the plugin's build imports these
// types straight from here. `parseFigmaScene` is the trust boundary — the
// clipboard is untrusted input, so it rebuilds a sanitized copy (finite
// numbers, bounded strings / arrays / depth, image payloads that are real
// base64 of an allowed MIME) and never hands the raw object onward.

export const FIGMA_SCENE_MARKER = "__toolbox_figma_scene__";
export const FIGMA_SCENE_VERSION = 1;

// Figma's 2×3 affine: x' = m00·x + m01·y + m02, y' = m10·x + m11·y + m12.
export type FigmaTransform = [
  [number, number, number],
  [number, number, number],
];

export interface FigmaRGB {
  r: number;
  g: number;
  b: number;
}
export interface FigmaRGBA extends FigmaRGB {
  a: number;
}

// Figma VectorPath: absolute M / L / C / Z (Q accepted), node-local px.
export interface FigmaVectorPath {
  windingRule: "NONZERO" | "EVENODD" | "NONE";
  data: string;
}

export interface FigmaColorStop {
  position: number;
  color: FigmaRGBA;
}

interface FigmaPaintBase {
  visible: boolean;
  opacity: number;
  blendMode: string;
}
export interface FigmaSolidPaint extends FigmaPaintBase {
  type: "SOLID";
  color: FigmaRGB;
}
export type FigmaGradientType =
  | "GRADIENT_LINEAR"
  | "GRADIENT_RADIAL"
  | "GRADIENT_ANGULAR"
  | "GRADIENT_DIAMOND";
export interface FigmaGradientPaint extends FigmaPaintBase {
  type: FigmaGradientType;
  // Maps normalized node space (the w×h box as [0,1]²) into gradient space,
  // where a linear gradient runs (0, 0.5) → (1, 0.5).
  gradientTransform: FigmaTransform;
  gradientStops: FigmaColorStop[];
}
export interface FigmaImagePaint extends FigmaPaintBase {
  type: "IMAGE";
  imageHash: string | null; // key into FigmaScene.images
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  imageTransform?: FigmaTransform; // CROP only
  scalingFactor?: number; // TILE only
  rotation?: number; // multiples of 90 (FILL / FIT / TILE)
  filters?: Record<string, number>;
}
// VIDEO / PATTERN / SHADER … — carried so the importer can say what it
// skipped instead of silently dropping it.
export interface FigmaUnsupportedPaint extends FigmaPaintBase {
  type: "UNSUPPORTED";
  figmaType: string;
}
export type FigmaPaint =
  | FigmaSolidPaint
  | FigmaGradientPaint
  | FigmaImagePaint
  | FigmaUnsupportedPaint;

export interface FigmaStroke {
  paints: FigmaPaint[];
  // Uniform weight in px. Per-side weights (rectangles / frames) arrive in
  // `sideWeights` when they differ; `weight` is then their maximum.
  weight: number;
  sideWeights?: [number, number, number, number]; // top, right, bottom, left
  align: "CENTER" | "INSIDE" | "OUTSIDE";
  cap: string; // NONE | ROUND | SQUARE | ARROW_* | … | MIXED
  join: string; // MITER | BEVEL | ROUND | MIXED
  miterLimit: number;
  dashPattern: number[];
}

export interface FigmaEffect {
  type: string; // DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | …
  visible: boolean;
  radius: number;
  color?: FigmaRGBA;
  offset?: { x: number; y: number };
  spread?: number;
  blendMode?: string;
}

// ---- text ----------------------------------------------------------------

export type FigmaLineHeight =
  | { unit: "PIXELS" | "PERCENT"; value: number }
  | { unit: "AUTO" };

// One getStyledTextSegments run. Indices are UTF-16, like JS strings.
export interface FigmaTextSegment {
  start: number;
  end: number;
  characters: string;
  fontFamily: string;
  fontStyle: string; // Figma's style name: "Regular", "Semi Bold Italic", …
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  textCase: string; // ORIGINAL | UPPER | LOWER | TITLE | SMALL_CAPS | …
  textDecoration: string; // NONE | UNDERLINE | STRIKETHROUGH
  letterSpacing: { unit: "PIXELS" | "PERCENT"; value: number };
  lineHeight: FigmaLineHeight;
  paragraphSpacing: number;
  paragraphIndent: number;
  fills: FigmaPaint[];
}

export interface FigmaTextInfo {
  characters: string;
  segments: FigmaTextSegment[];
  alignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  alignVertical: "TOP" | "CENTER" | "BOTTOM";
  autoResize: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
  truncation: "DISABLED" | "ENDING";
  maxLines: number | null;
  leadingTrim: "NONE" | "CAP_HEIGHT" | "MIXED";
  hasMissingFont: boolean;
  // Figma's own SVG export of the node with live text (svgOutlineText off):
  // one <tspan x y> per laid-out line run, y = baseline. The only source of
  // Figma's real line breaks and baselines — the Plugin API has no layout
  // info. Parsed on the toolbox side.
  svg?: string;
}

// ---- nodes ---------------------------------------------------------------

// What a rectangle / frame / ellipse IS, beyond its baked geometry — lets
// the importer use toolbox's Rectangle / Circle primitives when they can
// reproduce it exactly. Absent on older exports (the importer reads the
// geometry instead).
export type FigmaPrimitiveHint =
  | { kind: "rect"; radii: [number, number, number, number]; smoothing: number } // tl, tr, br, bl
  | { kind: "ellipse"; full: boolean }; // full = no arc sweep, no inner radius

interface FigmaNodeBase {
  primitive?: FigmaPrimitiveHint;
  id: string;
  name: string;
  figmaType: string; // RECTANGLE | FRAME | TEXT | …
  opacity: number;
  blendMode: string; // PASS_THROUGH | NORMAL | MULTIPLY | …
  // Node-local px → the ROOT frame's px (not the parent's): the plugin
  // composes inv(root.absoluteTransform) · node.absoluteTransform, which
  // stays right through groups (Figma's relativeTransform skips them).
  transform: FigmaTransform;
  width: number;
  height: number;
  isMask: boolean;
  maskType: "ALPHA" | "VECTOR" | "LUMINANCE";
  effects: FigmaEffect[];
  // Axis-aligned rendered bounds (effects + strokes included) in root-frame
  // px, when Figma reports them. Text: the tight glyph-ink box.
  renderBounds?: FigmaRect;
}

export interface FigmaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// RECTANGLE / ELLIPSE / POLYGON / STAR / LINE / VECTOR / BOOLEAN_OPERATION.
export interface FigmaShapeNode extends FigmaNodeBase {
  kind: "shape";
  fills: FigmaPaint[];
  fillGeometry: FigmaVectorPath[]; // corner radii / booleans baked in
  stroke?: FigmaStroke;
  // The centerline Figma strokes, when it isn't the fill outline: a VECTOR's
  // vectorPaths (open paths have no fill geometry) or a LINE's segment.
  strokePaths?: FigmaVectorPath[];
}

// GROUP / FRAME / COMPONENT / INSTANCE / SECTION. Groups carry no paints.
export interface FigmaContainerNode extends FigmaNodeBase {
  kind: "container";
  clipsContent: boolean;
  fills: FigmaPaint[];
  fillGeometry: FigmaVectorPath[]; // the frame's own background shape
  stroke?: FigmaStroke;
  children: FigmaSceneNode[]; // index 0 = bottom-most
}

export interface FigmaTextNode extends FigmaNodeBase {
  kind: "text";
  text: FigmaTextInfo;
  fills: FigmaPaint[];
  // Laid-out glyph outlines (node-local) — the exact visual, used when live
  // text can't reproduce the layer.
  fillGeometry: FigmaVectorPath[];
  stroke?: FigmaStroke;
}

// A node the plugin pre-rendered (a type toolbox can't rebuild yet). The PNG
// lives in `images` under `imageRef` and covers `bounds` (root-frame px).
export interface FigmaRasterNode extends FigmaNodeBase {
  kind: "raster";
  imageRef: string;
  bounds: FigmaRect;
  reason: string;
}

export type FigmaSceneNode =
  | FigmaShapeNode
  | FigmaContainerNode
  | FigmaTextNode
  | FigmaRasterNode;

export interface FigmaSceneImage {
  mime: string; // image/png | image/jpeg | image/gif | image/webp
  width: number;
  height: number;
  base64: string;
}

export interface FigmaScene {
  [FIGMA_SCENE_MARKER]: number; // format version
  generator: { name: string; version: string };
  source: {
    fileName: string;
    pageName: string;
    nodeId: string;
    nodeName: string;
  };
  colorProfile: "LEGACY" | "SRGB" | "DISPLAY_P3";
  // The selected frame itself (transform = identity, width × height = the
  // canvas). Its fills are the background; its children are the layers.
  frame: FigmaContainerNode;
  images: Record<string, FigmaSceneImage>; // by Figma imageHash / imageRef
  // The frame rendered by Figma (exportAsync PNG) — the import's parity
  // reference. Optional: it roughly doubles the payload.
  reference?: FigmaSceneImage & { scale: number };
  warnings: string[];
}

// ---- clipboard detection + parsing (toolbox side) ------------------------

// Cheap sync gate for the paste listener — runs before any JSON.parse.
export function looksLikeFigmaSceneText(text: string): boolean {
  // The marker is written first, so it sits near the front of the payload.
  return text.slice(0, 256).includes(FIGMA_SCENE_MARKER);
}

export class FigmaSceneError extends Error {}

const LIMITS = {
  nodes: 20_000,
  depth: 64,
  pathChars: 4_000_000, // total path-data characters across the scene
  paints: 32,
  stops: 64,
  segments: 2_000,
  text: 100_000,
  name: 512,
  svg: 2_000_000,
  images: 512,
  imageBase64: 64 * 1024 * 1024, // per image
  warnings: 500,
  dash: 16,
  effects: 16,
  dimension: 100_000,
} as const;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  !!v && typeof v === "object" && !Array.isArray(v);

function num(v: unknown, fallback: number, min = -1e9, max = 1e9): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
function str(v: unknown, max: number, fallback = ""): string {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === "string" && (options as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}
function arr(v: unknown, max: number): unknown[] {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

const IDENTITY: FigmaTransform = [
  [1, 0, 0],
  [0, 1, 0],
];

function transformOf(v: unknown): FigmaTransform {
  if (!Array.isArray(v) || v.length !== 2) return IDENTITY;
  const rows = v.map((r) =>
    Array.isArray(r) && r.length === 3 ? r.map((x) => num(x, NaN)) : null
  );
  if (rows.some((r) => !r || r.some((x) => Number.isNaN(x)))) return IDENTITY;
  return rows as FigmaTransform;
}

function rgb(v: unknown): FigmaRGB {
  const o = isRec(v) ? v : {};
  return { r: num(o.r, 0, 0, 1), g: num(o.g, 0, 0, 1), b: num(o.b, 0, 0, 1) };
}
function rgba(v: unknown): FigmaRGBA {
  const o = isRec(v) ? v : {};
  return { ...rgb(o), a: num(o.a, 1, 0, 1) };
}

interface Budget {
  nodes: number;
  pathChars: number;
}

function vectorPaths(v: unknown, budget: Budget): FigmaVectorPath[] {
  const out: FigmaVectorPath[] = [];
  for (const p of arr(v, 1024)) {
    if (!isRec(p) || typeof p.data !== "string") continue;
    if (p.data.length > budget.pathChars) {
      budget.pathChars = -1; // exhausted — parseFigmaScene reports it
      break;
    }
    budget.pathChars -= p.data.length;
    // Figma path data is plain commands + numbers; anything else is refused
    // rather than handed to the path parser.
    if (!/^[MLCQZmlcqz0-9eE+\-.,\s]*$/.test(p.data)) continue;
    out.push({
      windingRule: oneOf(p.windingRule, ["NONZERO", "EVENODD", "NONE"] as const, "NONZERO"),
      data: p.data,
    });
  }
  return out;
}

function paint(v: unknown): FigmaPaint | null {
  if (!isRec(v)) return null;
  const base = {
    visible: v.visible !== false,
    opacity: num(v.opacity, 1, 0, 1),
    blendMode: str(v.blendMode, 32, "NORMAL"),
  };
  const type = str(v.type, 32);
  if (type === "SOLID") return { ...base, type, color: rgb(v.color) };
  if (
    type === "GRADIENT_LINEAR" ||
    type === "GRADIENT_RADIAL" ||
    type === "GRADIENT_ANGULAR" ||
    type === "GRADIENT_DIAMOND"
  ) {
    const stops = arr(v.gradientStops, LIMITS.stops)
      .filter(isRec)
      .map((s) => ({ position: num(s.position, 0, 0, 1), color: rgba(s.color) }));
    return { ...base, type, gradientTransform: transformOf(v.gradientTransform), gradientStops: stops };
  }
  if (type === "IMAGE") {
    const filters: Record<string, number> = {};
    if (isRec(v.filters)) {
      for (const [k, x] of Object.entries(v.filters).slice(0, 16)) {
        if (typeof x === "number" && Number.isFinite(x)) filters[k.slice(0, 32)] = num(x, 0, -1, 1);
      }
    }
    return {
      ...base,
      type,
      imageHash: typeof v.imageHash === "string" ? v.imageHash.slice(0, 128) : null,
      scaleMode: oneOf(v.scaleMode, ["FILL", "FIT", "CROP", "TILE"] as const, "FILL"),
      imageTransform: v.imageTransform ? transformOf(v.imageTransform) : undefined,
      scalingFactor: v.scalingFactor === undefined ? undefined : num(v.scalingFactor, 1, 1e-4, 1e4),
      rotation: v.rotation === undefined ? undefined : num(v.rotation, 0, -3600, 3600),
      filters: Object.keys(filters).length ? filters : undefined,
    };
  }
  // The plugin sends Figma's unreadable paints as UNSUPPORTED + figmaType;
  // an unknown type straight from Figma keeps its own name.
  const figmaType = type === "UNSUPPORTED" || !type ? str(v.figmaType, 32, "UNKNOWN") : type;
  return { ...base, type: "UNSUPPORTED", figmaType };
}

function paints(v: unknown): FigmaPaint[] {
  return arr(v, LIMITS.paints)
    .map(paint)
    .filter((p): p is FigmaPaint => !!p);
}

function stroke(v: unknown): FigmaStroke | undefined {
  if (!isRec(v)) return undefined;
  const sides = Array.isArray(v.sideWeights) && v.sideWeights.length === 4
    ? (v.sideWeights.map((x) => num(x, 0, 0, LIMITS.dimension)) as [number, number, number, number])
    : undefined;
  return {
    paints: paints(v.paints),
    weight: num(v.weight, 0, 0, LIMITS.dimension),
    sideWeights: sides,
    align: oneOf(v.align, ["CENTER", "INSIDE", "OUTSIDE"] as const, "CENTER"),
    cap: str(v.cap, 32, "NONE"),
    join: str(v.join, 32, "MITER"),
    miterLimit: num(v.miterLimit, 4, 0, 1000),
    dashPattern: arr(v.dashPattern, LIMITS.dash).map((x) => num(x, 0, 0, LIMITS.dimension)),
  };
}

function effects(v: unknown): FigmaEffect[] {
  return arr(v, LIMITS.effects)
    .filter(isRec)
    .map((e) => ({
      type: str(e.type, 32),
      visible: e.visible !== false,
      radius: num(e.radius, 0, 0, LIMITS.dimension),
      color: e.color ? rgba(e.color) : undefined,
      offset: isRec(e.offset)
        ? { x: num(e.offset.x, 0), y: num(e.offset.y, 0) }
        : undefined,
      spread: e.spread === undefined ? undefined : num(e.spread, 0),
      blendMode: e.blendMode === undefined ? undefined : str(e.blendMode, 32),
    }));
}

function rect(v: unknown): FigmaRect | undefined {
  if (!isRec(v)) return undefined;
  return {
    x: num(v.x, 0),
    y: num(v.y, 0),
    width: num(v.width, 0, 0, LIMITS.dimension),
    height: num(v.height, 0, 0, LIMITS.dimension),
  };
}

function primitiveHint(v: unknown): FigmaPrimitiveHint | undefined {
  if (!isRec(v)) return undefined;
  if (v.kind === "rect" && Array.isArray(v.radii) && v.radii.length === 4) {
    return {
      kind: "rect",
      radii: v.radii.map((r) => num(r, 0, 0, LIMITS.dimension)) as [number, number, number, number],
      smoothing: num(v.smoothing, 0, 0, 1),
    };
  }
  if (v.kind === "ellipse") return { kind: "ellipse", full: v.full === true };
  return undefined;
}

function lineHeight(v: unknown): FigmaLineHeight {
  if (isRec(v) && (v.unit === "PIXELS" || v.unit === "PERCENT")) {
    return { unit: v.unit, value: num(v.value, 0, 0, LIMITS.dimension) };
  }
  return { unit: "AUTO" };
}

function textInfo(v: unknown): FigmaTextInfo {
  const o = isRec(v) ? v : {};
  const segments = arr(o.segments, LIMITS.segments)
    .filter(isRec)
    .map((s) => ({
      start: Math.round(num(s.start, 0, 0, LIMITS.text)),
      end: Math.round(num(s.end, 0, 0, LIMITS.text)),
      characters: str(s.characters, LIMITS.text),
      fontFamily: str(s.fontFamily, 256),
      fontStyle: str(s.fontStyle, 128, "Regular"),
      fontSize: num(s.fontSize, 12, 0.1, 10_000),
      fontWeight: num(s.fontWeight, 400, 1, 1000),
      italic: s.italic === true,
      textCase: str(s.textCase, 32, "ORIGINAL"),
      textDecoration: str(s.textDecoration, 32, "NONE"),
      letterSpacing: {
        unit: oneOf(
          isRec(s.letterSpacing) ? s.letterSpacing.unit : undefined,
          ["PIXELS", "PERCENT"] as const,
          "PIXELS"
        ),
        value: num(isRec(s.letterSpacing) ? s.letterSpacing.value : 0, 0, -10_000, 10_000),
      },
      lineHeight: lineHeight(s.lineHeight),
      paragraphSpacing: num(s.paragraphSpacing, 0, -LIMITS.dimension, LIMITS.dimension),
      paragraphIndent: num(s.paragraphIndent, 0, -LIMITS.dimension, LIMITS.dimension),
      fills: paints(s.fills),
    }));
  const svg = typeof o.svg === "string" && o.svg.length <= LIMITS.svg ? o.svg : undefined;
  return {
    characters: str(o.characters, LIMITS.text),
    segments,
    alignHorizontal: oneOf(o.alignHorizontal, ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"] as const, "LEFT"),
    alignVertical: oneOf(o.alignVertical, ["TOP", "CENTER", "BOTTOM"] as const, "TOP"),
    autoResize: oneOf(o.autoResize, ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"] as const, "NONE"),
    truncation: oneOf(o.truncation, ["DISABLED", "ENDING"] as const, "DISABLED"),
    maxLines: o.maxLines == null ? null : Math.round(num(o.maxLines, 0, 0, 100_000)),
    leadingTrim: oneOf(o.leadingTrim, ["NONE", "CAP_HEIGHT", "MIXED"] as const, "NONE"),
    hasMissingFont: o.hasMissingFont === true,
    svg,
  };
}

function node(v: unknown, depth: number, budget: Budget): FigmaSceneNode | null {
  if (!isRec(v) || depth > LIMITS.depth || budget.nodes <= 0) return null;
  budget.nodes--;
  const base = {
    id: str(v.id, 128),
    name: str(v.name, LIMITS.name),
    figmaType: str(v.figmaType, 32),
    opacity: num(v.opacity, 1, 0, 1),
    blendMode: str(v.blendMode, 32, "PASS_THROUGH"),
    transform: transformOf(v.transform),
    width: num(v.width, 0, 0, LIMITS.dimension),
    height: num(v.height, 0, 0, LIMITS.dimension),
    isMask: v.isMask === true,
    maskType: oneOf(v.maskType, ["ALPHA", "VECTOR", "LUMINANCE"] as const, "ALPHA"),
    effects: effects(v.effects),
    renderBounds: rect(v.renderBounds),
    primitive: primitiveHint(v.primitive),
  };
  switch (v.kind) {
    case "shape": {
      const strokePaths = v.strokePaths === undefined ? undefined : vectorPaths(v.strokePaths, budget);
      return {
        ...base,
        kind: "shape",
        fills: paints(v.fills),
        fillGeometry: vectorPaths(v.fillGeometry, budget),
        stroke: stroke(v.stroke),
        strokePaths,
      };
    }
    case "container": {
      const children: FigmaSceneNode[] = [];
      for (const c of arr(v.children, LIMITS.nodes)) {
        const n = node(c, depth + 1, budget);
        if (n) children.push(n);
      }
      return {
        ...base,
        kind: "container",
        clipsContent: v.clipsContent === true,
        fills: paints(v.fills),
        fillGeometry: vectorPaths(v.fillGeometry, budget),
        stroke: stroke(v.stroke),
        children,
      };
    }
    case "text":
      return {
        ...base,
        kind: "text",
        text: textInfo(v.text),
        fills: paints(v.fills),
        fillGeometry: vectorPaths(v.fillGeometry, budget),
        stroke: stroke(v.stroke),
      };
    case "raster": {
      const bounds = rect(v.bounds);
      if (!bounds || typeof v.imageRef !== "string") return null;
      return {
        ...base,
        kind: "raster",
        imageRef: v.imageRef.slice(0, 128),
        bounds,
        reason: str(v.reason, 256),
      };
    }
    default:
      return null;
  }
}

function image(v: unknown): FigmaSceneImage | null {
  if (!isRec(v)) return null;
  const mime = str(v.mime, 64);
  const b64 = v.base64;
  if (!IMAGE_MIMES.has(mime) || typeof b64 !== "string") return null;
  if (b64.length === 0 || b64.length > LIMITS.imageBase64) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  return {
    mime,
    width: Math.round(num(v.width, 0, 0, LIMITS.dimension)),
    height: Math.round(num(v.height, 0, 0, LIMITS.dimension)),
    base64: b64,
  };
}

// Parse + sanitize clipboard text. Throws FigmaSceneError (message is safe to
// show) for anything that isn't a readable scene of a supported version.
export function parseFigmaScene(text: string): FigmaScene {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FigmaSceneError("The pasted Figma scene isn't valid JSON (was the copy cut short?)");
  }
  if (!isRec(raw) || typeof raw[FIGMA_SCENE_MARKER] !== "number") {
    throw new FigmaSceneError("Not a Figma scene from the toolbox plugin");
  }
  const version = raw[FIGMA_SCENE_MARKER] as number;
  if (version > FIGMA_SCENE_VERSION) {
    throw new FigmaSceneError(
      `This Figma scene uses format v${version}; this build of toolbox reads up to v${FIGMA_SCENE_VERSION}. Update toolbox.`
    );
  }
  const budget: Budget = { nodes: LIMITS.nodes, pathChars: LIMITS.pathChars };
  const frame = node(raw.frame, 0, budget);
  if (!frame || frame.kind !== "container") {
    throw new FigmaSceneError("The Figma scene has no frame");
  }
  if (frame.width < 1 || frame.height < 1) {
    throw new FigmaSceneError("The Figma frame has no size");
  }
  // The root frame IS the canvas — pin its placement.
  frame.transform = IDENTITY;

  const images: Record<string, FigmaSceneImage> = {};
  if (isRec(raw.images)) {
    for (const [hash, v] of Object.entries(raw.images).slice(0, LIMITS.images)) {
      const img = image(v);
      if (img) images[hash.slice(0, 128)] = img;
    }
  }
  const ref = isRec(raw.reference) ? image(raw.reference) : null;
  const src = isRec(raw.source) ? raw.source : {};
  const gen = isRec(raw.generator) ? raw.generator : {};
  const warnings = arr(raw.warnings, LIMITS.warnings)
    .filter((w): w is string => typeof w === "string")
    .map((w) => w.slice(0, 500));
  if (budget.nodes <= 0) warnings.push(`Scene truncated at ${LIMITS.nodes} layers.`);
  if (budget.pathChars < 0) warnings.push("Scene geometry truncated (too much path data).");

  return {
    [FIGMA_SCENE_MARKER]: version,
    generator: { name: str(gen.name, 128), version: str(gen.version, 32) },
    source: {
      fileName: str(src.fileName, LIMITS.name),
      pageName: str(src.pageName, LIMITS.name),
      nodeId: str(src.nodeId, 128),
      nodeName: str(src.nodeName, LIMITS.name),
    },
    colorProfile: oneOf(raw.colorProfile, ["LEGACY", "SRGB", "DISPLAY_P3"] as const, "LEGACY"),
    frame,
    images,
    reference: ref
      ? { ...ref, scale: num(isRec(raw.reference) ? raw.reference.scale : 1, 1, 0.01, 16) }
      : undefined,
    warnings,
  };
}
