import type {
  NodeDefinition,
  RenderContext,
  UvValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Webcam source. Requests getUserMedia on first eval, pipes the live
// stream into a hidden <video> element, and uploads the current frame
// to a GL texture each pipeline pass. Same compositing path as Video
// Source (fit enum + UV input + letterbox math) so downstream nodes
// don't care that it's a live feed vs a file.
//
// Frame freshness: requestVideoFrameCallback (Chrome/Safari) or
// `timeupdate` (Firefox fallback) dispatches a `pipeline-bump` event
// whenever the <video> element decodes a new frame — that's what
// triggers the evaluator to re-run the graph at ~30fps even when
// scene time is paused. The node itself is `stable: false` so its
// fingerprint changes each tick and downstream caches bust cleanly.
//
// First compute after creation returns black while the permission
// prompt resolves. Denied access also returns black (with a console
// warning) so the rest of the graph keeps running.

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
uniform float u_mirror; // 1.0 to flip the sampling X axis
uniform int u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2 u_uvConst;
out vec4 outColor;

void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  vec2 s = 0.5 + (uv - 0.5) * u_invScale;
  if (u_letterbox > 0.5 && (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // DOM <video> element is y-down; flip to match the pipeline's y-up
  // convention. Optionally mirror the X axis so the webcam feed reads
  // as a mirror (the default — matches every videoconferencing tool).
  float sx = (u_mirror > 0.5) ? (1.0 - s.x) : s.x;
  outColor = texture(u_src, vec2(sx, 1.0 - s.y));
}`;

interface WebcamState {
  video: HTMLVideoElement | null;
  stream: MediaStream | null;
  tex: WebGLTexture | null;
  // Latch: we request the webcam once. Subsequent computes read the
  // pending promise's result via state.video/stream.
  requested: boolean;
  facing: string;
  error: string | null;
  rvfcHandle: number;
  timeupdateHandler: (() => void) | null;
}

function stateKey(nodeId: string): string {
  return `webcam-source:${nodeId}`;
}

function ensureState(ctx: RenderContext, nodeId: string): WebcamState {
  const key = stateKey(nodeId);
  const existing = ctx.state[key] as WebcamState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("webcam-source: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: WebcamState = {
    video: null,
    stream: null,
    tex,
    requested: false,
    facing: "",
    error: null,
    rvfcHandle: 0,
    timeupdateHandler: null,
  };
  ctx.state[key] = s;
  return s;
}

// Start the webcam stream and wire up per-frame bumps. Async — caller
// returns early on the first few evals while getUserMedia resolves.
async function startWebcam(state: WebcamState, facing: string) {
  if (!navigator.mediaDevices?.getUserMedia) {
    state.error = "Webcam not available in this browser";
    return;
  }
  try {
    const constraints: MediaStreamConstraints = {
      video:
        facing === "environment"
          ? { facingMode: { ideal: "environment" } }
          : { facingMode: { ideal: "user" } },
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    await video.play().catch(() => {
      /* autoplay can be blocked until first user gesture; retry later */
    });
    state.video = video;
    state.stream = stream;
    state.facing = facing;
    state.error = null;

    // Frame-accurate bump: requestVideoFrameCallback fires exactly
    // when a new frame is decoded. Same pattern lib/video.ts uses for
    // uploaded files — gives clean, jitter-free updates at whatever
    // rate the camera delivers.
    type RVFC = (cb: (now: number) => void) => number;
    const rvfc = (
      video as unknown as { requestVideoFrameCallback?: RVFC }
    ).requestVideoFrameCallback;
    const dispatch = () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("pipeline-bump"));
      }
    };
    if (rvfc) {
      const loop = () => {
        if (!state.video) return;
        state.rvfcHandle = rvfc.call(video, loop);
        dispatch();
      };
      state.rvfcHandle = rvfc.call(video, loop);
    } else {
      // Firefox lacks requestVideoFrameCallback — fall back to the
      // timeupdate event (~4Hz but alive).
      const h = () => dispatch();
      video.addEventListener("timeupdate", h);
      state.timeupdateHandler = h;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn("Webcam getUserMedia failed:", state.error);
    window.dispatchEvent(new Event("pipeline-bump"));
  }
}

function stopWebcam(state: WebcamState) {
  if (state.timeupdateHandler && state.video) {
    state.video.removeEventListener("timeupdate", state.timeupdateHandler);
    state.timeupdateHandler = null;
  }
  if (state.video) {
    try {
      state.video.pause();
    } catch {
      // ignore
    }
    state.video.srcObject = null;
    state.video = null;
  }
  if (state.stream) {
    for (const t of state.stream.getTracks()) {
      try {
        t.stop();
      } catch {
        // ignore
      }
    }
    state.stream = null;
  }
  state.requested = false;
}

export const webcamSourceNode: NodeDefinition = {
  type: "webcam-source",
  name: "Webcam Source",
  category: "image",
  subcategory: "generator",
  description:
    "Live webcam feed via getUserMedia. First eval triggers the browser permission prompt. Mirror toggle defaults on to match how video-chat tools render the feed.",
  backend: "webgl2",
  stable: false,
  inputs: [{ name: "uv_in", label: "UV", type: "uv", required: false }],
  params: [
    {
      name: "facing",
      label: "Facing",
      type: "enum",
      options: ["user", "environment"],
      default: "user",
    },
    {
      name: "fit",
      label: "Fit",
      type: "enum",
      options: ["cover", "contain", "stretch"],
      default: "cover",
    },
    {
      name: "mirror",
      label: "Mirror",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const state = ensureState(ctx, nodeId);
    const facing = (params.facing as string) ?? "user";

    // Lazy request + refresh on facing change. Switching facing tears
    // down the existing stream and reopens with the new constraint.
    if (!state.requested) {
      state.requested = true;
      startWebcam(state, facing);
    } else if (state.facing && state.facing !== facing && state.video) {
      stopWebcam(state);
      state.requested = true;
      startWebcam(state, facing);
    }

    const video = state.video;
    const ready =
      !!video &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    if (!ready) {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    // Texture upload — fast path: texImage2D with a video element.
    const gl = ctx.gl;
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video!
      );
    } catch {
      // Some browsers briefly refuse the upload right after stream
      // init — bail and retry next eval.
      gl.bindTexture(gl.TEXTURE_2D, null);
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Fit math — same as Image / Video source.
    const imgAspect = video!.videoWidth / video!.videoHeight;
    const outAspect = output.width / output.height;
    const alpha = imgAspect / outAspect;
    const fit = (params.fit as string) ?? "cover";
    let invScale: [number, number];
    let letterbox = 0;
    if (fit === "stretch") {
      invScale = [1, 1];
    } else if (fit === "cover") {
      invScale = alpha > 1 ? [1 / alpha, 1] : [1, alpha];
    } else {
      invScale = alpha > 1 ? [1, alpha] : [1 / alpha, 1];
      letterbox = 1;
    }

    // UV input (parallel to Image / Video source).
    const uvIn = inputs.uv_in;
    const placeholderKey = `webcam-source:${nodeId}:zero`;
    let uvInMode = 0;
    let uvInTex: WebGLTexture = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      placeholderKey
    );
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = (uvIn as UvValue).texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    const mirror = params.mirror === false ? 0 : 1;

    const prog = ctx.getShader("webcam-source/fit", FS);
    ctx.drawFullscreen(prog, output, (gl2) => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_2D, state.tex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_src"), 0);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_invScale"),
        invScale[0],
        invScale[1]
      );
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_letterbox"), letterbox);
      gl2.uniform1f(gl2.getUniformLocation(prog, "u_mirror"), mirror);

      gl2.activeTexture(gl2.TEXTURE1);
      gl2.bindTexture(gl2.TEXTURE_2D, uvInTex);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_uvIn"), 1);
      gl2.uniform1i(gl2.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl2.uniform2f(
        gl2.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    const key = stateKey(nodeId);
    const state = ctx.state[key] as WebcamState | undefined;
    if (state) {
      stopWebcam(state);
      if (state.tex) ctx.gl.deleteTexture(state.tex);
    }
    delete ctx.state[key];
    disposePlaceholderTex(ctx.gl, ctx.state, `webcam-source:${nodeId}:zero`);
  },
};
