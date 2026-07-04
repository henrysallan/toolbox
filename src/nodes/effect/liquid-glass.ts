import type { NodeDefinition, SdfValue } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";
import { compileSdfSnippet, structuralHash } from "@/engine/sdf-compile";

// Liquid Glass — Apple-style refractive glass over a backdrop. Adapts
// iyinchao/liquid-glass-studio (WebGL2/GLSL, MIT). The node takes the BACKDROP
// as an image input (refraction must see what's behind it — a node graph can't
// backdrop-filter downstream layers) and outputs the backdrop with glass
// composited over a shape region.
//
// Optical model (port of the reference's final STEP-9 path):
//  - an ANALYTIC signed distance field: a built-in rounded-rect / superellipse
//    (optionally smin-merged with a second shape → the "liquid" meld), and/or a
//    wired `sdf` input whose compiled distance expression is INLINED here (built-
//    in quality for any shape: SDF primitives, booleans, smooth-union, splines
//    via SDF Spline). No rasterize/JFA round-trip — that gave faceted normals.
//  - per-pixel normal from finite differences of that analytic SDF.
//  - Snell-law edge/bevel factor (distance-to-edge vs `thickness`) → refraction
//    offset of the (blurred) backdrop, with explicit per-channel chromatic
//    dispersion (the reference's LOD-bias hack can't work — pooled textures have
//    no mipmaps).
//  - Fresnel edge brightening + an angular glare streak, both composited in LCH.
//  - tint, and an edge→center sharp/blur blend.
//
// Universal mask + opacity are applied by the evaluator.

// Separable gaussian for the backdrop blur (own copy — engine self-containment;
// nodes don't import from sibling node files). Matches gaussian-blur.ts.
const MAX_TAPS = 64;
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_taps;
out vec4 outColor;
void main() {
  if (u_sigma <= 0.0001) { outColor = texture(u_src, v_uv); return; }
  float twoSigmaSq = 2.0 * u_sigma * u_sigma;
  vec4 acc = texture(u_src, v_uv);
  float weightSum = 1.0;
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > u_taps) break;
    float w = exp(-float(i * i) / twoSigmaSq);
    vec2 off = u_dir * u_texel * float(i);
    acc += texture(u_src, v_uv + off) * w;
    acc += texture(u_src, v_uv - off) * w;
    weightSum += 2.0 * w;
  }
  outColor = acc / weightSum;
}`;

// The glass shader is composed per SDF topology: when a `shape` SDF is wired its
// compiled distance expression (in terms of `p`) and helper/uniform decls are
// spliced in; otherwise a stub is used. Cached by structuralHash(root), so
// animating SDF params only rebinds uniforms (no recompile). `sdfDecls` are the
// SDF's uniform + helper declarations; `distExpr` is the float distance in `p`.
function buildGlassFS(sdfDecls: string, distExpr: string): string {
  return `#version 300 es
precision highp float;
#define PI 3.14159265359

in vec2 v_uv;
uniform sampler2D u_bg;     // sharp backdrop
uniform sampler2D u_blur;   // blurred backdrop
uniform vec2 u_resolution;  // canvas px

// shape A
uniform int u_shapeTypeA;   // 0 rounded-rect, 1 circle/ellipse
uniform vec2 u_centerA;     // px, Y-up
uniform vec2 u_halfA;       // px half-extents
uniform float u_crA;        // px corner radius
uniform float u_nA;         // superellipse exponent
// shape B (optional)
uniform int u_useB;
uniform int u_shapeTypeB;
uniform vec2 u_centerB;
uniform vec2 u_halfB;
uniform float u_crB;
uniform float u_nB;
uniform float u_mergeK;     // px, smooth-union radius

// optics
uniform float u_thickness;  // px bevel band
uniform float u_ior;        // index of refraction
uniform float u_strength;   // px refraction displacement scale
uniform float u_disp;       // chromatic dispersion
uniform int u_blurEdge;     // 1 = frost (blur to center)
uniform vec3 u_tint;
uniform float u_tintA;
uniform float u_fresnelFactor;
uniform float u_fresnelRange;
uniform float u_fresnelHardness;
uniform float u_glareFactor;
uniform float u_glareRange;
uniform float u_glareHardness;
uniform float u_glareConvergence;
uniform float u_glareOpposite;
uniform float u_glareAngle;  // radians

