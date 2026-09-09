/* Types for the patched ESM glue over @visioncortex/vtracer's wasm-bindgen
   nodejs build (src/wasm/vtracer/vtracer.js). */

export function vectorize_bytes(data: Uint8Array, options?: unknown): string;
export function vectorize_rgba(
  data: Uint8Array,
  width: number,
  height: number,
  options?: unknown
): string;
export function initSync(module: BufferSource | WebAssembly.Module): unknown;
export default function init(
  module_or_path?:
    | string
    | URL
    | Request
    | BufferSource
    | Promise<Response>
    | { module_or_path?: unknown }
): Promise<unknown>;
