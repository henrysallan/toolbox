// check-vanity-slug: the pure half of named live links
// (specdocs/092126_vanity-live-links.md) — the title → slug and typed
// text → handle rules the settings UI validates with, and that the DB
// constraints in specdocs/vanity-live-links-migration.sql mirror.
//
//   - slugifyTitle lowercases, strips diacritics, collapses punctuation /
//     spaces to single dashes, trims dashes, caps at VANITY_SLUG_MAX on a
//     dash boundary, and returns null when nothing usable survives.
//   - normalizeHandle tolerates "@" and casing, enforces 3–32 chars,
//     letters / digits / dashes with no leading or trailing dash, and the
//     reserved list.
//   - handleFromSegment accepts only "@<valid handle>" route segments (the
//     [handle] route catches every unrouted two-segment URL, so anything
//     else must 404) and decodes %40.
//   - Every reserved handle is itself well-formed (so the reserved check,
//     not the shape check, is what rejects it).
//
//   npx tsx scripts/check-vanity-slug.mts

import {
  HANDLE_MAX,
  RESERVED_HANDLES,
  VANITY_SLUG_MAX,
  displayVanityUrl,
  handleFromSegment,
  isValidHandle,
  isValidVanitySlug,
  kebabAscii,
  normalizeHandle,
  slugifyTitle,
  vanityPathFor,
} from "@/lib/vanity-slug";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// --- slugifyTitle ---------------------------------------------------------

check("slug: plain title", slugifyTitle("Orbit") === "orbit");
check("slug: spaces → dashes", slugifyTitle("Brex Logo Loop") === "brex-logo-loop");
check(
  "slug: punctuation collapses",
  slugifyTitle("  Hello,   World!! (v2) ") === "hello-world-v2",
  String(slugifyTitle("  Hello,   World!! (v2) "))
);
check("slug: diacritics stripped", slugifyTitle("Café Ünïcode") === "cafe-unicode");
check("slug: underscores → dashes", slugifyTitle("my_project_v3") === "my-project-v3");
check("slug: nothing usable → null", slugifyTitle("★★★") === null);
check("slug: empty → null", slugifyTitle("") === null);
check("slug: dash soup → null", slugifyTitle("---") === null);
{
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  const s = slugifyTitle(long);
  check("slug: long title capped", !!s && s.length <= VANITY_SLUG_MAX, String(s?.length));
  check("slug: cap lands on a word boundary", !!s && !s.endsWith("-") && /word\d+$/.test(s), s ?? "");
  check("slug: capped slug is valid", !!s && isValidVanitySlug(s));
}
{
  const s = slugifyTitle("a".repeat(100));
  check("slug: one long word hard-cuts", s === "a".repeat(VANITY_SLUG_MAX));
}
check("slug: every slugified title validates", ["Orbit", "x", "A B C", "2024"].every((t) => {
  const s = slugifyTitle(t);
  return s !== null && isValidVanitySlug(s);
}));
check("validSlug: rejects leading dash", !isValidVanitySlug("-abc"));
check("validSlug: rejects uppercase", !isValidVanitySlug("Abc"));
check("validSlug: single char ok", isValidVanitySlug("a"));

// --- normalizeHandle -----------------------------------------------------

{
  const r = normalizeHandle("@Hallan");
  check("handle: strips @ and lowercases", r.ok && r.handle === "hallan");
}
{
  const r = normalizeHandle("  h a l l a n  ");
  check("handle: spaces → dashes", r.ok && r.handle === "h-a-l-l-a-n");
}
{
  const r = normalizeHandle("ab");
  check("handle: too short", !r.ok && r.problem === "too-short");
}
{
  const r = normalizeHandle("a".repeat(HANDLE_MAX + 1));
  check("handle: too long", !r.ok && r.problem === "too-long");
}
{
  const r = normalizeHandle("a".repeat(HANDLE_MAX));
  check("handle: max length ok", r.ok);
}
{
  const r = normalizeHandle("");
  check("handle: empty", !r.ok && r.problem === "empty");
}
{
  const r = normalizeHandle("@@@");
  check("handle: only @ → empty", !r.ok && r.problem === "empty");
}
{
  const r = normalizeHandle("★★★★");
  check("handle: no ascii → invalid-chars", !r.ok && r.problem === "invalid-chars");
}
{
  const r = normalizeHandle("Admin");
  check("handle: reserved", !r.ok && r.problem === "reserved");
}
{
  const r = normalizeHandle("-hallan-");
  check("handle: edge dashes trimmed", r.ok && r.handle === "hallan");
}
check(
  "handle: every reserved entry is well-formed",
  [...RESERVED_HANDLES].every((h) => h === kebabAscii(h) && h.length >= 3 && h.length <= HANDLE_MAX),
  [...RESERVED_HANDLES].filter((h) => h !== kebabAscii(h) || h.length < 3).join(",")
);
check("isValidHandle: canonical form only", isValidHandle("hallan") && !isValidHandle("Hallan") && !isValidHandle("@hallan"));

// --- route segment -------------------------------------------------------

check("segment: @handle", handleFromSegment("@hallan") === "hallan");
check("segment: %40 decodes", handleFromSegment("%40hallan") === "hallan");
check("segment: no @ → null", handleFromSegment("hallan") === null);
check("segment: bare @ → null", handleFromSegment("@") === null);
check("segment: uppercase → null", handleFromSegment("@Hallan") === null);
check("segment: too short → null", handleFromSegment("@ab") === null);
check("segment: bad percent → null", handleFromSegment("%E0%A4%A") === null);
check("segment: static route names are not handles", ["p", "live", "docs", "join", "api", "auth"].every((s) => handleFromSegment(s) === null));

// --- URL builders --------------------------------------------------------

check("path: /@handle/slug", vanityPathFor("hallan", "orbit") === "/@hallan/orbit");
check(
  "display: origin without scheme",
  displayVanityUrl("https://toolbox.design", "hallan", "orbit") === "toolbox.design/@hallan/orbit"
);
check("display: no origin → path only", displayVanityUrl(null, "hallan", "orbit") === "/@hallan/orbit");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall vanity-slug checks passed");