// external analytic shape (wired SDF): overrides/merges the built-ins.
uniform int u_shapeSource;   // 0 none, 1 external present
uniform int u_shapeMode;     // 0 replace, 1 merge (smin with built-ins)
uniform float u_normalRadius; // px; >0 smooths texture-backed (image-derived) SDFs

// ---- injected SDF uniforms + helpers (empty when no shape wired) ----
${sdfDecls}

out vec4 outColor;

const float N_R = 1.0 - 0.02;
const float N_G = 1.0;
const float N_B = 1.0 + 0.02;

float safeAsin(float x) { return asin(clamp(x, -1.0, 1.0)); }

// ---- LCH color stack (from the reference's lib/color.glsl, D65) ----
const vec3 D65_WHITE = vec3(0.95045592705, 1.0, 1.08905775076);
vec3 WHITE = D65_WHITE;
const mat3 RGB_TO_XYZ_M = mat3(0.4124,0.3576,0.1805, 0.2126,0.7152,0.0722, 0.0193,0.1192,0.9505);
const mat3 XYZ_TO_RGB_M = mat3(3.2406255,-1.537208,-0.4986286, -0.9689307,1.8757561,0.0415175, 0.0557101,-0.2040211,1.0569959);
float UNCOMPAND_SRGB(float a){ return a > 0.04045 ? pow((a+0.055)/1.055, 2.4) : a/12.92; }
float COMPAND_RGB(float a){ return a <= 0.0031308 ? 12.92*a : 1.055*pow(a, 0.41666666666) - 0.055; }
vec3 RGB_TO_XYZ(vec3 rgb){ return rgb * RGB_TO_XYZ_M; }
vec3 SRGB_TO_RGB(vec3 c){ return vec3(UNCOMPAND_SRGB(c.x), UNCOMPAND_SRGB(c.y), UNCOMPAND_SRGB(c.z)); }
vec3 RGB_TO_SRGB(vec3 c){ return vec3(COMPAND_RGB(c.x), COMPAND_RGB(c.y), COMPAND_RGB(c.z)); }
vec3 SRGB_TO_XYZ(vec3 s){ return RGB_TO_XYZ(SRGB_TO_RGB(s)); }
float XYZ_TO_LAB_F(float x){ return x > 0.00885645167 ? pow(x, 0.333333333) : 7.78703703704*x + 0.13793103448; }
vec3 XYZ_TO_LAB(vec3 xyz){
  vec3 s = xyz / WHITE;
  s = vec3(XYZ_TO_LAB_F(s.x), XYZ_TO_LAB_F(s.y), XYZ_TO_LAB_F(s.z));
  return vec3(116.0*s.y - 16.0, 500.0*(s.x - s.y), 200.0*(s.y - s.z));
}
vec3 SRGB_TO_LAB(vec3 s){ return XYZ_TO_LAB(SRGB_TO_XYZ(s)); }
vec3 LAB_TO_LCH(vec3 lab){ return vec3(lab.x, sqrt(dot(lab.yz, lab.yz)), atan(lab.z, lab.y) * 57.2957795131); }
vec3 SRGB_TO_LCH(vec3 s){ return LAB_TO_LCH(SRGB_TO_LAB(s)); }
vec3 XYZ_TO_RGB(vec3 xyz){ return xyz * XYZ_TO_RGB_M; }
vec3 XYZ_TO_SRGB(vec3 xyz){ return RGB_TO_SRGB(XYZ_TO_RGB(xyz)); }
float LAB_TO_XYZ_F(float x){ return x > 0.206897 ? x*x*x : 0.12841854934*(x - 0.137931034); }
vec3 LAB_TO_XYZ(vec3 lab){
  float w = (lab.x + 16.0) / 116.0;
  return WHITE * vec3(LAB_TO_XYZ_F(w + lab.y/500.0), LAB_TO_XYZ_F(w), LAB_TO_XYZ_F(w - lab.z/200.0));
}
vec3 LAB_TO_SRGB(vec3 lab){ return XYZ_TO_SRGB(LAB_TO_XYZ(lab)); }
vec3 LCH_TO_LAB(vec3 lch){ return vec3(lch.x, lch.y*cos(lch.z*0.01745329251), lch.y*sin(lch.z*0.01745329251)); }
vec3 LCH_TO_SRGB(vec3 lch){ return LAB_TO_SRGB(LCH_TO_LAB(lch)); }

