# Theme modes — global light/dark + brightness trim (2026-08-02)

Devlist: "global light mode and dark mode in user preferences" + "colour
slider for adjusting the overall brightness/darkness of each mode's
background colours".

## The problem

The editor has no theme layer. Every colour is an inline hex literal in a
`style={{}}` object — **2,083 hex occurrences across 148 files**, and
essentially zero Tailwind colour classes (one `accent-blue`). There is
nothing to flip.

The saving grace is that the palette is tight. 1,377 of those occurrences
are neutrals drawn from ~54 distinct greys that cluster into an obvious
18-step ramp, and 214 of them are a single value (`#27272a`).

## The key idea — the ramp is positional, not semantic

`#27272a` is a border in 59 files and a raised surface in others. Naming it
`--tb-border` would be a lie in half its uses.

So the neutral tokens are **positional**: `--tb-n-0` (deepest) through
`--tb-n-17` (brightest). Light mode mirrors the ramp end-for-end. Because
every site keeps its *relative* position, nesting relationships survive the
flip automatically — a panel that sits one step darker than its parent in
dark mode sits one step lighter in light mode, with no per-site decisions.

That is what makes a mechanical, value-based codemod safe here.

Semantic aliases (`--tb-panel`, `--tb-border`, `--tb-text`) are defined on
top of the ramp for new code to use. Existing code keeps the positional
names the codemod produced.

## Scope

| Surface | Themed? |
| --- | --- |
| Editor chrome (panels, menus, modals, node editor, timeline, params) | yes |
| Landing modal, in-app docs | yes |
| Viewport backdrop (area around the render) | yes |
| Canvas gizmos + overlays (transform, primitive, motion path, points, gradient, spline, keyer, segment dots) | **no** — contrast is against user artwork, not the UI |
| Node tint presets (`node-tints.ts`) and any persisted value | **no** — saved into project files, where `var()` resolves nowhere |
| Socket type colours (`socketColor.ts`) | **hue-locked** — same hue both modes, lightness capped in light |
| `src/lib/live-viewer/`, `src/export-template/` | **no** — exported apps are user artifacts, not our chrome |
| `src/engine/`, `src/nodes/` | **no** — invariant #1, and these are content colours |

## Tokens

### Neutral ramp — 18 steps

Dark values are **exactly today's most-used hex at each step**, so dark mode
is visually unchanged. Near-duplicates (`#18181b` / `#1a1a1a` / `#19191c`,
all within 0.8% lightness) collapse onto one step; the difference is below
the perceptual floor.

| Token | Dark | Light | Typical role |
| --- | --- | --- | --- |
| `--tb-n-0` | `#0a0a0a` | `#f7f7f8` | app bg, sunken inputs |
| `--tb-n-1` | `#0f0f12` | `#f2f2f4` | |
| `--tb-n-2` | `#141417` | `#ededf0` | |
| `--tb-n-3` | `#18181b` | `#e8e8ec` | standard panel |
| `--tb-n-4` | `#1c1c1f` | `#e3e3e8` | |
| `--tb-n-5` | `#1f1f23` | `#dedee4` | raised row |
| `--tb-n-6` | `#232327` | `#d8d8df` | |
| `--tb-n-7` | `#27272a` | `#d2d2da` | **standard border / divider** |
| `--tb-n-8` | `#2a2a2e` | `#cbcbd4` | hover fill |
| `--tb-n-9` | `#3f3f46` | `#b4b4bf` | strong border, active pill |
| `--tb-n-10` | `#52525b` | `#9a9aa6` | disabled text |
| `--tb-n-11` | `#71717a` | `#7c7c86` | muted text |
| `--tb-n-12` | `#8a8a90` | `#63636c` | |
| `--tb-n-13` | `#a1a1aa` | `#52525b` | **secondary text / labels** |
| `--tb-n-14` | `#c7c7cc` | `#3a3a42` | |
| `--tb-n-15` | `#d4d4d8` | `#2e2e35` | |
| `--tb-n-16` | `#e5e7eb` | `#1f1f24` | **primary text** |
| `--tb-n-17` | `#fafafa` | `#131317` | emphasis text |

Steps 0–9 are *surfaces*, 10–17 are *ink*. The split matters for the
brightness trim below.

### Accents

Blues, reds, greens, ambers, violet, cyan each get a hand-picked light
counterpart — a `#1e3a8a` selection fill that reads as "deep blue on dark"
becomes `#bfdbfe` on light, and `#bfdbfe` text becomes `#1e3a8a`. Accent
pairs are listed in `theme/tokens.ts`.

Accents do **not** respond to the brightness trim; they carry meaning, and
sliding them washes out error/warning states.

### Excluded literals

`#ffffff`, `#000000`, `#fff`, `#000` are left out of the automated pass.
They have genuinely mixed roles — colour-picker gradient stops
(`linear-gradient(90deg,#000,#fff)`), param defaults (`value: "#ffffff"`),
canvas `fillStyle`, and shadow colours — so blanket substitution would
corrupt content. The ~10 real chrome uses are converted by hand.

## Brightness trim

One slider per mode (dark and light store independent values), range
`-1 … +1`, default `0`.

Applied as an **OKLCH lightness offset** — perceptually uniform, so a single
delta looks like the same amount of "lighter" at both ends of the ramp,
which a naive sRGB offset does not:

```
L' = clamp(L + d × 0.09 × w)      w = 1.00   for surfaces (n-0 … n-9)
                                  w = 0.25   for ink      (n-10 … n-17)
```

Ink *follows* the surfaces at a quarter rate rather than holding still. Text
that stays put while the background lifts starts to look pasted on; letting
it drift along keeps the pairing intact, and the contrast cost is small — in
dark mode at full lift, ink/surface separation goes 0.78 → 0.71. Chroma and
hue are untouched, so the greys stay neutral.

