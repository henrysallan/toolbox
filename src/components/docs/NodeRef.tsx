"use client";

import { useMemo } from "react";
import { allNodeDefs } from "@/engine/registry";
import { registerAllNodes } from "@/nodes";
import type {
  NodeCategory,
  NodeDefinition,
  NodeSubcategory,
  ParamDef,
} from "@/engine/types";
import { H1, H2, H3, Lede, P, Code, Note } from "./DocPage";
import type { TocItem } from "@/lib/docs/manifest";

// Populate the registry on module load so docs routes work even
// when EffectsApp hasn't mounted (cold navigation to /docs).
// Idempotent — safe to call alongside EffectsApp's own call.
registerAllNodes();

// Renders an entire category's worth of nodes as a single page.
// Pulls live definitions from the registry so the reference can't
// drift from the code — a new node registered anywhere shows up
// here automatically.

const SUB_ORDER: NodeSubcategory[] = ["generator", "modifier", "utility"];
const SUB_LABEL: Record<NodeSubcategory, string> = {
  generator: "Generators",
  modifier: "Modifiers",
  utility: "Utilities",
};

const CATEGORY_TITLE: Record<NodeCategory, string> = {
  image: "Image nodes",
  spline: "Spline nodes",
  point: "Point nodes",
  audio: "Audio nodes",
  utility: "Utility nodes",
  effect: "Effect nodes",
  output: "Output nodes",
};

// Nodes hidden from the menus stay out of the reference too — they
// can't be added directly and the compound entries that replace them
// live elsewhere. Mirrors the filter in NodeBrowserDropdown.
const HIDDEN_TYPES: ReadonlySet<string> = new Set([
  "simulation-start",
  "simulation-end",
  // Back-compat aliases — same def under two type keys, don't
  // double-list.
  "perlin-noise",
  "uv-coords",
]);

export default function NodeCategoryPage({
  category,
  intro,
}: {
  category: NodeCategory;
  intro?: React.ReactNode;
}) {
  const defs = useMemo(() => {
    return allNodeDefs().filter(
      (d) => d.category === category && !HIDDEN_TYPES.has(d.type)
    );
  }, [category]);

  // Group by subcategory for typed categories; flat for the rest.
  const typed = category !== "utility" && category !== "effect" && category !== "output";
  const grouped = useMemo(() => {
    if (!typed) return null;
    const m: Partial<Record<NodeSubcategory, NodeDefinition[]>> = {};
    for (const d of defs) {
      const sub = d.subcategory ?? "utility";
      (m[sub] ??= []).push(d);
    }
    for (const list of Object.values(m))
      list?.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [defs, typed]);

  const flat = useMemo(() => {
    if (typed) return [];
    return [...defs].sort((a, b) => a.name.localeCompare(b.name));
  }, [defs, typed]);

  return (
    <>
      <H1>{CATEGORY_TITLE[category]}</H1>
      {intro ?? <CategoryIntro category={category} />}
      {typed && grouped
        ? SUB_ORDER.filter((s) => grouped[s]?.length).map((sub) => (
            <section key={sub}>
              <H2>{SUB_LABEL[sub]}</H2>
              {grouped[sub]!.map((def) => (
                <NodeCard key={def.type} def={def} />
              ))}
            </section>
          ))
        : flat.map((def) => <NodeCard key={def.type} def={def} />)}
      {defs.length === 0 && (
        <Note>
          No nodes in this category yet — check back after the next
          release.
        </Note>
      )}
    </>
  );
}

// Fallback blurb per category when the page author hasn't passed
// their own `intro`. Kept short; each page can override.
function CategoryIntro({ category }: { category: NodeCategory }) {
  const blurbs: Record<NodeCategory, string> = {
    image:
      "Nodes whose primary output is a raster image — sources that generate pixels, and modifiers that transform them.",
    spline:
      "Vector geometry — splines, shapes, and path operations. Most outputs here are `spline` values that downstream nodes can resample, stroke, or sample along.",
    point:
      "Point clouds. Sources generate position sets; modifiers transform them; `copy-to-points` lets you instance any type per point.",
    audio:
      "Audio sources. Their amplitude can be piped into any scalar socket for audio-reactive effects.",
    utility:
      "Cross-type helpers: scalar math, vec2 packing, grouping, arraying, and polymorphic transforms that work on image / spline / point inputs.",
    effect:
      "Compound effects that don't fit cleanly into a single data type. Simulation zones live here.",
    output:
      "Terminal nodes. Whatever plugs into the Output node is what shows up on the preview canvas and in your exports.",
  };
  return <Lede>{blurbs[category]}</Lede>;
}

// ------------------------------------------------------------------
// A single node entry: header, description, params, sockets.
// ------------------------------------------------------------------

function NodeCard({ def }: { def: NodeDefinition }) {
  // Snapshot the resolved sockets using default params — good enough
  // for the reference, and the "polymorphic" hint flags anything
  // whose shape actually changes at runtime.
  const defaults: Record<string, unknown> = {};
  for (const p of def.params) defaults[p.name] = p.default;
  const inputs = def.resolveInputs?.(defaults) ?? def.inputs;
  const auxOutputs = def.resolveAuxOutputs?.(defaults) ?? def.auxOutputs;
  const primary =
    def.resolvePrimaryOutput?.(defaults) ?? def.primaryOutput ?? null;
  const polymorphic =
    !!def.resolveInputs ||
    !!def.resolveAuxOutputs ||
    !!def.resolvePrimaryOutput;

  // Visible-only params in their default state — hidden ones don't
  // show in the editor UI, so they shouldn't show in the reference.
  const visibleParams = def.params.filter((p) => {
    if (p.hidden) return false;
    return p.visibleIf?.(defaults) ?? true;
  });

  return (
    <article
      style={{
        border: "1px solid #27272a",
        borderRadius: 4,
        padding: "14px 16px",
        background: "#111113",
        margin: "0 0 16px",
      }}
      id={def.type}
    >
      {/* Anchor lives on the <article> wrapper above — don't
          duplicate it on the H3 (would be invalid HTML and the
          copy-link chip would race the outer anchor). */}
      <H3>{def.name}</H3>
      <div
        style={{
          color: "#71717a",
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          marginTop: -4,
          marginBottom: 10,
        }}
      >
        <Code>{def.type}</Code>
        {polymorphic && (
          <span style={{ marginLeft: 8, color: "#a78bfa" }}>
            polymorphic
          </span>
        )}
      </div>
      {def.description && <P>{def.description}</P>}

      {visibleParams.length > 0 && (
        <>
          <ColumnLabel>Parameters</ColumnLabel>
          <ParamTable params={visibleParams} />
        </>
      )}

      <ColumnLabel>Sockets</ColumnLabel>
      <SocketTable
        inputs={inputs.map((i) => ({
          name: i.name,
          label: i.label,
          type: i.type,
          required: i.required,
        }))}
        primary={primary}
        aux={auxOutputs.map((a) => ({
          name: a.name,
          type: a.type,
        }))}
      />
    </article>
  );
}

function ColumnLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: "#a1a1aa",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        margin: "14px 0 6px",
        fontFamily: "ui-monospace, monospace",
      }}
    >
      {children}
    </div>
  );
}