// ---- built-in analytic SDF (px space; named lg_* to avoid clashing with the
//      injected SDF helpers, which define their own smin) ----
float superellipseCorner(vec2 p, float r, float n){
  p = abs(p);
  return pow(pow(p.x, n) + pow(p.y, n), 1.0/n) - r;
}
float roundedRect(vec2 p, vec2 he, float cr, float n){
  cr = min(cr, min(he.x, he.y));
  vec2 d = abs(p) - he;
  if (d.x > -cr && d.y > -cr) {
    vec2 cc = sign(p) * (he - vec2(cr));
    return superellipseCorner(p - cc, cr, n);
  }
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2(0.0)));
}
float ellipse(vec2 p, vec2 he){
  float k1 = length(p / he);
  float k2 = length(p / (he * he));
  return k1 * (k1 - 1.0) / max(k2, 1e-6);
}
float shapeSDF(int type, vec2 p, vec2 he, float cr, float n){
  if (type == 1) return ellipse(p, he);
  return roundedRect(p, he, cr, n);
}
float lg_smin(float a, float b, float k){
  if (k <= 0.0) return min(a, b);
  float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0 - h);
}

// Wired SDF distance. The compiled expression is in terms of a canvas-UV p;
// aspect-correct it exactly as the Rasterize node does, then scale UV to px (the
// aspect-correct space is isotropic in canvas-width units). When no SDF is wired
// distExpr is a large constant (the branch is gated off anyway).
float sdfExt(vec2 p){ return ${distExpr}; }
vec2 sdfP(vec2 uv){
  float aspect = u_resolution.x / u_resolution.y;
  return vec2(uv.x, (uv.y - 0.5) / aspect + 0.5);
}
float extDistPx(vec2 uv){ return sdfExt(sdfP(uv)) * u_resolution.x; }

float sceneSDF(vec2 uv){
  vec2 q = uv * u_resolution;
  float d = shapeSDF(u_shapeTypeA, q - u_centerA, u_halfA, u_crA, u_nA);
  if (u_useB == 1) {
    float dB = shapeSDF(u_shapeTypeB, q - u_centerB, u_halfB, u_crB, u_nB);
    d = lg_smin(d, dB, u_mergeK);
  }
  if (u_shapeSource == 1) {
    float ext = extDistPx(uv);  // px
    d = (u_shapeMode == 0) ? ext : lg_smin(d, ext, u_mergeK);
  }
  return d;
}
vec2 sceneNormal(vec2 uv){
  vec2 e = 1.0 / u_resolution;
  float dx = sceneSDF(uv + vec2(e.x, 0.0)) - sceneSDF(uv - vec2(e.x, 0.0));
  float dy = sceneSDF(uv + vec2(0.0, e.y)) - sceneSDF(uv - vec2(0.0, e.y));
  vec2 g = vec2(dx, dy);
  float L = length(g);
  return L > 1e-6 ? g / L : vec2(0.0);
}
float vec2ToAngle(vec2 v){
  float a = atan(v.y, v.x);
  if (a < 0.0) a += 2.0 * PI;
  return a;
}

