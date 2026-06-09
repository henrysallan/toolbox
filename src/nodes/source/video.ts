import type {
  NodeDefinition,
  UvValue,
  VideoFileParamValue,
} from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";
import { pushMediaSettle, videoSeekSettle } from "@/engine/offline-settle";

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
  // True once we've successfully uploaded at least one decoded frame.
  // Lets us render the last good frame while a seek is in flight —
  // setting currentTime is async, so readyState drops to 1 until the
  // new frame decodes. Without this, sync_to_scene_time mode flickers
  // black every frame because every tick triggers a fresh seek.
  hasUploadedFrame: boolean;
  lastVideoWidth: number;
  lastVideoHeight: number;
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
  const s: VideoState = {
    videoRef: null, tex,
    hasUploadedFrame: false,
    lastVideoWidth: 0, lastVideoHeight: 0,
  };
  ctx.state[key] = s;
  return s;
}

export const videoNode: NodeDefinition = {
  type: "video-source",
  name: "Video Source",
  category: "image",
  subcategory: "generator",
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
      const dur = Math.max(0.0001, video.duration || paramFile.duration || 1);
      let target = ctx.time * speed + startOffset;
      if (params.loop) {
        target = ((target % dur) + dur) % dur;
      } else {
        target = Math.max(0, Math.min(dur - 0.0001, target));
      }
      const drift = target - video.currentTime;
      const absDrift = Math.abs(drift);

      // Hard-seek thresholds. The big one catches genuine jumps —
      // timeline scrubs, loop wrap-around, the first eval. Anything
      // smaller is corrected by playbackRate so the decoder stays on
      // the smooth continuous-playback path, which is the only way
      // browsers reliably hit 60fps on video.
      const HARD_SEEK = 0.3;
      // Soft-sync only runs while playing forward; reverse playback
      // can't be served by playbackRate so it falls back to seek.
      const wantsForward = speed > 0;

      if (ctx.offline) {
        // Deterministic offline export — the clock is stepped frame by
        // frame, NOT wall-clock, so the soft-sync playbackRate path
        // (which assumes realtime advance) would drift and snap. Always
        // pause and hard-seek to the exact target, and register a settle
        // promise so the export waits for the decode before capturing —
        // otherwise we'd record the previous frame, and two videos would
        // visibly fall out of sync.
        if (!video.paused) video.pause();
        if (absDrift > 0.005) {
          try {
            video.currentTime = target;
            pushMediaSettle(ctx, videoSeekSettle(video, target));
          } catch {
            // Metadata may be partial — next pass retries.
          }
        }
      } else if (!ctx.playing) {
        // Scene is paused — freeze the video at exactly `target` so
        // the soft-sync loop doesn't creep forward and hard-seek back
        // every ~0.3s while playback is stopped.
        if (!video.paused) video.pause();
        if (absDrift > 0.01) {
          try {
            video.currentTime = target;
          } catch {
            // Retry next eval.
          }
        }
      } else if (absDrift > HARD_SEEK || !wantsForward) {
        if (!video.paused) video.pause();
        try {
          video.currentTime = target;
        } catch {
          // Some browsers throw if metadata is partial — next frame retries.
        }
        // Leave playbackRate at the user's nominal speed for when we
        // resume soft-sync next frame.
        video.playbackRate = Math.max(0.0625, Math.abs(speed));
      } else {
        if (video.paused) {
          video.play().catch(() => {
            // Autoplay blocked until user interaction; retry next eval.
          });
        }
        // Aim to close the drift over ~1 second of wall clock. A
        // positive drift means the video is behind, so we speed up;
        // negative means we're ahead and slow down. Clamp so we never
        // pause (0) or run wildly fast.
        const correctedRate = speed * (1 + drift);
        video.playbackRate = Math.max(0.0625, Math.min(8, correctedRate));
      }
    } else {
      // Non-sync (free-running) mode. Track scene play state so pausing
      // the scene also pauses the video — otherwise a paused scene
      // would still have the video element running underneath, which
      // would surprise downstream nodes that key off video.currentTime.
      video.playbackRate = Math.max(0.0625, Math.abs(speed));
      if (!ctx.playing) {
        if (!video.paused) video.pause();
      } else if (video.paused) {
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

    // Try to upload a fresh frame if the video is in a uploadable state.
    // If it isn't (mid-seek, no decoded data yet), fall through to render
    // with whatever we last uploaded — that's much better than flashing
    // black every other frame.
    if (ready) {
      gl.bindTexture(gl.TEXTURE_2D, state.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      let uploaded = false;
      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video
        );
        uploaded = true;
      } catch {
        // Some browsers refuse the upload until the first metadata frame
        // is decoded. Keep the previous frame (if any) and try again next
        // eval rather than flashing black.
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (uploaded) {
        state.hasUploadedFrame = true;
        state.lastVideoWidth = video.videoWidth;
        state.lastVideoHeight = video.videoHeight;
      }
    }

    // If we've never managed to upload, there's no last-good frame to
    // show — clear to black and bail.
    if (!state.hasUploadedFrame) {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    // Fit math uses the dimensions of the LAST successful upload. They
    // only change when the user loads a different file, in which case
    // the next successful upload will rewrite both atomically.
    const srcW = state.lastVideoWidth;
    const srcH = state.lastVideoHeight;
    const imgAspect = srcW / srcH;
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
