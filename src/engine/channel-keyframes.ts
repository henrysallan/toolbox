// Channel keyframes — `ch:<name>` animation tracks on expression channels
// (specdocs/101326_skia-target.md §3.8.1; graph-to-glsl's deferred M4).
//
// The rows of a channelSync `expr_inputs` param (GLSL Expression, Point
// Expression, SkSL Shader) hold keyframes directly, so a designer animates
// `ch("amount", …)` without wiring an Animated Value into its socket. The
// track lives in the node's AnimationMap under `ch:<channelName>`
// (conventions.ts: channelKey / parseChannelKey — why NAME, not row id, is
// written there). Everything here is pure and engine-side, shared by:
//
//   evaluator        resolveChannelKeyframes — clone-and-override before
//                    compute, wire > keyframe > row
//   param panel      channelDisplayValue — the readout at the playhead
//   EffectsApp       applyChannelListEdit — rename moves the track, removal
//                    drops it, an edit on an animated row auto-keys
//   MCP              resolveChannelKeyframeTarget / vetChannelKeyframeValue
//                    — set_keyframes / get_keyframes by channel name
//   Skia export      channelKeyframeType + channelStoredValue — the planner
//                    reads the node's own tracks (lib/skia-export/plan.ts)
//
// Kinds: scalar interpolates; color interpolates in the block's colorSpace
// (default OKLab) and is delivered in the row's STORED form — hex, alpha
// byte kept — so an animated color reaches the node exactly as a static one
// does (8 bits per channel); toggle and pick step (hold). Ramp and curve
// rows don't keyframe: their stops / points have no track type yet.

import {
  evaluateKeyframesAt,
  upsertKeyframe,
  type AnimationMap,
  type KeyframeAnimationBlock,
} from "./keyframes";
import { channelKey, colorValueToHex, parseChannelKey } from "./conventions";
import {
  channelKind,
  channelListParam,
  normalizeChannelHex,
  vetChannelValue,
} from "./expr-channels";
import type { ExprInput, NodeDefinition, ParamType, SocketValue } from "./types";

// The keyframe-engine type a row's track evaluates as, or null for the kinds
// that don't keyframe (ramp, curve). Step-only types (boolean, enum) hold.
export function channelKeyframeType(e: ExprInput): ParamType | null {
  switch (channelKind(e)) {
    case "scalar":
      return "scalar";
    case "toggle":
      return "boolean";
    case "enum":
      return "enum";
    case "color":
      return "color";
    default:
      return null;
  }
}

// Whether a wired socket value replaces the row — readChannelValue's rule
// (scalar → scalar / toggle, vec4 → color, color_ramp → ramp). The evaluator
// skips a channel's keyframes when this holds: wire > keyframe > row, and an
// animated-but-wired channel doesn't bust the node's cache every tick.
export function channelSocketWins(
  e: ExprInput,
  sock: SocketValue | undefined
): boolean {
  if (!sock) return false;
  switch (channelKind(e)) {
    case "scalar":
    case "toggle":
      return sock.kind === "scalar";
    case "color":
      return sock.kind === "vec4";
    case "ramp":
      return sock.kind === "color_ramp";
    default:
      return false;
  }
}

// An evaluated keyframe value in the row's stored form — what the panel
// would have written into `default`. Undefined when the value doesn't fit
// the kind (a track left over from a row of another kind, a junk key), and
// the caller keeps the row's own value.
export function channelStoredValue(
  e: ExprInput,
  v: unknown
): ExprInput["default"] | undefined {
  switch (channelKind(e)) {
    case "scalar":
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "toggle":
      if (typeof v === "boolean") return v;
      return typeof v === "number" && Number.isFinite(v) ? v !== 0 : undefined;
    case "enum":
      return typeof v === "string" ? v : undefined;
    case "color":
      // At a key the stored hex comes back verbatim; between keys a 0..1
      // RGBA tuple. Both land as the row's canonical hex, alpha byte kept
      // (color channels are straight-alpha vec4s — channelParamDef alpha).
      if (typeof v !== "string" && !Array.isArray(v)) return undefined;
      return normalizeChannelHex(colorValueToHex(v, "", true)) ?? undefined;
    default:
      return undefined;
  }
}

function live(
  block: KeyframeAnimationBlock | undefined
): block is KeyframeAnimationBlock {
  return !!block && block.animated && block.keyframes.length > 0;
}

