// Guards the curated font loader in src/lib/fonts.ts (2026-09-23), the pure
// half — a fake FontFaceSet + <link> stand in for the browser:
//   - every curated Google family names the weights Google actually serves
//     (GOOGLE_FONT_WEIGHTS). A range wider than the axis, or any range on a
//     static family, is an HTTP 400 — that left 12 of 18 families on the
//     sans-serif fallback,
//   - readiness doesn't trust `fonts.check()` for a family nothing has
//     registered (per the spec an empty match returns true),
//   - the stylesheet lands before any `fonts.load()` (issued first, it
//     resolves with zero faces and bumped too early),
//   - a rejected weights request retries once without the axis; a failed or
//     stalled sheet stops gating (fallback, not blank) and a late one
//     re-opens the gate; a stalled face gives up the same way,
//   - static families load every shipped weight; readiness follows the
//     text's unicode subsets; faces registered first (globals.css's Inter, a
//     bundled font) and installed families never fetch,
//   - each settle bumps fontVersion and fires `pipeline-bump`, and the Text /
//     Point Labels / ASCII fingerprints move with it.
// Real network loads, the canvas raster and the export template are
// live-app questions.
//
//   npx tsx scripts/check-fonts.mts

import {
  CURATED_FONTS,
  GOOGLE_FONT_WEIGHTS,
  ensureFontLoaded,
  fontVersion,
  googleFontsHref,
  isFontReady,
  registerCustomFontFromBuffer,
  registerLocalFamilies,
} from "../src/lib/fonts.ts";
import { textNode } from "../src/nodes/source/text.ts";
import { pointLabelsNode } from "../src/nodes/effect/point-labels.ts";
import { asciiNode } from "../src/nodes/effect/ascii.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------ fake browser

type Subset = "latin" | "cyrillic";
interface Face {
  family: string;
  wmin: number;
  wmax: number;
  subset: Subset;
  status: "unloaded" | "loading" | "loaded";
  // What FontFace.family reports — CSS-connected faces may come back quoted.
  reportAs?: string;
}
const faces: Face[] = [];
const loadCalls: string[] = [];
let faceLoads: "resolve" | "hang" = "resolve";
const hung: Array<() => void> = [];

function parseFont(font: string): { weight: number; family: string } {
  const m = /^(italic )?(\d+) 16px "(.+)"$/.exec(font);
  if (!m) throw new SyntaxError(`unparseable font: ${font}`);
  return { weight: Number(m[2]), family: m[3] };
}
const subsetOf = (ch: string): Subset | null => {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x250) return "latin";
  if (cp >= 0x400 && cp <= 0x4ff) return "cyrillic";
  return null;
};
// CSS font matching, reduced: the nearest weight span, then the subsets the
// text touches.
function matching(font: string, text: string): Face[] {
  const { weight, family } = parseFont(font);
  const fam = faces.filter((f) => f.family.toLowerCase() === family.toLowerCase());
  if (fam.length === 0) return [];
  const dist = (f: Face) =>
    weight < f.wmin ? f.wmin - weight : weight > f.wmax ? weight - f.wmax : 0;
  const best = Math.min(...fam.map(dist));
  const need = new Set([...text].map(subsetOf));
  return fam.filter((f) => dist(f) === best && need.has(f.subset));
}
const fontSet = {
  check: (font: string, text = " ") =>
    matching(font, text).every((f) => f.status === "loaded"),
  load(font: string, text = " "): Promise<Face[]> {
    loadCalls.push(font);
    const m = matching(font, text);
    for (const f of m) if (f.status === "unloaded") f.status = "loading";
    const finish = () => {
      for (const f of m) f.status = "loaded";
      return m;
    };
    if (faceLoads === "hang") {
      return new Promise((resolve) => hung.push(() => resolve(finish())));
    }
    return Promise.resolve().then(finish);
  },
  forEach(cb: (face: { family: string }) => void) {
    for (const f of [...faces]) cb({ family: f.reportAs ?? f.family });
  },
  add(face: { family: string }) {
    for (const subset of ["latin", "cyrillic"] as const) {
      faces.push({ family: face.family, wmin: 400, wmax: 400, subset, status: "loaded" });
    }
  },
};

