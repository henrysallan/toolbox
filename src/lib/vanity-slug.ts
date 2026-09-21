// Named live links (specdocs/092126_vanity-live-links.md): the pure half.
//
// A public project can opt into a readable live URL,
//
//     /@<handle>/<slug>
//
// where <handle> is the owner's unique profile handle and <slug> is
// derived from the project title. Both are lowercase kebab-case ASCII.
// The random /live/<public_slug> link keeps working forever — the named
// link is an alias, so turning it off or renaming never breaks a link
// someone already has.
//
// The rules here mirror the DB constraints in
// specdocs/vanity-live-links-migration.sql (is_valid_handle,
// projects_vanity_slug_valid). Keep them in sync: the client validates
// for instant feedback, the DB is the authority.

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;
export const VANITY_SLUG_MAX = 64;

// Handles the URL must never treat as a user. The `@` prefix already
// keeps handles out of the root route namespace (/p, /live, /docs …),
// so this list is about brand / support impersonation, not routing.
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "toolbox",
  "admin",
  "administrator",
  "support",
  "help",
  "staff",
  "team",
  "official",
  "brex",
  "root",
  "system",
  "moderator",
  "mod",
  "null",
  "undefined",
  "anonymous",
  "api",
  "live",
  "docs",
  "www",
]);

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Collapse any string to lowercase ASCII kebab-case: diacritics stripped
// (NFKD + drop combining marks), every other non-alphanumeric run → one
// dash, dashes trimmed from both ends. Returns "" when nothing survives.
export function kebabAscii(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Project title → URL slug, or null when the title has no usable
// characters (e.g. "★★★"). Cut at VANITY_SLUG_MAX on a dash boundary
// where possible so a long title doesn't end mid-word.
export function slugifyTitle(title: string): string | null {
  let s = kebabAscii(title);
  if (!s) return null;
  if (s.length > VANITY_SLUG_MAX) {
    const cut = s.slice(0, VANITY_SLUG_MAX);
    const lastDash = cut.lastIndexOf("-");
    s = (lastDash >= VANITY_SLUG_MAX / 2 ? cut.slice(0, lastDash) : cut).replace(
      /-+$/,
      ""
    );
  }
  return s || null;
}

export function isValidVanitySlug(slug: string): boolean {
  return (
    slug.length >= 1 && slug.length <= VANITY_SLUG_MAX && HANDLE_RE.test(slug)
  );
}

export type HandleProblem =
  | "empty"
  | "too-short"
  | "too-long"
  | "invalid-chars"
  | "reserved";

// What the user typed → the handle we'd store. Tolerates a leading "@"
// and any casing / spacing; the result is either a valid handle or a
// reason it isn't.
export function normalizeHandle(
  input: string
): { ok: true; handle: string } | { ok: false; problem: HandleProblem } {
  const raw = input.trim().replace(/^@+/, "");
  if (!raw) return { ok: false, problem: "empty" };
  const h = kebabAscii(raw);
  if (!h) return { ok: false, problem: "invalid-chars" };
  if (h.length < HANDLE_MIN) return { ok: false, problem: "too-short" };
  if (h.length > HANDLE_MAX) return { ok: false, problem: "too-long" };
  if (!HANDLE_RE.test(h)) return { ok: false, problem: "invalid-chars" };
  if (RESERVED_HANDLES.has(h)) return { ok: false, problem: "reserved" };
  return { ok: true, handle: h };
}

export function isValidHandle(handle: string): boolean {
  return normalizeHandle(handle).ok && handle === kebabAscii(handle);
}

export function describeHandleProblem(problem: HandleProblem): string {
  switch (problem) {
    case "empty":
      return "Enter a handle.";
    case "too-short":
      return `Handles need at least ${HANDLE_MIN} characters.`;
    case "too-long":
      return `Handles can be at most ${HANDLE_MAX} characters.`;
    case "invalid-chars":
      return "Use letters, numbers and dashes only.";
    case "reserved":
      return "That handle is reserved.";
  }
}

// The route segment for a handle is "@<handle>" — the "@" is what keeps
// /@hallan/orbit from ever colliding with /p, /live, /docs and friends.
export function vanityPathFor(handle: string, slug: string): string {
  return `/@${handle}/${slug}`;
}

// Route param → handle. The [handle] segment matches ANY first path
// segment Next didn't route statically, so anything without the "@"
// prefix is not ours (→ 404).
export function handleFromSegment(segment: string): string | null {
  let seg = segment;
  try {
    seg = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!seg.startsWith("@")) return null;
  const h = seg.slice(1);
  return HANDLE_RE.test(h) && h.length >= HANDLE_MIN && h.length <= HANDLE_MAX
    ? h
    : null;
}

// Human-readable form of the link for the settings preview:
// "toolbox.design/@hallan/orbit" (no scheme).
export function displayVanityUrl(
  origin: string | null,
  handle: string,
  slug: string
): string {
  const host = origin ? origin.replace(/^https?:\/\//, "") : "";
  return `${host}${vanityPathFor(handle, slug)}`;
}
