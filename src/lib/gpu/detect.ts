export type RendererBackend = "webgpu" | "webgl2" | "webgl" | "none";

export interface RendererCapabilities {
  backend: RendererBackend;
  webgpu: boolean;
  webgl2: boolean;
  webgl: boolean;
  adapterInfo?: GPUAdapterInfo;
  webglRenderer?: string;
  webglVendor?: string;
}

export async function detectRenderer(): Promise<RendererCapabilities> {
  const caps: RendererCapabilities = {
    backend: "none",
    webgpu: false,
    webgl2: false,
    webgl: false,
  };

  if (typeof window === "undefined") return caps;

  if ("gpu" in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        caps.webgpu = true;
        caps.adapterInfo = adapter.info;
      }
    } catch {
      // ignore
    }
  }

  const probe = document.createElement("canvas");
  const gl2 = probe.getContext("webgl2");
  if (gl2) {
    caps.webgl2 = true;
    const dbg = gl2.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      caps.webglRenderer = gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string;
      caps.webglVendor = gl2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string;
    }
  } else {
    const gl = probe.getContext("webgl") as WebGLRenderingContext | null;
    if (gl) caps.webgl = true;
  }

  caps.backend = caps.webgpu ? "webgpu" : caps.webgl2 ? "webgl2" : caps.webgl ? "webgl" : "none";
  return caps;
}