// The evaluator's clone-and-override step: rows whose `ch:<name>` track is
// animated (and whose socket isn't wired with a winning value) get the
// track's value at `tick` as their `default`. Returns a NEW array (other
// rows shared) or null when nothing applied — the caller then leaves the
// params untouched and the node's fingerprint tick-free. Every row with the
// name takes the track (duplicate names share one, as they share a
// uniform).
export function resolveChannelKeyframes(
  rows: readonly ExprInput[],
  animation: AnimationMap | undefined,
  tick: number,
  sockets?: Record<string, SocketValue | undefined>
): ExprInput[] | null {
  if (!animation) return null;
  let out: ExprInput[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row.name !== "string") continue;
    const type = channelKeyframeType(row);
    if (!type) continue;
    const block = animation[channelKey(row.name)];
    if (!live(block)) continue;
    if (channelSocketWins(row, sockets?.[`in:${row.id}`])) continue;
    const stored = channelStoredValue(row, evaluateKeyframesAt(block, type, tick));
    if (stored === undefined) continue;
    out ??= rows.slice();
    out[i] = { ...row, default: stored };
  }
  return out;
}

// Panel readout for one row at `tick`: the track's value when it is
// animated, else the stored row value. Display-only — edits still patch the
// stored row (and auto-key through applyChannelListEdit).
export function channelDisplayValue(
  row: ExprInput,
  block: KeyframeAnimationBlock | undefined,
  tick: number
): ExprInput["default"] {
  const type = channelKeyframeType(row);
  if (!type || !live(block)) return row.default;
  return channelStoredValue(row, evaluateKeyframesAt(block, type, tick)) ?? row.default;
}

// ---------------------------------------------------------------------------
// Edits to the channel list (panel name field / value controls / × button,
// and MCP set_param by channel name, which writes the same list)
// ---------------------------------------------------------------------------

// Whether an edit SET a row's value. Writers replace exactly the row they
// touch ({ ...row, default }) and keep every other row's object, so a new
// object with the same name is the edited row. Its default may equal the
// stored one — a toggle clicked back to its stored state while the track
// shows the other — so an unchanged default still counts when nothing else
// on the row changed (a range edit changes min / max / softMax instead).
// Keyable kinds store primitives, so identity compares values.
function rowValueEdited(before: ExprInput, after: ExprInput): boolean {
  if (after === before || after.name !== before.name) return false;
  if (after.default !== before.default) return true;
  return (
    after.min === before.min &&
    after.max === before.max &&
    after.softMax === before.softMax &&
    after.step === before.step &&
    after.kind === before.kind &&
    after.options === before.options
  );
}

// The animation-map side of one edit to a channel list. Returns the SAME
// map when nothing changed, so the caller can skip the write.
//
//   rename   a row whose name changed carries `ch:<old>` to `ch:<new>`.
//            Not when another row kept the old name (duplicates share one
//            track — it stays with them), and never onto a name another
//            row already owns (no clobbering; the track stays parked under
//            the old name). A swap (a↔b in one edit) moves both.
//   removal  a dropped row's track goes with it (one undo restores both),
//            unless a row still answers to that name.
//   autokey  a value set on a row whose track is animated is written as a
//            key at `tick` (easeInOut — the param panel's default), in the
//            row's stored form, whether or not it differs from the stored
//            row (rowValueEdited). The caller still writes the row value
//            too, so turning animation off shows what was last set (the
//            constant round trip normal params get).
export function applyChannelListEdit(
  prev: readonly ExprInput[],
  next: readonly ExprInput[],
  animation: AnimationMap | undefined,
  tick: number
): AnimationMap | undefined {
  if (!animation) return animation;
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const nextIds = new Set(next.map((r) => r.id));
  // Another row (not `exceptId`) answered to `name` before AND after the
  // edit — it owns that name's track.
  const kept = (name: string, exceptId: string) =>
    next.some(
      (r) => r.id !== exceptId && r.name === name && prevById.get(r.id)?.name === name
    );
  let out: AnimationMap | null = null;
  const edit = () => (out ??= { ...animation });

  for (const r of prev) {
    if (nextIds.has(r.id)) continue;
    const k = channelKey(r.name);
    // By name: a list replaced wholesale (an Option-linked edit copying
    // another node's rows, new ids, same names) keeps its tracks.
    if (!(k in animation) || next.some((x) => x.name === r.name)) continue;
    delete edit()[k];
  }

  // Reads come from the ORIGINAL map, so a swap moves both tracks.
  const moves: { from: string; to: string; block: KeyframeAnimationBlock }[] = [];
  for (const r of next) {
    const before = prevById.get(r.id);
    if (!before || before.name === r.name) continue;
    const from = channelKey(before.name);
    const block = animation[from];
    if (!block) continue;
    if (kept(before.name, r.id) || kept(r.name, r.id)) continue;
    moves.push({ from, to: channelKey(r.name), block });
  }
  for (const m of moves) delete edit()[m.from];
  for (const m of moves) edit()[m.to] = m.block;

  for (const r of next) {
    const before = prevById.get(r.id);
    if (!before || !rowValueEdited(before, r)) continue;
    if (!channelKeyframeType(r)) continue;
    const k = channelKey(r.name);
    const blk = (out ?? animation)[k];
    if (!blk?.animated) continue;
    const stored = channelStoredValue(r, r.default);
    if (stored === undefined) continue;
    edit()[k] = upsertKeyframe(blk, tick, stored, "easeInOut");
  }
  return out ?? animation;
}

