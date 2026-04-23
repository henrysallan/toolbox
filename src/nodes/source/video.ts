import type {
  NodeDefinition,
  UvValue,
  VideoFileParamValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Video source. Each frame: optionally sync the <video> element's clock to
// ctx.time, upload whatever's currently decoded to a GL texture, then draw
// it through the same fit math as Image Source. Texture alpha is left at
// whatever the video decoded (usually opaque); flip-Y on sample because
// <video> sits in DOM y-down but the pipeline expects y-up.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invScale;
uniform float u_letterbox;
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
  outColor = texture(u_src, vec2(s.x, 1.0 - s.y));
}`;

interface VideoState {
  videoRef: HTMLVideoElement | null;
  tex: WebGLTexture | null;
}

function ensureState(
  ctx: import("@/engine/types").RenderContext,
  nodeId: string
): VideoState {
  const key = `video-source:${nodeId}`;
  const existing = ctx.state[key] as VideoState | undefined;
  if (existing) return existing;
  const gl = ctx.gl;
  const tex = gl.createTexture();
  if (!tex) throw new Error("video-source: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const s: VideoState = { videoRef: null, tex };
  ctx.state[key] = s;
  return s;
}

export const videoNode: NodeDefinition = {
  type: "video-source",
  name: "Video Source",
  category: "source",
  description:
    "Load a video file and render its current frame. Sync the clock to scene time for deterministic playback (good for exports), or let it play on its own.",
  backend: "webgl2",
  // Always re-evaluate — video frames change over time regardless of params.
  stable: false,
  inputs: [{ name: "uv_in", label: "UV", type: "uv", required: false }],
  params: [
    { name: "file", label: "Video", type: "video_file", default: null },
    {
      name: "fit",
      label: "Fit",
      type: "enum",
      options: ["cover", "contain", "stretch"],
      default: "cover",
    },
    {
      name: "sync_to_scene_time",
      label: "Sync to scene time",
      type: "boolean",
      default: true,
    },
    {
      name: "speed",
      label: "Speed",
      type: "scalar",
      min: -4,
      max: 4,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "start_offset",
      label: "Start offset (s)",
      type: "scalar",
      min: 0,
      max: 3600,
      softMax: 60,
      step: 0.01,
      default: 0,
    },
    {
      name: "loop",
      label: "Loop",
      type: "boolean",
      default: true,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  // Mix the video element's currentTime into the fingerprint. Scene-time
  // already busts downstream caches for sync'd playback, but free-running
  // playback (sync off) advances the video clock independently — this
  // ensures downstream nodes see a fresh output whenever a new frame lands.
  fingerprintExtras(params) {
    const v = params.file as VideoFileParamValue | null | undefined;
    if (!v?.video) return "";
    return `vt:${v.video.currentTime.toFixed(4)}`;
  },

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const paramFile = params.file as VideoFileParamValue | null | undefined;
    if (!paramFile?.video) {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }
    const video = paramFile.video;
    const state = ensureState(ctx, nodeId);
    state.videoRef = video;
    video.loop = !!params.loop;

    const sync = !!params.sync_to_scene_time;
    const speed = (params.speed as number) ?? 1;
    const startOffset = (params.start_offset as number) ?? 0;

    if (sync) {
      if (!video.paused) video.pause();
      const dur = Math.max(0.0001, video.duration || paramFile.duration || 1);
      let target = ctx.time * speed + startOffset;
      if (params.loop) {
        target = ((target % dur) + dur) % dur;
      } else {
        target = Math.max(0, Math.min(dur - 0.0001, target));
      }
      // Seeking is expensive — only nudge the clock when it's meaningfully
      // off from the current decoded frame.
      if (Math.abs(video.currentTime - target) > 0.01) {
        try {
          video.currentTime = target;
        } catch {
          // Some browsers throw if metadata is partial — next frame retries.
        }
      }
    } else {
      video.playbackRate = speed;
      if (video.paused) {
        video.play().catch(() => {
          // Autoplay can be blocked until user interaction; we'll retry
          // next frame. Not fatal.
        });
      }
    }

    const gl = ctx.gl;
    const ready =
      video.readyState >= 2 /* HAVE_CURRENT_DATA */ &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    if (!ready) {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    // Texture upload — the fast path is `texImage2D` with a video element,
    // which most drivers map straight into GPU memory.
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        video
      );
    } catch {
      // Some browsers refuse the upload until the first metadata frame is
      // decoded — bail and try again next eval.
      gl.bindTexture(gl.TEXTURE_2D, null);
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Fit math identical to Image Source — aspect of decoded video vs.
    // output canvas picks cover / contain / stretch behavior.
    const imgAspect = video.videoWidth / video.videoHeight;
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

    // UV input handling (parallel to Image Source).
    const uvIn = inputs.uv_in;
    const placeholderKey = `video-source:${nodeId}:zero`;
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

    const prog = ctx.getShader("video-source/fit", FS);
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
    const key = `video-source:${nodeId}`;
    const state = ctx.state[key] as VideoState | undefined;
    if (state?.tex) ctx.gl.deleteTexture(state.tex);
    delete ctx.state[key];
    disposePlaceholderTex(ctx.gl, ctx.state, `video-source:${nodeId}:zero`);
  },
};
