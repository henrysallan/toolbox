// Address-bar helpers for cloud projects. Every saved row has a stable
// /p/<slug> editor URL (public and private). The live viewer stays at
// /live/<slug> and is public-only.

export function editorPathForSlug(slug: string): string {
  return `/p/${slug}`;
}

export function livePathForSlug(slug: string): string {
  return `/live/${slug}`;
}

export function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

// Rewrite `/` or `/p/...` to match the open cloud project without a
// Next navigation (loading from the grid must not remount EffectsApp).
// Leaves /docs, /live, /join, etc. alone.
export function syncProjectUrl(slug: string | null): void {
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  if (path !== "/" && !path.startsWith("/p/")) return;
  const next = slug ? editorPathForSlug(slug) : "/";
  if (path === next) return;
  window.history.replaceState(window.history.state, "", next);
}