At `d = +1` in dark mode, `#0a0a0a` (OKLCH L 0.14) lands at 0.23 — clearly
lifted, still unmistakably dark. At `d = −1` it goes to 0.05.

## Storage & application

Follows the **`ui-font.ts` precedent** exactly: `localStorage`, not the
Supabase account prefs. It's a cosmetic per-device choice that must work
signed out and apply with no network round-trip. `useSyncExternalStore` for
the React binding, values written as CSS custom properties on
`document.documentElement`.

Key: `toolbox:theme` → `{ mode, brightness: { dark, light } }`.

Unlike `ui-font`, the theme needs a **pre-paint** apply — a wrong-mode flash
is far more jarring than a font swap. A small blocking inline script in
`app/layout.tsx` reads localStorage and stamps the tokens before first
paint. `globals.css` carries the dark ramp as the `:root` default, so the
no-JS / pre-hydration state is today's look.

## Milestones

1. `theme/tokens.ts` — ramp, accent pairs, hex→token map, OKLCH maths.
2. `theme/theme.ts` — store, apply, `useTheme()`.
3. `globals.css` default block + `layout.tsx` no-flash script.
4. Codemod `scripts/codemod-theme-tokens.mjs`, run over in-scope files.
5. Hand-fix black/white chrome sites.
6. `UserPreferencesModal` — mode segmented control + brightness slider.
7. Verify: `npm run typecheck`, `npm run lint:ratchet`, visual pass in both
   modes.

## Notes from implementation

**SVG presentation attributes take `var()` fine.** The plan assumed
`fill="#abc"` would have to become `style={{ fill: … }}`, since presentation
attributes are often described as not participating in variable
substitution. Tested in Chromium (our Electron target) and both forms
resolve identically — presentation attributes are parsed as CSS
declarations, so `var()` substitutes normally. The codemod rewrites them in
place and the extra milestone disappeared.

**Near-neutral folding is automatic.** Beyond the hexes listed in
`NEUTRAL_ALIASES`, the codemod folds any *unnamed* grey onto its nearest
ramp step by OKLCH lightness. Chroma alone can't gate this — the pale
`#f0f9ff` banner wash (C 0.0125) scores *lower* than the honest grey
`#8b8b94` (C 0.0133), and folding a pale-blue background onto the ink end of
the ramp would turn it near-black in light mode. Channel spread separates
them: tints run 13–19 apart, greys ≤ 12. Both gates apply.

**Socket colours are themed after all.** The plan listed them as untouchable
wire identity. That was half right: identity lives in the *hue*, not the
lightness, and a `#facc15` scalar label (OKLCH L 0.86) is unreadable on a
white node. So each type now carries a dark/light pair with the hue
byte-identical and light-mode lightness capped at ~0.56. `colorForSocket()`
returns a `var(--tb-s-…)` for DOM/SVG; `resolveSocketColor()` returns a
concrete hex for the two canvas-2D previews in SocketPeekPopover.

**Two things the codemod got wrong, caught in review.** Both were cases where
a colour is *data*, not presentation:

- `NODE_TINTS` — a picked tint is persisted onto the node (`state/graph.ts`
  `tint`), and `tintRgba()` parses it with a 6-digit hex regex. Tokens there
  would have been written into saved project files and fallen back to grey on
  render. Reverted to hex; the file is now excluded.
- `AutoLayoutPanel`'s `bgColor` param default — a node param handed to the
  engine, which resolves no CSS. Reverted to `#18181b`.

The general rule the codemod can't see: **if a colour can be persisted or
reaches the engine or a canvas, it must stay a literal.**

## Tint (added after first review)

A hue wash over the **greyscale tokens only**, under Appearance: nine presets
(None, Slate, Blue, Indigo, Violet, Teal, Green, Sepia, Rose) plus an
intensity slider.

Each preset is nothing but an OKLCH hue angle. Applying it sets that hue on
every neutral ramp step and pushes chroma up to `intensity × 0.045`. Because
it's a chroma edit in OKLCH, the ramp's *lightness* relationships — the thing
the whole positional design rests on — are untouched, so contrast survives
any tint.

Three details that matter:

- **Greyscale only.** Accents, socket hues and the derived `--tb-t-*` tints
  are deliberately excluded. Tinting the chrome must not quietly restyle an
  error red or repaint a wire's type.
- **Ink takes half the tint** of surfaces. Fully-tinted text fights the hue
  cast of the panel behind it and costs legibility for nothing.
- **Pale surfaces get a lower chroma ceiling** (0.03 vs 0.045). Near-white
  clips per-channel in sRGB before it can carry full chroma, and clipping
  bends the hue.

Tint is **global**, not per-mode (unlike brightness): a chosen tint is a taste
about the product, and having "sepia" evaporate on switching to light mode
would read as a bug.

`preset: "none"` leaves the ramp byte-identical, and trim + tint are applied
in a single OKLCH round-trip rather than chained — chaining quantises twice
and drifts hue on the darkest steps.

## Shadows

`SHADOWS` in `tokens.ts` holds whole `box-shadow` values per mode, not
colours. A shadow tuned for a dark UI does two jobs at once — separating the
element from its background AND reading as depth — and on a light surface the
border already does the first. Carried over unchanged, a 40%-black drop
shadow on a white panel reads as grime, so light mode gets its own tighter,
much softer value rather than a recoloured version of the dark one.

`--tb-shadow-node` (node bodies), `--tb-shadow-chip` (corner badges),
`--tb-shadow-pop` (popovers, dropdowns, the panel-kind menu).
