// Figma frame → FigmaScene (src/lib/figma-import/scene.ts), main thread.
//
// A thin extractor on purpose: copy what Figma knows (tree, node-local
// geometry, paints, text runs, image bytes) and leave every mapping decision
// to toolbox's importer, so improving an import never needs a new plugin.
// Every per-node read is guarded — one odd layer becomes a warning, not a
// failed export.

import {
  FIGMA_SCENE_MARKER,
  FIGMA_SCENE_VERSION,
  type FigmaContainerNode,
  type FigmaEffect,
  type FigmaPaint,
  type FigmaPrimitiveHint,
  type FigmaRect,
  type FigmaRasterNode,
  type FigmaScene,
  type FigmaSceneImage,
  type FigmaSceneNode,
  type FigmaShapeNode,
  type FigmaStroke,
  type FigmaTextNode,
  type FigmaTextSegment,
  type FigmaTransform,
  type FigmaVectorPath,
} from "../../src/lib/figma-import/scene";

export type ExportableFrame = FrameNode | ComponentNode | InstanceNode;

export function isExportableFrame(n: BaseNode | undefined): n is ExportableFrame {
  return !!n && (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE");
}

export interface ExtractStats {
  layers: number;
  shapes: number;
  texts: number;
  images: number;
  rasters: number;
  hidden: number;
}

export interface ExtractOptions {
  reference: boolean;
  onProgress?: (done: number) => void;
}

// ---- matrices ----------------------------------------------------------------

type M = FigmaTransform;

function mul(p: Transform, q: Transform): M {
  return [
    [
      p[0][0] * q[0][0] + p[0][1] * q[1][0],
      p[0][0] * q[0][1] + p[0][1] * q[1][1],
      p[0][0] * q[0][2] + p[0][1] * q[1][2] + p[0][2],
    ],
    [
      p[1][0] * q[0][0] + p[1][1] * q[1][0],
      p[1][0] * q[0][1] + p[1][1] * q[1][1],
      p[1][0] * q[0][2] + p[1][1] * q[1][2] + p[1][2],
    ],
  ];
}

function inv(m: Transform): M {
  const [[a, c, e], [b, d, f]] = m;
  const k = a * d - b * c || 1;
  return [
    [d / k, -c / k, (c * f - d * e) / k],
    [-b / k, a / k, (b * e - a * f) / k],
  ];
}

function apply(m: Transform, x: number, y: number): [number, number] {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

// An absolute (page-space) rect → axis-aligned bounds in root-frame px.
function rectInRoot(r: Rect, rootInv: M): FigmaRect {
  const pts = [
    apply(rootInv, r.x, r.y),
    apply(rootInv, r.x + r.width, r.y),
    apply(rootInv, r.x + r.width, r.y + r.height),
    apply(rootInv, r.x, r.y + r.height),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// ---- base64 + mime -------------------------------------------------------------

function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// The first visible fill whose content a plugin can't read, as a word for
// notes ("video"), or null.
function unreadableFill(n: SceneNode): string | null {
  if (!("fills" in n) || n.fills === figma.mixed) return null;
  for (const p of n.fills) {
    if (p.visible === false) continue;
    if (p.type === "SOLID" || p.type === "IMAGE" || p.type.startsWith("GRADIENT_")) continue;
    return p.type.toLowerCase();
  }
  return null;
}

// A square-cornered rectangle with no effects and full opacity — its
// pixels have no transparency, so it can export as JPG.
function isPlainOpaqueRect(n: SceneNode): boolean {
  if (n.type !== "RECTANGLE") return false;
  if (n.cornerRadius !== 0 || n.opacity < 1) return false;
  return n.effects.every((e) => !e.visible);
}

// Corner radii / arc data — lets toolbox use its Rectangle / Circle
// primitives when they reproduce the shape exactly.
function primitiveHint(n: SceneNode): FigmaPrimitiveHint | undefined {
  if (n.type === "ELLIPSE") {
    const a = n.arcData;
    const sweep = Math.abs(a.endingAngle - a.startingAngle);
    return { kind: "ellipse", full: a.innerRadius === 0 && Math.abs(sweep - 2 * Math.PI) < 1e-4 };
  }
  if (
    (n.type === "RECTANGLE" || n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE") &&
    "topLeftRadius" in n
  ) {
    return {
      kind: "rect",
      radii: [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius],
      smoothing: "cornerSmoothing" in n ? n.cornerSmoothing : 0,
    };
  }
  return undefined;
}

// ---- the walk --------------------------------------------------------------------

class Extractor {
  readonly warnings = new Map<string, number>();
  readonly stats: ExtractStats = { layers: 0, shapes: 0, texts: 0, images: 0, rasters: 0, hidden: 0 };
  readonly images: Record<string, FigmaSceneImage> = {};
  private readonly imageHashes = new Set<string>();
  private readonly rootInv: M;
  private visited = 0;

  constructor(
    private readonly root: ExportableFrame,
    private readonly onProgress?: (done: number) => void
  ) {
    this.rootInv = inv(root.absoluteTransform);
  }

  warn(msg: string) {
    this.warnings.set(msg, (this.warnings.get(msg) ?? 0) + 1);
  }

  private tick() {
    this.visited++;
    if (this.visited % 25 === 0) this.onProgress?.(this.visited);
  }

  // ---- paints ----

  paints(paints: ReadonlyArray<Paint> | PluginAPI["mixed"]): FigmaPaint[] {
    if (paints === figma.mixed) return [];
    const out: FigmaPaint[] = [];
    for (const p of paints) {
      const base = {
        visible: p.visible !== false,
        opacity: p.opacity ?? 1,
        blendMode: p.blendMode ?? "NORMAL",
      };
      switch (p.type) {
        case "SOLID":
          out.push({ ...base, type: "SOLID", color: { r: p.color.r, g: p.color.g, b: p.color.b } });
          break;
        case "GRADIENT_LINEAR":
        case "GRADIENT_RADIAL":
        case "GRADIENT_ANGULAR":
        case "GRADIENT_DIAMOND":
          out.push({
            ...base,
            type: p.type,
            gradientTransform: p.gradientTransform.map((r) => [...r]) as FigmaTransform,
            gradientStops: p.gradientStops.map((s) => ({
              position: s.position,
              color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
            })),
          });
          break;
        case "IMAGE":
          if (p.imageHash && base.visible) this.imageHashes.add(p.imageHash);
          out.push({
            ...base,
            type: "IMAGE",
            imageHash: p.imageHash,
            scaleMode: p.scaleMode,
            imageTransform: p.imageTransform
              ? (p.imageTransform.map((r) => [...r]) as FigmaTransform)
              : undefined,
            scalingFactor: p.scalingFactor,
            rotation: p.rotation,
            filters: p.filters ? { ...p.filters } : undefined,
          });
          break;
        default:
          out.push({ ...base, type: "UNSUPPORTED", figmaType: p.type });
      }
    }
    return out;
  }

  stroke(n: SceneNode): FigmaStroke | undefined {
    if (!("strokes" in n)) return undefined;
    const paints = this.paints(n.strokes);
    if (paints.length === 0) return undefined;
    let weight = typeof n.strokeWeight === "number" ? n.strokeWeight : 0;
    let sideWeights: [number, number, number, number] | undefined;
    if ("strokeTopWeight" in n) {
      const sides: [number, number, number, number] = [
        n.strokeTopWeight,
        n.strokeRightWeight,
        n.strokeBottomWeight,
        n.strokeLeftWeight,
      ];
      if (n.strokeWeight === figma.mixed || new Set(sides).size > 1) sideWeights = sides;
      if (n.strokeWeight === figma.mixed) weight = Math.max(...sides);
    }
    const cap = "strokeCap" in n ? (n.strokeCap === figma.mixed ? "MIXED" : n.strokeCap) : "NONE";
    const join = "strokeJoin" in n ? (n.strokeJoin === figma.mixed ? "MIXED" : n.strokeJoin) : "MITER";
    return {
      paints,
      weight,
      sideWeights,
      align: n.strokeAlign,
      cap,
      join,
      miterLimit: "strokeMiterLimit" in n ? n.strokeMiterLimit : 4,
      dashPattern: [...n.dashPattern],
    };
  }

  geometry(paths: VectorPaths): FigmaVectorPath[] {
    return paths.map((p) => ({ windingRule: p.windingRule, data: p.data }));
  }

  effects(n: SceneNode): FigmaEffect[] {
    if (!("effects" in n)) return [];
    return n.effects.map((e) => {
      const out: FigmaEffect = { type: e.type, visible: e.visible, radius: "radius" in e ? e.radius : 0 };
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        out.color = { ...e.color };
        out.offset = { ...e.offset };
        out.spread = e.spread;
        out.blendMode = e.blendMode;
      }
      return out;
    });
  }

  // ---- nodes ----

  base(n: SceneNode) {
    const abs = "absoluteTransform" in n ? n.absoluteTransform : this.root.absoluteTransform;
    const rb = "absoluteRenderBounds" in n ? n.absoluteRenderBounds : null;
    return {
      id: n.id,
      name: n.name,
      figmaType: n.type,
      opacity: "opacity" in n ? n.opacity : 1,
      blendMode: "blendMode" in n ? n.blendMode : "PASS_THROUGH",
      // Relative to the ROOT frame, through any groups in between (Figma's
      // relativeTransform skips groups, so compose from absolutes).
      transform: mul(this.rootInv, abs),
      width: "width" in n ? n.width : 0,
      height: "height" in n ? n.height : 0,
      isMask: "isMask" in n ? n.isMask : false,
      maskType: "maskType" in n ? n.maskType : ("ALPHA" as const),
      effects: this.effects(n),
      renderBounds: rb ? rectInRoot(rb, this.rootInv) : undefined,
      primitive: primitiveHint(n),
    };
  }

  async node(n: SceneNode): Promise<FigmaSceneNode | null> {
    this.tick();
    if (!n.visible) {
      this.stats.hidden++;
      return null;
    }
    try {
      switch (n.type) {
        case "FRAME":
        case "COMPONENT":
        case "INSTANCE":
        case "COMPONENT_SET":
        case "GROUP":
        case "SECTION":
        case "SLOT":
          return await this.container(n);
        case "RECTANGLE":
        case "ELLIPSE":
        case "POLYGON":
        case "STAR":
        case "VECTOR":
        case "LINE":
        case "BOOLEAN_OPERATION": {
          // A fill plugins can't read (a video's bytes aren't exposed):
          // keep the look as a still.
          const unreadable = unreadableFill(n);
          if (unreadable) return await this.raster(n, `${unreadable} fill (still frame)`, isPlainOpaqueRect(n));
          return this.shape(n);
        }
        case "TEXT":
          return await this.text(n);
        case "SLICE":
          return null;
        default:
          // TRANSFORM_GROUP (render-time repeats), stickies, embeds, …: keep
          // the look as a flat image.
          return await this.raster(n, `${n.type.toLowerCase().replace(/_/g, " ")} layer`);
      }
    } catch (err) {
      this.warn(`A layer couldn't be read and was skipped (${err instanceof Error ? err.message : "error"})`);
      return null;
    }
  }

  async container(
    n: FrameNode | ComponentNode | InstanceNode | ComponentSetNode | GroupNode | SectionNode | SlotNode
  ): Promise<FigmaContainerNode> {
    const kids: FigmaSceneNode[] = [];
    let children = [...n.children];
    // Auto layout can draw its FIRST child on top.
    if ("layoutMode" in n && n.layoutMode !== "NONE" && "itemReverseZIndex" in n && n.itemReverseZIndex) {
      children = children.reverse();
    }
    for (const c of children) {
      const k = await this.node(c);
      if (k) kids.push(k);
    }
    const hasOwnPaint = n.type !== "GROUP";
    return {
      ...this.base(n),
      kind: "container",
      clipsContent: "clipsContent" in n ? n.clipsContent : false,
      fills: hasOwnPaint && "fills" in n ? this.paints(n.fills) : [],
      fillGeometry: "fillGeometry" in n ? this.geometry(n.fillGeometry) : [],
      stroke: hasOwnPaint ? this.stroke(n) : undefined,
      children: kids,
    };
  }

  shape(
    n: RectangleNode | EllipseNode | PolygonNode | StarNode | VectorNode | LineNode | BooleanOperationNode
  ): FigmaShapeNode {
    this.stats.shapes++;
    this.stats.layers++;
    let strokePaths: FigmaVectorPath[] | undefined;
    if (n.type === "LINE") {
      strokePaths = [{ windingRule: "NONE", data: `M 0 0 L ${n.width} 0` }];
    } else if (n.type === "VECTOR") {
      try {
        strokePaths = this.geometry(n.vectorPaths);
      } catch {
        this.warn("A vector's path couldn't be read — its stroke follows the fill outline");
      }
    }
    return {
      ...this.base(n),
      kind: "shape",
      fills: this.paints(n.fills),
      fillGeometry: this.geometry(n.fillGeometry),
      stroke: this.stroke(n),
      strokePaths,
    };
  }

  async text(n: TextNode): Promise<FigmaTextNode> {
    this.stats.texts++;
    this.stats.layers++;
    // Glyph outlines (fillGeometry) come back empty until the fonts load.
    if (!n.hasMissingFont) {
      try {
        const fonts = n.getRangeAllFontNames(0, n.characters.length);
        await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
      } catch {
        this.warn("A text layer's font couldn't be loaded in Figma");
      }
    } else {
      this.warn("A text layer uses a font that's missing in Figma");
    }
    const segs = n.getStyledTextSegments([
      "fontName",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "textCase",
      "textDecoration",
      "letterSpacing",
      "lineHeight",
      "paragraphSpacing",
      "paragraphIndent",
      "fills",
    ]);
    const segments: FigmaTextSegment[] = segs.map((s) => ({
      start: s.start,
      end: s.end,
      characters: s.characters,
      fontFamily: s.fontName.family,
      fontStyle: s.fontName.style,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      italic: s.fontStyle === "ITALIC",
      textCase: s.textCase,
      textDecoration: s.textDecoration,
      letterSpacing: { unit: s.letterSpacing.unit, value: s.letterSpacing.value },
      lineHeight:
        s.lineHeight.unit === "AUTO"
          ? { unit: "AUTO" }
          : { unit: s.lineHeight.unit, value: s.lineHeight.value },
      paragraphSpacing: s.paragraphSpacing,
      paragraphIndent: s.paragraphIndent,
      fills: this.paints(s.fills),
    }));
    // Figma's own layout: live <text> with one <tspan x y> per line run.
    let svg: string | undefined;
    try {
      svg = await n.exportAsync({
        format: "SVG_STRING",
        svgOutlineText: false,
        svgIdAttribute: false,
        useAbsoluteBounds: true,
      });
    } catch {
      this.warn("A text layer's layout couldn't be exported");
    }
    let fillGeometry: FigmaVectorPath[] = [];
    try {
      fillGeometry = this.geometry(n.fillGeometry);
    } catch {
      // Outline export is the fallback path only.
    }
    return {
      ...this.base(n),
      kind: "text",
      text: {
        characters: n.characters,
        segments,
        alignHorizontal: n.textAlignHorizontal,
        alignVertical: n.textAlignVertical,
        autoResize: n.textAutoResize,
        truncation: n.textTruncation,
        maxLines: n.maxLines,
        leadingTrim: n.leadingTrim === figma.mixed ? "MIXED" : n.leadingTrim,
        hasMissingFont: n.hasMissingFont,
        svg,
      },
      fills: this.paints(n.fills),
      fillGeometry,
      stroke: this.stroke(n),
    };
  }

  // A node toolbox can't rebuild: export its pixels (cropped to its
  // rendered bounds — the export's own default) and place that image. Up to
  // 2×, long side capped at 4096 px; JPG when nothing in it is transparent
  // (a full-frame still as PNG runs to tens of MB — too big to copy).
  async raster(n: SceneNode, reason: string, opaque = false): Promise<FigmaRasterNode | null> {
    const rb = "absoluteRenderBounds" in n ? n.absoluteRenderBounds : null;
    if (!rb || rb.width <= 0 || rb.height <= 0) return null;
    const scale = Math.min(2, 4096 / Math.max(rb.width, rb.height));
    const format = opaque ? "JPG" : "PNG";
    const bytes = await n.exportAsync({ format, constraint: { type: "SCALE", value: scale } });
    const key = `raster:${n.id}`;
    this.images[key] = {
      mime: opaque ? "image/jpeg" : "image/png",
      width: Math.round(rb.width * scale),
      height: Math.round(rb.height * scale),
      base64: figma.base64Encode(bytes),
    };
    this.stats.rasters++;
    this.stats.layers++;
    // (toolbox's importer reports each flattened layer — no note here)
    return {
      ...this.base(n),
      kind: "raster",
      imageRef: key,
      bounds: rectInRoot(rb, this.rootInv),
      reason,
    };
  }

  // Original image bytes for every visible image paint, de-duplicated.
  async fetchImages(): Promise<void> {
    for (const hash of this.imageHashes) {
      const img = figma.getImageByHash(hash);
      if (!img) {
        this.warn("An image fill's data wasn't available");
        continue;
      }
      try {
        const [bytes, size] = await Promise.all([img.getBytesAsync(), img.getSizeAsync()]);
        const mime = sniffMime(bytes);
        if (!mime) {
          this.warn("An image in an unsupported format was skipped");
          continue;
        }
        this.images[hash] = { mime, width: size.width, height: size.height, base64: figma.base64Encode(bytes) };
        this.stats.images++;
      } catch {
        this.warn("An image fill couldn't be read");
      }
    }
  }
}

export async function extractScene(root: ExportableFrame, opts: ExtractOptions): Promise<{
  scene: FigmaScene;
  stats: ExtractStats;
}> {
  const x = new Extractor(root, opts.onProgress);
  const frame = await x.container(root);
  frame.transform = [
    [1, 0, 0],
    [0, 1, 0],
  ];
  await x.fetchImages();

  let reference: FigmaScene["reference"];
  if (opts.reference) {
    // Cap the long side at 2048 px — enough to judge an import, small
    // enough for the clipboard.
    const scale = Math.min(1, 2048 / Math.max(root.width, root.height));
    try {
      const bytes = await root.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
      reference = {
        mime: "image/png",
        width: Math.round(root.width * scale),
        height: Math.round(root.height * scale),
        base64: figma.base64Encode(bytes),
        scale,
      };
    } catch {
      x.warn("The reference render couldn't be exported");
    }
  }

  const warnings = [...x.warnings].map(([msg, n]) => (n > 1 ? `${msg} (×${n})` : msg));
  const scene: FigmaScene = {
    // The marker goes first: toolbox's paste gate only scans the head.
    [FIGMA_SCENE_MARKER]: FIGMA_SCENE_VERSION,
    generator: { name: "toolbox-figma-plugin", version: __PLUGIN_VERSION__ },
    source: {
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      nodeId: root.id,
      nodeName: root.name,
    },
    colorProfile: figma.root.documentColorProfile,
    frame,
    images: x.images,
    ...(reference ? { reference } : {}),
    warnings,
  };
  return { scene, stats: x.stats };
}
