// Original encoded bytes for image-param bitmaps.
//
// A `file` param holds a decoded ImageBitmap, which serialize used to
// re-encode to PNG — turning a 3MB camera JPEG into ~30-40MB of base64 in
// the cloud row (riskfix-plan 070826 §3). Import paths register the source
// Blob here so save can inline the ORIGINAL bytes instead; the decoded
// bitmap keys the WeakMap, so entries die with the bitmap. Deserialize
// re-registers what it loads, keeping re-saves stable too. Paths that miss
// registration (or synthetic bitmaps like paint snapshots) fall back to the
// PNG re-encode — correctness is unchanged, only size.

const originals = new WeakMap<ImageBitmap, Blob>();

export function registerImageOriginal(bmp: ImageBitmap, source: Blob): void {
  originals.set(bmp, source);
}

export function getImageOriginal(bmp: ImageBitmap): Blob | undefined {
  return originals.get(bmp);
}
