// Tiny in-memory cache that lets the Image Generate panel hand a
// pre-decoded ImageBitmap to the node compute synchronously, without
// the compute having to fetch the URL itself. Decouples "user
// clicked a thumbnail" from "renderFrame happens to fire next".
//
// Lifetime: process-wide (browser tab). On project reload (or any
// state where the cache is cold), the compute can still fall back
// to fetching the public URL on its own.

const cache = new Map<string, ImageBitmap>();

export function setCachedImage(url: string, bitmap: ImageBitmap): void {
  const prior = cache.get(url);
  if (prior && prior !== bitmap) prior.close();
  cache.set(url, bitmap);
}

export function getCachedImage(url: string): ImageBitmap | undefined {
  return cache.get(url);
}

export function clearCachedImage(url: string): void {
  const prior = cache.get(url);
  if (prior) prior.close();
  cache.delete(url);
}
