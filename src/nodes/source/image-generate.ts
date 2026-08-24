import { OPACITY_PARAM } from "@/engine/conventions";
import type { NodeDefinition, RenderContext } from "@/engine/types";
import { getCachedImage } from "@/lib/openai/image-cache";

// AI image-generation node. Surfaces a chat interface in the param
// panel (see ImageGeneratePanel.tsx); the user types prompts, the
// node calls OpenAI's gpt-image-2 with the active user's API key
// (configured in Toolbox → User Preferences), receives images, and
// stores them in the user's private Supabase bucket.
//
// The node's output is whichever generated image is currently
// selected (referenced by `selectedImagePath`). When nothing is
// selected, the node outputs transparent.
//
// Resolution flow:
//   1. Panel selects a thumbnail → publishes to public bucket →
//      writes the public URL into `params.selectedImagePath`.
//   2. compute() reads selectedImagePath, looks up a per-node cache
//      keyed on the URL.
//   3. On a cache miss, kick off an async fetch + decode +
//      texImage2D upload, mark the cache as "loading", and emit
//      transparent for THIS frame.
//   4. When the upload finishes, fire `pipeline-bump` so the next
//      tick re-runs compute and finds the cached texture.

interface CacheEntry {
  url: string;
  texture: WebGLTexture;
  width: number;
  height: number;
  loading: boolean;
}

function ensureCache(
  ctx: RenderContext,
  nodeId: string
): { entry: CacheEntry | null; setEntry: (e: CacheEntry | null) => void } {
  const key = `image-generate:${nodeId}:cache`;
  return {
    entry: (ctx.state[key] as CacheEntry | null | undefined) ?? null,
    setEntry: (e) => {
      ctx.state[key] = e;
    },
  };
}

function disposeCache(ctx: RenderContext, nodeId: string) {
  const key = `image-generate:${nodeId}:cache`;
  const entry = ctx.state[key] as CacheEntry | null | undefined;
  if (entry?.texture) ctx.releaseTexture(entry.texture);
  delete ctx.state[key];
}

// Upload an already-decoded source (ImageBitmap or HTMLImageElement)
// straight into a fresh texture. Synchronous; returns the texture +
// dimensions or null if texture creation fails.
function uploadBitmap(
  gl: WebGL2RenderingContext,
  source: ImageBitmap | HTMLImageElement
): { texture: WebGLTexture; width: number; height: number } | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    source
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const width =
    source instanceof HTMLImageElement
      ? source.naturalWidth
      : source.width;
  const height =
    source instanceof HTMLImageElement
      ? source.naturalHeight
      : source.height;
  return { texture, width, height };
}