void main(){
  float d = sceneSDF(v_uv);        // px, negative inside
  vec4 bg = texture(u_bg, v_uv);
  float aa = 1.5;                  // px boundary AA
  if (d > aa) { outColor = bg; return; }

  // Optics distance + normal. Texture-backed SDFs (e.g. SDF From Image) carry a
  // faceted/quantized JFA field → a moiré grid under refraction; sample a
  // smoothed 3x3 kernel for distance and a Sobel normal. Analytic SDFs (and the
  // built-ins) use the crisp 1px central difference.
  vec2 normal;
  float dOpt;
  if (u_shapeSource == 1 && u_normalRadius > 0.5) {
    vec2 r = u_normalRadius / u_resolution;
    float tl = sceneSDF(v_uv + vec2(-r.x,  r.y));
    float tm = sceneSDF(v_uv + vec2( 0.0,  r.y));
    float tr = sceneSDF(v_uv + vec2( r.x,  r.y));
    float ml = sceneSDF(v_uv + vec2(-r.x,  0.0));
    float mr = sceneSDF(v_uv + vec2( r.x,  0.0));
    float bl = sceneSDF(v_uv + vec2(-r.x, -r.y));
    float bm = sceneSDF(v_uv + vec2( 0.0, -r.y));
    float br = sceneSDF(v_uv + vec2( r.x, -r.y));
    dOpt = (tl + 2.0*tm + tr + 2.0*ml + 4.0*d + 2.0*mr + bl + 2.0*bm + br) / 16.0;
    float gx = (tr + 2.0*mr + br) - (tl + 2.0*ml + bl);
    float gy = (tl + 2.0*tm + tr) - (bl + 2.0*bm + br);
    vec2 g = vec2(gx, gy);
    float L = length(g);
    normal = L > 1e-6 ? g / L : vec2(0.0);
  } else {
    normal = sceneNormal(v_uv);
    dOpt = d;
  }
  float nmerged = -dOpt;           // distance inside the edge (px)

  // Snell-law edge/bevel factor.
  float xr = 1.0 - nmerged / max(u_thickness, 0.0001);
  float thetaI = safeAsin(pow(max(xr, 0.0), 2.0));
  float thetaT = safeAsin(sin(thetaI) / max(u_ior, 0.0001));
  float edgeFactor = -tan(thetaT - thetaI);
  if (nmerged >= u_thickness) edgeFactor = 0.0;
  edgeFactor = max(edgeFactor, 0.0);

  // edge -> center sharp/blur blend (frost blurs everywhere).
  float edgeH = clamp(nmerged / max(u_thickness, 0.0001), 0.0, 1.0);
  float mixRate = u_blurEdge > 0 ? 1.0 : edgeH;

  // refraction displacement (px -> uv, isotropic) with chromatic dispersion.
  vec2 offset = -normal * (edgeFactor * u_strength) / u_resolution;
  float sR = 1.0 - (N_R - 1.0) * u_disp;
  float sG = 1.0 - (N_G - 1.0) * u_disp;
  float sB = 1.0 - (N_B - 1.0) * u_disp;
  vec2 uvR = v_uv + offset * sR;
  vec2 uvG = v_uv + offset * sG;
  vec2 uvB = v_uv + offset * sB;

  vec4 glass;
  glass.r = mix(texture(u_bg, uvR).r, texture(u_blur, uvR).r, mixRate);
  glass.g = mix(texture(u_bg, uvG).g, texture(u_blur, uvG).g, mixRate);
  glass.b = mix(texture(u_bg, uvB).b, texture(u_blur, uvB).b, mixRate);
  float bgAlpha = mix(texture(u_bg, uvG).a, texture(u_blur, uvG).a, mixRate);
  glass.a = 1.0;

  // tint
  glass = mix(glass, vec4(u_tint, 1.0), u_tintA * 0.8);

  // fresnel — concentrates near the edge (d small-negative), fades inward.
  float fres = clamp(pow(1.0 + dOpt / 1500.0 * pow(500.0 / max(u_fresnelRange, 1.0), 2.0) + u_fresnelHardness, 5.0), 0.0, 1.0);
  vec3 fLCH = SRGB_TO_LCH(mix(vec3(1.0), u_tint, u_tintA * 0.5));
  fLCH.x = clamp(fLCH.x + 20.0 * fres * u_fresnelFactor, 0.0, 100.0);
  glass = mix(glass, vec4(LCH_TO_SRGB(fLCH), 1.0), fres * u_fresnelFactor * 0.7);

  // glare — angular specular streak.
  float glareGeo = clamp(pow(1.0 + dOpt / 1500.0 * pow(500.0 / max(u_glareRange, 1.0), 2.0) + u_glareHardness, 5.0), 0.0, 1.0);
  float ga = (vec2ToAngle(normal) - PI / 4.0 + u_glareAngle) * 2.0;
  float farMul = ((ga > PI * 1.5 && ga < PI * 3.5) || ga < -PI * 0.5) ? 1.2 * u_glareOpposite : 1.2;
  float gaf = (0.5 + sin(ga) * 0.5) * farMul * u_glareFactor;
  gaf = clamp(pow(max(gaf, 0.0), 0.1 + u_glareConvergence * 2.0), 0.0, 1.0);
  vec3 gLCH = SRGB_TO_LCH(mix(glass.rgb, u_tint, u_tintA * 0.5));
  gLCH.x = clamp(gLCH.x + 150.0 * gaf * glareGeo, 0.0, 120.0);
  gLCH.y = gLCH.y + 30.0 * gaf * glareGeo;
  glass = mix(glass, vec4(LCH_TO_SRGB(gLCH), 1.0), gaf * glareGeo);

  glass.a = bgAlpha;

  // composite glass over the backdrop with smooth boundary AA.
  float t = smoothstep(-aa, aa, d);  // 0 inside -> 1 outside
  outColor = mix(glass, bg, t);
}`;
}

// Stub distance expression used when no SDF input is wired (branch gated off).
const NO_SDF_EXPR = "1.0e9";

// Does the SDF tree contain an image-derived (JFA, texture-backed) leaf? Those
// need gradient smoothing; analytic primitives (incl. SDF Spline, whose distance
// is computed from segments) do not. Recursive walk over the AST.
function sdfContainsKind(node: unknown, kind: string): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.kind === kind) return true;
  for (const key in n) {
    const v = n[key];
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        for (const it of v) if (sdfContainsKind(it, kind)) return true;
      } else if (sdfContainsKind(v, kind)) {
        return true;
      }
    }
  }
  return false;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = (hex || "#ffffff").replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export const liquidGlassNode: NodeDefinition = {
  type: "liquid-glass",
  name: "Liquid Glass",
  category: "image",
  subcategory: "modifier",
  description:
    "Apple-style refractive liquid glass over a backdrop. Wire the image behind the glass into the backdrop input; a built-in rounded-rect/superellipse panel (optionally smooth-merged with a second shape) refracts, disperses, and glares over it. Wire an SDF into `shape` for any analytic shape — circles, booleans, smooth-union blobs, or splines via SDF Spline.",
  backend: "webgl2",
  inputs: [
    { name: "image", label: "backdrop", type: "image", required: true },
    // Optional analytic shape: any SDF (primitives, booleans, smooth-union,
    // SDF Spline) defines the glass region at built-in quality. Replaces or
    // merges with the built-in shapes (see `shapeMode`).
    { name: "shape", label: "shape (SDF)", type: "sdf", required: false },
  ],
  params: [
    // ---- Shape A ----
    {
      name: "shapeType",
      label: "Shape",
      type: "enum",
      options: ["rounded-rect", "circle"],
      default: "rounded-rect",
    },
    { name: "posX", label: "Position X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "posY", label: "Position Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5 },
    { name: "width", label: "Width", type: "scalar", min: 0, max: 1, softMax: 1, step: 0.001, default: 0.4 },
    { name: "height", label: "Height", type: "scalar", min: 0, max: 1, softMax: 1, step: 0.001, default: 0.26 },
    {
      name: "cornerRadius",
      label: "Corner Radius",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.6,
      visibleIf: (p) => p.shapeType !== "circle",
    },
    {
      name: "roundness",
      label: "Roundness (squircle)",
      type: "scalar",
      min: 2,
      max: 12,
      step: 0.1,
      default: 5,
      visibleIf: (p) => p.shapeType !== "circle",
    },

    // ---- Shape B (liquid merge) ----
    { name: "secondShape", label: "Second Shape", type: "boolean", default: false },
    {
      name: "bShapeType",
      label: "Shape B",
      type: "enum",
      options: ["circle", "rounded-rect"],
      default: "circle",
      visibleIf: (p) => p.secondShape === true,
    },
    { name: "bPosX", label: "B Position X", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.66, visibleIf: (p) => p.secondShape === true },
    { name: "bPosY", label: "B Position Y", type: "scalar", min: 0, max: 1, step: 0.001, default: 0.5, visibleIf: (p) => p.secondShape === true },
    { name: "bWidth", label: "B Width", type: "scalar", min: 0, max: 1, softMax: 1, step: 0.001, default: 0.16, visibleIf: (p) => p.secondShape === true },
    { name: "bHeight", label: "B Height", type: "scalar", min: 0, max: 1, softMax: 1, step: 0.001, default: 0.16, visibleIf: (p) => p.secondShape === true },
    { name: "bCornerRadius", label: "B Corner Radius", type: "scalar", min: 0, max: 1, step: 0.001, default: 1, visibleIf: (p) => p.secondShape === true && p.bShapeType !== "circle" },
    { name: "bRoundness", label: "B Roundness", type: "scalar", min: 2, max: 12, step: 0.1, default: 5, visibleIf: (p) => p.secondShape === true && p.bShapeType !== "circle" },
    { name: "mergeRadius", label: "Merge", type: "scalar", min: 0, max: 400, softMax: 200, step: 1, default: 60, visibleIf: (p) => p.secondShape === true },

    // How a wired `shape` SDF combines with the built-in shapes.
    { name: "shapeMode", label: "Shape Input", type: "enum", options: ["replace", "merge"], default: "replace" },
    // Smooths texture-backed SDFs (e.g. SDF From Image), whose JFA field is
    // faceted → a moiré grid. 0 = crisp (right for analytic SDF primitives).
    { name: "shapeSmooth", label: "Shape Smoothing (px)", type: "scalar", min: 0, max: 16, softMax: 8, step: 0.5, default: 0 },

    // ---- Optics ----
    { name: "thickness", label: "Edge Thickness", type: "scalar", min: 1, max: 400, softMax: 200, step: 1, default: 80 },
    { name: "ior", label: "Refraction (IOR)", type: "scalar", min: 1, max: 2.5, step: 0.01, default: 1.5 },
    { name: "strength", label: "Refraction Strength", type: "scalar", min: 0, max: 400, softMax: 200, step: 1, default: 60 },
    { name: "dispersion", label: "Dispersion", type: "scalar", min: 0, max: 3, softMax: 1.5, step: 0.01, default: 0.4 },
    { name: "blur", label: "Backdrop Blur (px)", type: "scalar", min: 0, max: 60, softMax: 30, step: 0.5, default: 8 },
    { name: "blurEdge", label: "Frost (blur center)", type: "boolean", default: false },

    { name: "tint", label: "Tint", type: "color", default: "#ffffff" },
    { name: "tintOpacity", label: "Tint Opacity", type: "scalar", min: 0, max: 1, step: 0.001, default: 0 },

    { name: "fresnelFactor", label: "Fresnel", type: "scalar", min: 0, max: 3, step: 0.01, default: 1 },
    { name: "fresnelRange", label: "Fresnel Range", type: "scalar", min: 1, max: 500, step: 1, default: 120 },
    { name: "fresnelHardness", label: "Fresnel Hardness", type: "scalar", min: -1, max: 1, step: 0.01, default: 0 },

    { name: "glareFactor", label: "Glare", type: "scalar", min: 0, max: 2, step: 0.01, default: 0.6 },
    { name: "glareAngle", label: "Glare Angle", type: "scalar", min: -180, max: 180, step: 1, default: 45 },
    { name: "glareRange", label: "Glare Range", type: "scalar", min: 1, max: 500, step: 1, default: 120 },
    { name: "glareHardness", label: "Glare Hardness", type: "scalar", min: -1, max: 1, step: 0.01, default: 0 },
    { name: "glareConvergence", label: "Glare Convergence", type: "scalar", min: 0, max: 1, step: 0.01, default: 0.4 },
    { name: "glareOppositeFactor", label: "Glare Opposite", type: "scalar", min: 0, max: 1, step: 0.01, default: 0.5 },

    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const W = src.width;
    const H = src.height;

    // ---- backdrop blur pre-pass (separable) ----
    const blurRadius = Math.max(0, (params.blur as number) ?? 0);
    let blurTex = src;
    let blurred: typeof src | null = null;
    if (blurRadius > 0.0001) {
      const sigma = blurRadius * 0.5;
      const taps = Math.min(MAX_TAPS, Math.max(1, Math.ceil(sigma * 3)));
      const bprog = ctx.getShader("liquid-glass/blur", BLUR_FS);
      const tmp = ctx.allocImage();
      ctx.drawFullscreen(bprog, tmp, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(bprog, "u_src"), 0);
        gl.uniform2f(gl.getUniformLocation(bprog, "u_texel"), 1 / W, 1 / H);
        gl.uniform2f(gl.getUniformLocation(bprog, "u_dir"), 1, 0);
        gl.uniform1f(gl.getUniformLocation(bprog, "u_sigma"), sigma);
        gl.uniform1i(gl.getUniformLocation(bprog, "u_taps"), taps);
      });
      blurred = ctx.allocImage();
      ctx.drawFullscreen(bprog, blurred, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
        gl.uniform1i(gl.getUniformLocation(bprog, "u_src"), 0);
        gl.uniform2f(gl.getUniformLocation(bprog, "u_texel"), 1 / W, 1 / H);
        gl.uniform2f(gl.getUniformLocation(bprog, "u_dir"), 0, 1);
        gl.uniform1f(gl.getUniformLocation(bprog, "u_sigma"), sigma);
        gl.uniform1i(gl.getUniformLocation(bprog, "u_taps"), taps);
      });
      ctx.releaseTexture(tmp.texture);
      blurTex = blurred;
    }

    // ---- shape geometry (params normalized [0,1] Y-down -> px Y-up) ----
    const shapeTypeA = (params.shapeType as string) === "circle" ? 1 : 0;
    const acx = ((params.posX as number) ?? 0.5) * W;
    const acy = (1 - ((params.posY as number) ?? 0.5)) * H;
    const ahx = (((params.width as number) ?? 0.4) / 2) * W;
    const ahy = (((params.height as number) ?? 0.26) / 2) * H;
    const acr = ((params.cornerRadius as number) ?? 0.6) * Math.min(ahx, ahy);
    const anA = (params.roundness as number) ?? 5;

    const useB = (params.secondShape as boolean) === true;
    const shapeTypeB = (params.bShapeType as string) === "rounded-rect" ? 0 : 1;
    const bcx = ((params.bPosX as number) ?? 0.66) * W;
    const bcy = (1 - ((params.bPosY as number) ?? 0.5)) * H;
    const bhx = (((params.bWidth as number) ?? 0.16) / 2) * W;
    const bhy = (((params.bHeight as number) ?? 0.16) / 2) * H;
    const bcr = ((params.bCornerRadius as number) ?? 1) * Math.min(bhx, bhy);
    const anB = (params.bRoundness as number) ?? 5;
    const mergeK = (params.mergeRadius as number) ?? 60;

    const tint = hexToRgb((params.tint as string) ?? "#ffffff");
    const tintA = (params.tintOpacity as number) ?? 0;
    const glareAngleRad = (((params.glareAngle as number) ?? 45) * Math.PI) / 180;

    // ---- external analytic shape: compile the wired SDF and splice it in ----
    const shape = inputs.shape;
    const snippet =
      shape && shape.kind === "sdf"
        ? compileSdfSnippet((shape as SdfValue).root)
        : null;
    const cacheKey = snippet
      ? `liquid-glass/main/${structuralHash((shape as SdfValue).root)}`
      : "liquid-glass/main/none";
    const source = buildGlassFS(
      snippet?.decls ?? "",
      snippet?.distExpr ?? NO_SDF_EXPR
    );
    const prog = ctx.getShader(cacheKey, source);

    const shapeMode = (params.shapeMode as string) === "merge" ? 1 : 0;
    // Auto-smooth image-derived SDFs (faceted JFA field) unless the user has set
    // their own smoothing; analytic SDFs stay crisp at 0.
    const shapeSmoothParam = (params.shapeSmooth as number) ?? 0;
    const textureBacked =
      snippet != null &&
      sdfContainsKind((shape as SdfValue).root, "sdfFromImage");
    const normalRadius =
      shapeSmoothParam > 0 ? shapeSmoothParam : textureBacked ? 3 : 0;

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_bg"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, blurTex.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_blur"), 1);
      gl.uniform2f(gl.getUniformLocation(prog, "u_resolution"), W, H);

      gl.uniform1i(gl.getUniformLocation(prog, "u_shapeTypeA"), shapeTypeA);
      gl.uniform2f(gl.getUniformLocation(prog, "u_centerA"), acx, acy);
      gl.uniform2f(gl.getUniformLocation(prog, "u_halfA"), ahx, ahy);
      gl.uniform1f(gl.getUniformLocation(prog, "u_crA"), acr);
      gl.uniform1f(gl.getUniformLocation(prog, "u_nA"), anA);

      gl.uniform1i(gl.getUniformLocation(prog, "u_useB"), useB ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_shapeTypeB"), shapeTypeB);
      gl.uniform2f(gl.getUniformLocation(prog, "u_centerB"), bcx, bcy);
      gl.uniform2f(gl.getUniformLocation(prog, "u_halfB"), bhx, bhy);
      gl.uniform1f(gl.getUniformLocation(prog, "u_crB"), bcr);
      gl.uniform1f(gl.getUniformLocation(prog, "u_nB"), anB);
      gl.uniform1f(gl.getUniformLocation(prog, "u_mergeK"), mergeK);

      gl.uniform1f(gl.getUniformLocation(prog, "u_thickness"), (params.thickness as number) ?? 80);
      gl.uniform1f(gl.getUniformLocation(prog, "u_ior"), (params.ior as number) ?? 1.5);
      gl.uniform1f(gl.getUniformLocation(prog, "u_strength"), (params.strength as number) ?? 60);
      gl.uniform1f(gl.getUniformLocation(prog, "u_disp"), (params.dispersion as number) ?? 0.4);
      gl.uniform1i(gl.getUniformLocation(prog, "u_blurEdge"), (params.blurEdge as boolean) ? 1 : 0);
      gl.uniform3f(gl.getUniformLocation(prog, "u_tint"), tint[0], tint[1], tint[2]);
      gl.uniform1f(gl.getUniformLocation(prog, "u_tintA"), tintA);

      gl.uniform1f(gl.getUniformLocation(prog, "u_fresnelFactor"), (params.fresnelFactor as number) ?? 1);
      gl.uniform1f(gl.getUniformLocation(prog, "u_fresnelRange"), (params.fresnelRange as number) ?? 120);
      gl.uniform1f(gl.getUniformLocation(prog, "u_fresnelHardness"), (params.fresnelHardness as number) ?? 0);

      gl.uniform1f(gl.getUniformLocation(prog, "u_glareFactor"), (params.glareFactor as number) ?? 0.6);
      gl.uniform1f(gl.getUniformLocation(prog, "u_glareRange"), (params.glareRange as number) ?? 120);
      gl.uniform1f(gl.getUniformLocation(prog, "u_glareHardness"), (params.glareHardness as number) ?? 0);
      gl.uniform1f(gl.getUniformLocation(prog, "u_glareConvergence"), (params.glareConvergence as number) ?? 0.4);
      gl.uniform1f(gl.getUniformLocation(prog, "u_glareOpposite"), (params.glareOppositeFactor as number) ?? 0.5);
      gl.uniform1f(gl.getUniformLocation(prog, "u_glareAngle"), glareAngleRad);

      gl.uniform1i(gl.getUniformLocation(prog, "u_shapeSource"), snippet ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_shapeMode"), shapeMode);
      gl.uniform1f(gl.getUniformLocation(prog, "u_normalRadius"), normalRadius);

      // Bind the compiled SDF's per-leaf uniforms (floats / vec2s / samplers).
      // Our own samplers occupy units 0 (bg) and 1 (blur); SDF samplers start at 2.
      if (snippet) {
        let unit = 2;
        for (const u of snippet.uniforms) {
          const loc = gl.getUniformLocation(prog, u.name);
          if (!loc) continue;
          if (u.type === "float") {
            gl.uniform1f(loc, u.value as number);
          } else if (u.type === "vec2") {
            const v = u.value as [number, number];
            gl.uniform2f(loc, v[0], v[1]);
          } else {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, u.value as WebGLTexture);
            gl.uniform1i(loc, unit);
            unit++;
          }
        }
      }
    });

    if (blurred) ctx.releaseTexture(blurred.texture);
    return { primary: output };
  },
};