interface FakeLink {
  rel: string;
  href: string;
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
}
const links: FakeLink[] = [];
// The sheet arriving registers the faces its URL names (per weight span and
// subset), then fires `load`. `error` stands for Google's HTTP 400.
function fire(link: FakeLink, type: "load" | "error") {
  if (type === "load") {
    const [family, axis] = (new URL(link.href).searchParams.get("family") ?? "").split(":");
    const spec = axis?.startsWith("wght@") ? axis.slice(5) : "400";
    const spans = spec.includes("..")
      ? [spec.split("..").map(Number)]
      : spec.split(";").map((w) => [Number(w), Number(w)]);
    for (const [lo, hi] of spans) {
      for (const subset of ["latin", "cyrillic"] as const) {
        faces.push({ family, wmin: lo, wmax: hi, subset, status: "unloaded" });
      }
    }
  }
  for (const fn of link.listeners[type] ?? []) fn();
}

let bumps = 0;
const timers = new Map<number, () => void>();
let nextTimer = 1;
function fireTimers() {
  const fns = [...timers.values()];
  timers.clear();
  for (const fn of fns) fn();
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// Installed after the imports: fonts.ts reads the globals lazily, per call.
const g = globalThis as Record<string, unknown>;
g.window = {
  dispatchEvent: (e: Event) => {
    if (e.type === "pipeline-bump") bumps++;
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};
g.document = {
  fonts: fontSet,
  head: { appendChild: (l: FakeLink) => void links.push(l) },
  createElement: (): FakeLink => ({
    rel: "",
    href: "",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
  }),
};
g.FontFace = class {
  constructor(public family: string) {}
  load() {
    return Promise.resolve(this);
  }
};
g.setTimeout = ((fn: () => void) => {
  const id = nextTimer++;
  timers.set(id, fn);
  return id;
}) as never;
g.clearTimeout = ((id: number) => void timers.delete(id)) as never;

const last = () => links[links.length - 1];

// ------------------------------------------------------------ the table
{
  const system = CURATED_FONTS.filter((f) => !(f in GOOGLE_FONT_WEIGHTS));
  check(
    "every curated Google family has a weights entry (only the system five don't)",
    JSON.stringify(system) === '["Helvetica","Arial","Georgia","Times New Roman","Courier New"]',
    system.join(", ")
  );
  for (const [family, spec] of Object.entries(GOOGLE_FONT_WEIGHTS)) {
    let ok = false;
    if (/^\d+\.\.\d+$/.test(spec)) {
      const [lo, hi] = spec.split("..").map(Number);
      ok = lo >= 1 && hi <= 1000 && lo < hi;
    } else if (/^\d+(;\d+)*$/.test(spec)) {
      const ws = spec.split(";").map(Number);
      ok = ws.every((w, i) => w >= 1 && w <= 1000 && (i === 0 || w > ws[i - 1]));
    }
    check(`${family} weights are a valid CSS2 wght spec (${spec})`, ok);
  }
  // The request the task found rejected, and the one Google serves.
  check(
    "Playfair Display requests its real axis, not 100..900",
    googleFontsHref("Playfair Display", GOOGLE_FONT_WEIGHTS["Playfair Display"]) ===
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400..900&display=swap"
  );
  check("Bebas Neue is static 400", GOOGLE_FONT_WEIGHTS["Bebas Neue"] === "400");
  check(
    "the plain fallback request carries no axis",
    googleFontsHref("Bebas Neue") === "https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap"
  );
}

// ------------------------------------------- the check() quirk, sheet order
{
  check(
    "fake reproduces the quirk: check() is true with nothing registered",
    fontSet.check('400 16px "Playfair Display"')
  );
  check("an unfetched curated family is NOT ready", !isFontReady("Playfair Display"));
  const q = { text: "Hello" };
  const p = ensureFontLoaded("Playfair Display", q);
  check(
    "one stylesheet, with the table's weights",
    links.length === 1 &&
      links[0].href === googleFontsHref("Playfair Display", "400..900")
  );
  check("repeat calls join the in-flight load", ensureFontLoaded("Playfair Display", q) === p);
  await flush();
  check("no fonts.load() before the sheet lands", loadCalls.length === 0);
  check(
    "not ready (and no bump) while the sheet is in flight",
    !isFontReady("Playfair Display", q) && bumps === 0
  );
  const v0 = fontVersion("Playfair Display");
  fire(links[0], "load");
  await p;
  check("faces load after the sheet", loadCalls.length > 0);
  check("ready once they have", isFontReady("Playfair Display", q));
  check(
    "the settle bumped once and moved the version",
    bumps === 1 && fontVersion("Playfair Display") === v0 + 1,
    `bumps=${bumps} v=${fontVersion("Playfair Display")}`
  );
  check("a ready family resolves without new work", (await ensureFontLoaded("Playfair Display", q), links.length === 1));
}

// ------------------------------------------------------ static families
{
  const p = ensureFontLoaded("Lato", { weight: 400 });
  fire(last(), "load");
  await p;
  const lato = loadCalls.filter((f) => f.endsWith('"Lato"'));
  check(
    "a static family loads every shipped weight",
    ["100", "300", "400", "700", "900"].every((w) => lato.includes(`${w} 16px "Lato"`)),
    lato.join(" | ")
  );
  const n = loadCalls.length;
  check(
    "so a weight change is ready with no further load",
    isFontReady("Lato", { weight: 700 }) && isFontReady("Lato", { weight: 900, italic: true }) && loadCalls.length === n
  );
}

// ------------------------------------------------ rejected / failed sheets
{
  const p = ensureFontLoaded("Oswald");
  const first = last();
  fire(first, "error");
  await flush();
  const retry = last();
  check(
    "a rejected weights request retries once without the axis",
    retry !== first && retry.href === googleFontsHref("Oswald")
  );
  fire(retry, "load");
  await p;
  check("the plain retry's regular face loads", isFontReady("Oswald"));

  const b0 = bumps;
  const v0 = fontVersion("Bebas Neue");
  const pb = ensureFontLoaded("Bebas Neue");
  fire(last(), "error");
  await flush();
  fire(last(), "error");
  await pb;
  check("both requests rejected → ready on the fallback, not blank", isFontReady("Bebas Neue"));
  check("the failure bumped", bumps === b0 + 1 && fontVersion("Bebas Neue") === v0 + 1);
  const n = links.length;
  await ensureFontLoaded("Bebas Neue");
  check("a failed family doesn't re-request per eval", links.length === n);
}

// ------------------------------- registered, installed, unknown, system
{
  faces.push({ family: "Inter", wmin: 100, wmax: 900, subset: "latin", status: "unloaded", reportAs: '"Inter"' });
  const n = links.length;
  check("a registered-but-unloaded family isn't ready", !isFontReady("Inter"));
  await ensureFontLoaded("Inter");
  check("faces registered first are used — no Google fetch", links.length === n);
  check("…and are ready once fonts.load() lands them", isFontReady("Inter"));

  registerLocalFamilies(["Montserrat"]);
  check("an installed curated family is ready", isFontReady("Montserrat"));
  await ensureFontLoaded("Montserrat");
  check("an unknown family resolves by name", isFontReady("Futura PT"));
  await ensureFontLoaded("Futura PT");
  check("…neither fetches", links.length === n);
  check("a system family is ready", isFontReady("Georgia"));
}

// ------------------------------------------------------- unicode subsets
{
  const p = ensureFontLoaded("Roboto", { text: "Hello" });
  fire(last(), "load");
  await p;
  check("latin text ready", isFontReady("Roboto", { text: "Hello" }));
  check("cyrillic text waits for its own subset", !isFontReady("Roboto", { text: "Привет" }));
  const n = links.length;
  await ensureFontLoaded("Roboto", { text: "Привет" });
  check(
    "the subset loads from the same sheet",
    links.length === n && isFontReady("Roboto", { text: "Привет" })
  );
}

// ------------------------------------------------------------ timeouts
{
  const v0 = fontVersion("Merriweather");
  const p = ensureFontLoaded("Merriweather");
  const link = last();
  await flush();
  fireTimers();
  await p;
  check(
    "a stalled sheet stops gating after the timeout (fallback)",
    isFontReady("Merriweather") && fontVersion("Merriweather") === v0 + 1
  );
  fire(link, "load");
  await flush();
  check(
    "a late sheet re-opens the gate and bumps",
    !isFontReady("Merriweather") && fontVersion("Merriweather") === v0 + 2
  );
  await ensureFontLoaded("Merriweather");
  check("…and its faces then load", isFontReady("Merriweather"));

  faceLoads = "hang";
  const q = { text: "123" };
  const ps = ensureFontLoaded("Space Mono", q);
  fire(last(), "load");
  await flush();
  check("not ready while its faces download", !isFontReady("Space Mono", q));
  const vs = fontVersion("Space Mono");
  fireTimers();
  await ps;
  check(
    "a stalled face load gives up to the fallback",
    isFontReady("Space Mono", q) && fontVersion("Space Mono") === vs + 1
  );
  check(
    "text growing within the same characters stays given-up (no per-frame re-gate)",
    isFontReady("Space Mono", { text: "321123" })
  );
  for (const resolve of hung.splice(0)) resolve();
  faceLoads = "resolve";
  await flush();
  check(
    "the late face bumps again",
    fontVersion("Space Mono") === vs + 2 && isFontReady("Space Mono", { text: "9" })
  );
}

// --------------------------------------- a font registered under a curated name
{
  check("Work Sans starts as a Google family", !isFontReady("Work Sans"));
  await registerCustomFontFromBuffer(new ArrayBuffer(8), { family: "Work Sans" });
  const n = links.length;
  await ensureFontLoaded("Work Sans");
  check(
    "a bundle registered under a curated name wins — no Google fetch",
    links.length === n && isFontReady("Work Sans")
  );
}

// ------------------------------------------------------------ fingerprints
{
  const ctx = { state: {} as Record<string, unknown> } as never;
  const state = (ctx as { state: Record<string, unknown> }).state;
  const cases = [
    ["Text", () => textNode.fingerprintExtras!({ font_family: "Poppins" }, ctx, "t1"), "Poppins"],
    ["Point Labels", () => pointLabelsNode.fingerprintExtras!({ font_family: "DM Sans" }, ctx, "p1"), "DM Sans"],
    ["ASCII", () => asciiNode.fingerprintExtras!({ font_family: "Raleway" }, ctx, "a1"), "Raleway"],
  ] as const;
  for (const [label, fp, family] of cases) {
    const before = fp();
    const p = ensureFontLoaded(family);
    fire(last(), "load");
    await p;
    check(`${label} fingerprint moves when its family's load settles`, fp() !== before, `${before} → ${fp()}`);
  }
  state["text:t1"] = { family: "Nunito" };
  state["point-labels:p1"] = { family: "Nunito" };
  state["ascii:a1"] = { fontFamily: "Nunito" };
  const nunito = `font:${fontVersion("Nunito")}`;
  check(
    "each keys on the family its last compute drew (a keyframed or wired font)",
    cases.every(([, fp]) => fp() === nunito)
  );
}

// ------------------------------------------- the other gates' DOM stub
{
  g.document = { fonts: { add() {}, forEach() {} } }; // no head / check / load
  const p = ensureFontLoaded("Open Sans");
  await flush();
  await p;
  check("a stubbed DOM settles without throwing (fallback)", isFontReady("Open Sans"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall font-loader checks passed");