// Async-load a public Supabase URL via HTMLImageElement (with CORS),
// then upload to a texture and stamp the cache entry. Used as the
// fallback when the panel hasn't pre-stashed an ImageBitmap (e.g.
// after a fresh project load). Fires pipeline-bump on success so the
// next renderFrame picks up the texture.
function startAsyncLoad(
  ctx: RenderContext,
  nodeId: string,
  url: string
) {
  // Stamp a loading placeholder in the cache so subsequent compute
  // calls don't re-issue the load while this one is in flight.
  const placeholder: CacheEntry = {
    url,
    texture: ctx.gl.createTexture()!,
    width: 1,
    height: 1,
    loading: true,
  };
  ctx.state[`image-generate:${nodeId}:cache`] = placeholder;

  void loadImage(url)
    .then((img) => {
      const current =
        (ctx.state[`image-generate:${nodeId}:cache`] as CacheEntry | null) ??
        null;
      // Bail if the user changed selection mid-flight.
      if (!current || current.url !== url) return;
      const tex = uploadBitmap(ctx.gl, img);
      if (!tex) {
        current.loading = false;
        return;
      }
      if (current.texture) ctx.gl.deleteTexture(current.texture);
      current.texture = tex.texture;
      current.width = tex.width;
      current.height = tex.height;
      current.loading = false;
      window.dispatchEvent(new Event("pipeline-bump"));
    })
    .catch((e) => {
      console.error(
        "image-generate: failed to load selected image",
        url,
        (e as Error).message
      );
      const current =
        (ctx.state[`image-generate:${nodeId}:cache`] as CacheEntry | null) ??
        null;
      if (current) current.loading = false;
    });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

// Blit shader that copies the selected image (whatever its native
// resolution) into a canvas-sized output. Kept small + isolated so
// we can swap the cache strategy without touching the engine.
const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  outColor = texture(u_src, vec2(v_uv.x, 1.0 - v_uv.y));
}`;

export const imageGenerateNode: NodeDefinition = {
  type: "image-generate",
  name: "Image Generate",
  category: "image",
  subcategory: "generator",
  description:
    "Generate images via OpenAI's gpt-image-2 with a chat interface in the param panel. Bring-your-own OpenAI key (Toolbox → User Preferences). Three optional reference image inputs feed the model as context. Outputs the currently-selected generation, or transparent when none is selected.",
  backend: "webgl2",
  // Async external service + per-node session store — live external
  // state. Time Offset boundary-feeds the selected image through
  // un-shifted.
  retimeable: false,
  inputs: [
    { name: "ref_a", label: "Ref A", type: "image", required: false },
    { name: "ref_b", label: "Ref B", type: "image", required: false },
    { name: "ref_c", label: "Ref C", type: "image", required: false },
  ],
  params: [
    OPACITY_PARAM,
    {
      name: "size",
      label: "Size",
      type: "enum",
      options: [
        "auto",
        "1024x1024",
        "1536x1024",
        "1024x1536",
        "2048x2048",
        "3840x2160",
      ],
      default: "1024x1024",
    },
    {
      name: "quality",
      label: "Quality",
      type: "enum",
      options: ["auto", "low", "medium", "high"],
      default: "auto",
    },
    {
      name: "format",
      label: "Format",
      type: "enum",
      options: ["png", "jpeg", "webp"],
      default: "png",
    },
    {
      name: "view",
      label: "Thumb View",
      type: "enum",
      options: ["grid", "list"],
      default: "grid",
    },
    {
      // Public-bucket URL of the selected generation. Empty string =
      // no selection (output transparent).
      name: "selectedImagePath",
      label: "Selected (path)",
      type: "string",
      default: "",
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const url = ((params.selectedImagePath as string) ?? "").trim();

    if (!url) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      // If we still hold a cached texture from a previous selection,
      // drop it now — cheap, and avoids surprising downstream nodes
      // when the user clears the selection.
      disposeCache(ctx, nodeId);
      return { primary: output };
    }

    const { entry, setEntry } = ensureCache(ctx, nodeId);
    if (!entry || entry.url !== url) {
      // URL changed (or first time). Try the synchronous fast path
      // first: the panel may have already stashed a decoded
      // ImageBitmap in the global image cache — if so we can
      // upload it to a texture this frame and blit, no async
      // round-trip needed. (This is the path the click flow takes.)
      if (entry?.texture) ctx.releaseTexture(entry.texture);
      const cachedBitmap = getCachedImage(url);
      if (cachedBitmap) {
        const tex = uploadBitmap(ctx.gl, cachedBitmap);
        if (tex) {
          const ready: CacheEntry = {
            url,
            texture: tex.texture,
            width: tex.width,
            height: tex.height,
            loading: false,
          };
          setEntry(ready);
          // Fall through to blit below.
        } else {
          // Texture creation failed — fall back to the async path.
          startAsyncLoad(ctx, nodeId, url);
          ctx.clearTarget(output, [0, 0, 0, 0]);
          return { primary: output };
        }
      } else {
        // Cold cache (e.g. project just reloaded) — kick off the
        // async fetch fallback and emit transparent for now.
        startAsyncLoad(ctx, nodeId, url);
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }
    } else if (entry.loading) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    // Re-read entry after the potential synchronous upload above.
    const ready = (ctx.state[
      `image-generate:${nodeId}:cache`
    ] as CacheEntry | null);
    if (!ready || ready.loading) {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const prog = ctx.getShader("image-generate/blit", BLIT_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ready.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    disposeCache(ctx, nodeId);
  },
};