function ParamTable({ params }: { params: ParamDef[] }) {
  return (
    <div
      style={{
        border: "1px solid #27272a",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <Row header>
        <Cell width={180}>Name</Cell>
        <Cell width={120}>Type</Cell>
        <Cell>Default</Cell>
      </Row>
      {params.map((p) => (
        <Row key={p.name}>
          <Cell width={180}>
            <div style={{ color: "#e5e7eb" }}>
              {p.label ?? p.name}
            </div>
            <div
              style={{
                color: "#52525b",
                fontSize: 11,
                fontFamily: "ui-monospace, monospace",
              }}
            >
              {p.name}
            </div>
          </Cell>
          <Cell width={120}>
            <TypePill type={p.type} />
            {p.type === "scalar" && (p.min !== undefined || p.max !== undefined) && (
              <div
                style={{
                  color: "#52525b",
                  fontSize: 11,
                  fontFamily: "ui-monospace, monospace",
                  marginTop: 2,
                }}
              >
                {formatRange(p)}
              </div>
            )}
          </Cell>
          <Cell>
            <code
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
                color: "#d4d4d8",
              }}
            >
              {formatDefault(p)}
            </code>
            {p.type === "enum" && p.options && (
              <div
                style={{
                  color: "#71717a",
                  fontSize: 11,
                  marginTop: 3,
                }}
              >
                {p.options.join(" · ")}
              </div>
            )}
          </Cell>
        </Row>
      ))}
    </div>
  );
}