// ---------------------------------------------------------------------------
// MCP: set_keyframes / get_keyframes by channel name
// ---------------------------------------------------------------------------

export type ChannelKeyframeTarget =
  | {
      ok: true;
      name: string;
      // The animation-map key (`ch:<name>`).
      key: string;
      row: ExprInput;
      type: ParamType;
      listParam: string;
    }
  | { ok: false; reason: string };

// Resolve a tool's `param` to a channel track on a channelSync node. Takes
// the channel NAME (what get_graph lists under `channels`) or the raw
// `ch:<name>` key. Null when the node has no channel list or no channel by
// that bare name — the caller reports its own "no param" error; a `ch:` key
// naming a missing channel, and ramp / curve channels, fail with a reason.
export function resolveChannelKeyframeTarget(
  def: NodeDefinition,
  params: Record<string, unknown>,
  param: string
): ChannelKeyframeTarget | null {
  const list = channelListParam(def);
  if (!list) return null;
  const explicit = parseChannelKey(param);
  const name = explicit ?? param;
  const rows = Array.isArray(params[list.name]) ? (params[list.name] as ExprInput[]) : [];
  const row = rows.find((e) => e.name === name);
  if (!row) {
    if (explicit === null) return null;
    const names = rows.map((e) => e.name).join(", ");
    return { ok: false, reason: `no channel "${name}" (channels: ${names || "none"})` };
  }
  const type = channelKeyframeType(row);
  if (!type) {
    const kind = channelKind(row);
    return {
      ok: false,
      reason:
        `channel "${name}" is a ${kind} — only ch / toggle / pick / color channels hold keyframes` +
        (kind === "ramp"
          ? "; animate a ramp by wiring a color_ramp source into its socket"
          : "; a curve has no animation path yet — edit its points with set_param"),
    };
  }
  return { ok: true, name, key: channelKey(name), row, type, listParam: list.name };
}

// Vet one keyframe value for a channel track: the set_param rules
// (vetChannelValue — scalar range clamp, pick membership, hex, toggle
// numbers ≠ 0) plus the [r, g, b, a?] tuple form color keyframes also take.
// Returns the row's stored form.
export function vetChannelKeyframeValue(
  row: ExprInput,
  value: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!channelKeyframeType(row)) {
    return { ok: false, reason: `${channelKind(row)} channels don't keyframe` };
  }
  let v = value;
  if (channelKind(row) === "color" && Array.isArray(value)) {
    const finite = value.every((n) => typeof n === "number" && Number.isFinite(n));
    if (!finite || value.length < 3 || value.length > 4) {
      return { ok: false, reason: 'expected "#rrggbb" / "#rrggbbaa" or an [r, g, b, a?] tuple in 0..1' };
    }
    v = colorValueToHex(value, "#ffffff", true);
  }
  return vetChannelValue(row, v);
}

// The row a `ch:<name>` animation key belongs to on this node (the first row
// by that name), or null: not a channel key, not a channelSync node, or the
// channel is gone (an orphaned track). Track editor labels / lane types.
export function channelRowForKey(
  def: NodeDefinition | undefined,
  params: Record<string, unknown>,
  key: string
): ExprInput | null {
  const name = parseChannelKey(key);
  const list = def ? channelListParam(def) : undefined;
  if (name === null || !list || !Array.isArray(params[list.name])) return null;
  return (params[list.name] as ExprInput[]).find((e) => e.name === name) ?? null;
}

// Channel names on a node whose rows can hold keyframes (get_keyframes'
// overview).
export function keyframableChannelNames(
  def: NodeDefinition,
  params: Record<string, unknown>
): string[] {
  const list = channelListParam(def);
  if (!list || !Array.isArray(params[list.name])) return [];
  return (params[list.name] as ExprInput[])
    .filter((e) => channelKeyframeType(e) !== null)
    .map((e) => e.name);
}
