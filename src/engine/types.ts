export type SocketType = "image" | "mask" | "scalar" | "vec2" | "vec3" | "vec4";

export type ImageValue = {
  kind: "image";
  texture: WebGLTexture;
  width: number;
  height: number;
};

export type MaskValue = {
  kind: "mask";
  texture: WebGLTexture;
  width: number;
  height: number;
};

export type ScalarValue = { kind: "scalar"; value: number };
export type Vec2Value = { kind: "vec2"; value: [number, number] };
export type Vec3Value = { kind: "vec3"; value: [number, number, number] };
export type Vec4Value = {
  kind: "vec4";
  value: [number, number, number, number];
};

export type SocketValue =
  | ImageValue
  | MaskValue
  | ScalarValue
  | Vec2Value
  | Vec3Value
  | Vec4Value;

export interface NodeOutput {
  primary?: SocketValue;
  aux?: Record<string, SocketValue>;
}

export interface InputSocketDef {
  name: string;
  label?: string;
  type: SocketType;
  required: boolean;
  defaultValue?: SocketValue;
}

export interface OutputSocketDef {
  name: string;
  type: SocketType;
  description?: string;
}

export type ParamType =
  | "scalar"
  | "vec2"
  | "vec3"
  | "vec4"
  | "color"
  | "boolean"
  | "enum"
  | "string"
  | "file"
  | "paint"
  | "merge_layers"
  | "color_ramp"
  | "curves";

export interface PaintParamValue {
  canvas: HTMLCanvasElement;
  snapshot: ImageBitmap | null;
}

export interface ParamDef {
  name: string;
  label?: string;
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  // Soft upper bound for scalar sliders. When present the range input caps
  // here, but the number input and stored value are only bounded by `max`
  // (or unbounded if `max` is absent). Useful for params with a "normal"
  // working range and an escape hatch for extreme values.
  softMax?: number;
  default: unknown;
  options?: string[];
  // Placeholder text for string-type params when the value is empty.
  placeholder?: string;
  hidden?: boolean;
  // Optional predicate over the node's current params. Returning false hides
  // the row in the UI without affecting the underlying stored value.
  visibleIf?: (params: Record<string, unknown>) => boolean;
}

export interface ComputeArgs {
  inputs: Record<string, SocketValue | undefined>;
  auxIn: Record<string, Record<string, SocketValue | undefined>>;
  params: Record<string, unknown>;
  ctx: RenderContext;
  nodeId: string;
}

export interface NodeDefinition {
  type: string;
  name: string;
  category: string;
  description?: string;
  backend: "webgl2";
  terminal?: boolean;
  // When false, the evaluator will not cache this node's output — it is
  // assumed to read time or other external state that isn't captured by its
  // params/inputs fingerprint. Defaults to true (cacheable).
  stable?: boolean;
  inputs: InputSocketDef[];
  // Optional: derive the active input socket list from params (for nodes with
  // a user-extensible number of inputs). Falls back to static `inputs`.
  resolveInputs?: (params: Record<string, unknown>) => InputSocketDef[];
  params: ParamDef[];
  primaryOutput: SocketType | null;
  auxOutputs: OutputSocketDef[];
  consumes?: string[];
  init?: (ctx: RenderContext, nodeId: string) => void;
  compute: (args: ComputeArgs) => NodeOutput | void;
  dispose?: (ctx: RenderContext, nodeId: string) => void;
}

export interface RenderContext {
  gl: WebGL2RenderingContext;
  width: number;
  height: number;
  time: number;
  frame: number;
  state: Record<string, unknown>;
  allocImage(opts?: { width?: number; height?: number }): ImageValue;
  allocMask(opts?: { width?: number; height?: number }): MaskValue;
  releaseTexture(tex: WebGLTexture | null | undefined): void;
  drawFullscreen(
    program: WebGLProgram,
    target: ImageValue | MaskValue | null,
    setup?: (gl: WebGL2RenderingContext) => void
  ): void;
  clearTarget(
    target: ImageValue | MaskValue,
    rgba?: [number, number, number, number]
  ): void;
  getShader(key: string, fragSrc: string): WebGLProgram;
  blitToCanvas(image: ImageValue, targetCanvas: HTMLCanvasElement): void;
}