function SocketTable({
  inputs,
  primary,
  aux,
}: {
  inputs: Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
  }>;
  primary: string | null;
  aux: Array<{ name: string; type: string }>;
}) {
  return (
    <div
      style={{
        border: "1px solid #27272a",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <Row header>
        <Cell width={120}>Direction</Cell>
        <Cell width={180}>Name</Cell>
        <Cell>Type</Cell>
      </Row>
      {inputs.length === 0 && primary === null && aux.length === 0 ? (
        <Row>
          <Cell>—</Cell>
          <Cell>(no sockets)</Cell>
          <Cell></Cell>
        </Row>
      ) : (
        <>
          {inputs.map((inp) => (
            <Row key={`in-${inp.name}`}>
              <Cell width={120}>
                <span style={{ color: "#93c5fd" }}>input</span>
                {inp.required && (
                  <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>
                )}
              </Cell>
              <Cell width={180}>
                <div style={{ color: "#e5e7eb" }}>
                  {inp.label ?? inp.name}
                </div>
                <div
                  style={{
                    color: "#52525b",
                    fontSize: 11,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  {inp.name}
                </div>
              </Cell>
              <Cell>
                <TypePill type={inp.type} />
              </Cell>
            </Row>
          ))}
          {primary && (
            <Row>
              <Cell width={120}>
                <span style={{ color: "#86efac" }}>output</span>{" "}
                <span style={{ color: "#71717a", fontSize: 10 }}>primary</span>
              </Cell>
              <Cell width={180}>
                <div style={{ color: "#e5e7eb" }}>out</div>
              </Cell>
              <Cell>
                <TypePill type={primary} />
              </Cell>
            </Row>
          )}
          {aux.map((a) => (
            <Row key={`aux-${a.name}`}>
              <Cell width={120}>
                <span style={{ color: "#86efac" }}>output</span>{" "}
                <span style={{ color: "#71717a", fontSize: 10 }}>aux</span>
              </Cell>
              <Cell width={180}>
                <div style={{ color: "#e5e7eb" }}>{a.name}</div>
              </Cell>
              <Cell>
                <TypePill type={a.type} />
              </Cell>
            </Row>
          ))}
        </>
      )}
    </div>
  );
}

// Minimal table primitives so the NodeRef surface doesn't depend on
// the generic `Table` — the grid layout gives us cleaner column
// control than colspan math.
function Row({
  header,
  children,
}: {
  header?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        borderBottom: header ? "1px solid #27272a" : "1px solid #18181b",
        background: header ? "#0e0e10" : "transparent",
      }}
    >
      {children}
    </div>
  );
}

function Cell({
  children,
  width,
}: {
  children?: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        width,
        flex: width ? undefined : 1,
        fontSize: 13,
        color: "#d4d4d8",
        borderRight: "1px solid #18181b",
      }}
    >
      {children}
    </div>
  );
}

function TypePill({ type }: { type: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        border: "1px solid #3f3f46",
        borderRadius: 2,
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        color: "#e4e4e7",
        background: "#18181b",
      }}
    >
      {type}
    </span>
  );
}

function formatRange(p: ParamDef): string {
  if (p.min !== undefined && p.max !== undefined)
    return `${p.min} … ${p.max}`;
  if (p.min !== undefined) return `≥ ${p.min}`;
  if (p.max !== undefined) return `≤ ${p.max}`;
  return "";
}

function formatDefault(p: ParamDef): string {
  const d = p.default;
  if (d === null || d === undefined) return "—";
  if (typeof d === "string") return JSON.stringify(d);
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  // Arrays / vecs / colors — keep it compact.
  if (Array.isArray(d)) return JSON.stringify(d);
  // Opaque defaults (paint canvases, audio elements, etc.) — don't
  // try to dump them.
  if (typeof d === "object") return "(complex)";
  return String(d);
}

// -------------------------------------------------------------------
// Sidebar TOC generator. Called at module-load time from each node
// category page so the sidebar's second-level nav can surface every
// node as a jump link. Requires the registry to be populated — the
// top-of-file `registerAllNodes()` call handles that on every import.
// -------------------------------------------------------------------

export function makeNodeCategoryToc(category: NodeCategory): TocItem[] {
  const defs = allNodeDefs().filter(
    (d) => d.category === category && !HIDDEN_TYPES.has(d.type)
  );
  const typed =
    category !== "utility" && category !== "effect" && category !== "output";
  if (typed) {
    // Match the on-page order: generator → modifier → utility, nodes
    // alphabetical within each. Group headers are non-clickable
    // labels (see `kind: "group"` in TocItem).
    const groups: Partial<Record<NodeSubcategory, NodeDefinition[]>> = {};
    for (const d of defs) {
      const sub = d.subcategory ?? "utility";
      (groups[sub] ??= []).push(d);
    }
    const out: TocItem[] = [];
    for (const sub of SUB_ORDER) {
      const list = groups[sub];
      if (!list?.length) continue;
      out.push({ kind: "group", title: SUB_LABEL[sub], id: `grp-${sub}` });
      for (const d of [...list].sort((a, b) => a.name.localeCompare(b.name)))
        out.push({ id: d.type, title: d.name });
    }
    return out;
  }
  return [...defs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ id: d.type, title: d.name }));
}
