"use client";

// Export to After Effects (spec 091926_after-effects-handoff.md §5.4).
//
// Shows the plan's coverage tree (one row per node with its rung, fidelity
// and notes), lets the user override nodes and change the export policy,
// and runs the export through the AeExportRunner EffectsApp hands it. It
// never reaches into the editor: the plan comes from `replan`, the work
// from `run`, and Claude from `onConvertWithClaude`.
// Props: AeExportModalProps (src/lib/ae-export/package/index.ts).

import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AeExportModalProps, AeExportResult } from "@/lib/ae-export/package";
import type { AeNodeOverride } from "@/lib/ae-export/scene";
import type { AeColorPolicy, AeExportPlan, AeFidelityPolicy } from "@/lib/ae-export/types";
import {
  AE_CLASS_CHIP,
  AE_FIDELITY_COLOR,
  AE_OVERRIDE_LABEL,
  AE_ROUTE_TEXT,
  aeConvertPrompt,
  aeCoverage,
  aeOptionsFromPolicy,
  aePolicyFromOptions,
  aeSummaryLine,
  aeWithBudget,
  type AeModalOptions,
} from "./ae-export-ui";

const PHASE_LABEL: Record<string, string> = {
  plan: "Planning",
  scene: "Building the scene",
  bake: "Rendering footage",
  encode: "Encoding footage",
  write: "Writing the package",
  build: "Building in After Effects",
};

// The body mounts fresh on every opening, so its state (name, options,
// overrides, last result) starts over without a reset effect.
export default function ExportAeModal(props: AeExportModalProps): JSX.Element | null {
  if (!props.open) return null;
  return <ExportAeModalBody {...props} />;
}

function ExportAeModalBody(props: AeExportModalProps): JSX.Element {
  const { onClose, defaultName, replan, run, canBuildInAe, canWriteFolder, onConvertWithClaude, progress } = props;

  const [name, setName] = useState(defaultName);
  const [options, setOptions] = useState<AeModalOptions>(() => aeOptionsFromPolicy());
  const [overrides, setOverrides] = useState<Record<string, AeNodeOverride>>({});
  const [destination, setDestination] = useState<"zip" | "folder">(canWriteFolder ? "folder" : "zip");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AeExportResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const policy = useMemo(() => aePolicyFromOptions(options), [options]);

  // replan is synchronous and cheap (the planner is pure); recompute when the
  // options or overrides change. A planner throw shows as a problem instead
  // of blanking the modal.
  const planned = useMemo((): { plan: AeExportPlan | null; error: string | null } => {
    try {
      return { plan: replan(policy, overrides), error: null };
    } catch (e) {
      return { plan: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [replan, policy, overrides]);

  const plan = planned.plan;
  const coverage = plan ? aeCoverage(plan) : [];
  const route = plan ? AE_ROUTE_TEXT[plan.route] : null;
  const trimmedName = name.trim();
  const exportDisabled = busy || !plan || plan.route === "blocked" || trimmedName.length === 0;

  const setOverride = (id: string, value: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === "") delete next[id];
      else next[id] = value as AeNodeOverride;
      return next;
    });
  };

  const start = async (build: boolean) => {
    if (exportDisabled) return;
    setBusy(true);
    setResult(null);
    setRunError(null);
    try {
      const res = await run({
        policy,
        overrides,
        fused: {},
        name: trimmedName,
        destination: build ? "folder" : destination,
        build,
      });
      setResult(res);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const convert = () => {
    if (!plan) return;
    onConvertWithClaude(aeConvertPrompt(plan, trimmedName || defaultName, policy));
    onClose();
  };

  return (
    <div
      onClick={() => {
        if (!busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 600,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "var(--tb-n-3)",
          border: "1px solid var(--tb-n-7)",
          borderRadius: 6,
          padding: 16,
          fontFamily: "var(--ui-font)",
          fontSize: 11,
          color: "var(--tb-n-16)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ color: "var(--tb-n-13)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>
            Export to After Effects
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={closeStyle()}>
            ×
          </button>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>Name</div>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} style={inputStyle()} />
        </div>

        {planned.error && <div style={{ ...noteBox(), color: "var(--tb-a-red-400)", marginBottom: 10 }}>Couldn&rsquo;t plan this graph: {planned.error}</div>}

        {plan && route && (
          <div style={{ ...noteBox(), marginBottom: 10, borderColor: route.color }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: route.color, fontWeight: 600 }}>{route.label}</span>
              <span style={{ color: "var(--tb-n-11)" }}>{aeSummaryLine(plan)}</span>
            </div>
            <div style={{ color: "var(--tb-n-13)", marginTop: 4, lineHeight: 1.4 }}>{route.detail}</div>
          </div>
        )}

        {plan && (
          <div style={{ marginBottom: 10 }}>
            <div style={labelStyle()}>Coverage</div>
            <div style={listStyle()}>
              {coverage.length === 0 && <div style={{ color: "var(--tb-n-11)" }}>(nothing reaches the Output)</div>}
              {coverage.map((layer) => {
                const isCollapsed = collapsed[layer.id] ?? coverage.length > 3;
                return (
                  <div key={layer.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <button
                      onClick={() => setCollapsed((c) => ({ ...c, [layer.id]: !isCollapsed }))}
                      style={{ ...rowStyle(), background: "transparent", border: "none", padding: 0, color: "inherit", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                    >
                      <span style={{ color: "var(--tb-n-10)", width: 10 }}>{isCollapsed ? "▸" : "▾"}</span>
                      <span style={{ color: "var(--tb-n-16)", fontWeight: 600 }}>{layer.name}</span>
                      {layer.windows && <span style={{ color: "var(--tb-n-10)" }}>{layer.windows}</span>}
                      <span style={{ flex: 1 }} />
                      {layer.counts.map((c) => (
                        <span key={c.class} style={{ color: AE_CLASS_CHIP[c.class].color }} title={AE_CLASS_CHIP[c.class].title}>
                          {c.n} {AE_CLASS_CHIP[c.class].label}
                        </span>
                      ))}
                    </button>
                    {!isCollapsed &&
                      layer.nodes.map((n) => (
                        <div key={n.id} style={{ ...rowStyle(), paddingLeft: 16, alignItems: "flex-start" }}>
                          <span style={chipStyle(AE_CLASS_CHIP[n.class].color)} title={AE_CLASS_CHIP[n.class].title}>
                            {AE_CLASS_CHIP[n.class].label}
                          </span>
                          <span style={{ color: "var(--tb-n-16)", minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }} title={n.notes.join("\n")}>
                            {n.name ?? n.type}
                            {n.name && <span style={{ color: "var(--tb-n-10)" }}> ({n.type})</span>}
                            {n.ae && <span style={{ color: "var(--tb-n-10)" }}> → {n.ae}</span>}
                            {n.notes[0] && <div style={{ color: "var(--tb-n-11)", lineHeight: 1.35 }}>{n.notes[0]}</div>}
                          </span>
                          <span style={{ color: AE_FIDELITY_COLOR[n.fidelity] }}>{n.fidelity}</span>
                          <select
                            value={overrides[n.id] ?? ""}
                            onChange={(e) => setOverride(n.id, e.target.value)}
                            disabled={busy}
                            style={{ ...inputStyle(), width: 118, padding: "1px 4px", appearance: "auto", cursor: "pointer" }}
                            title="Override how this node exports"
                          >
                            <option value="">As planned</option>
                            {n.overrides.map((o) => (
                              <option key={o} value={o}>
                                {AE_OVERRIDE_LABEL[o]}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {plan && plan.shaderRegions.length > 0 && (
          <Section title={`Shader regions (${plan.shaderRegions.length})`}>
            {plan.shaderRegions.map((r) => (
              <div key={r.id} style={rowStyle()}>
                <span style={{ color: "var(--tb-a-violet-400)" }}>◆</span>
                <span>{r.target}</span>
                <span style={{ color: "var(--tb-n-10)" }}>
                  {r.nodes.length} node{r.nodes.length === 1 ? "" : "s"}
                </span>
                {r.summary && <span style={{ color: "var(--tb-n-11)" }}>— {r.summary}</span>}
              </div>
            ))}
            <div style={{ color: "var(--tb-n-11)", lineHeight: 1.4, marginTop: 2 }}>
              Without conversion these bake. &ldquo;Convert with Claude&rdquo; fuses each into a shader that the Toolbox Shader plug-in runs in AE.
            </div>
          </Section>
        )}

        {plan && plan.bakes.length > 0 && (
          <Section title={`Baked footage (${plan.bakes.length})`}>
            {plan.bakes.map((b) => (
              <div key={b.id} style={rowStyle()}>
                <span style={{ color: "var(--tb-a-amber-400)" }}>■</span>
                <span>{b.output}</span>
                <span style={{ color: "var(--tb-n-10)" }}>
                  frames {b.frames[0]}–{b.frames[1]} · ~{b.estimatedMB < 10 ? b.estimatedMB.toFixed(1) : Math.round(b.estimatedMB)} MB
                </span>
                <span style={{ color: "var(--tb-n-11)" }}>{b.reason}</span>
              </div>
            ))}
          </Section>
        )}

        {plan && plan.blocked.length > 0 && (
          <Section title="Blocked">
            {plan.blocked.map((b) => (
              <div key={b.id} style={{ ...rowStyle(), color: "var(--tb-a-red-400)" }}>
                <span style={{ fontWeight: 700 }}>!</span>
                <span>
                  {b.type} ({b.id}): {b.reason}
                </span>
              </div>
            ))}
          </Section>
        )}

        {plan && plan.fonts.length > 0 && (
          <Section title="Fonts AE needs installed">
            <div style={{ color: "var(--tb-n-13)" }}>{plan.fonts.join(", ")}</div>
          </Section>
        )}

        {plan && plan.warnings.length > 0 && (
          <Section title="Warnings">
            {plan.warnings.map((w, i) => (
              <div key={i} style={{ ...rowStyle(), color: "var(--tb-a-yellow-400)", alignItems: "flex-start", lineHeight: 1.4 }}>
                <span style={{ fontWeight: 700 }}>!</span>
                <span>{w}</span>
              </div>
            ))}
          </Section>
        )}

        <div style={{ marginBottom: 10 }}>
          <div style={labelStyle()}>Options</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 10px" }}>
            <Field label="Keyframes" title="Editable keeps one AE key per toolbox key (≤ 0.6% off on a few presets); Exact adds keys so every preset matches">
              <select value={options.fidelity} disabled={busy} onChange={(e) => setOptions({ ...options, fidelity: e.target.value as AeFidelityPolicy })} style={selectStyle()}>
                <option value="editable">Editable</option>
                <option value="exact">Exact</option>
              </select>
            </Field>
            <Field label="Color tracks" title="Toolbox blends keyed colors in OKLab, AE in RGB">
              <select value={options.color} disabled={busy} onChange={(e) => setOptions({ ...options, color: e.target.value as AeColorPolicy })} style={selectStyle()}>
                <option value="auto">Auto (expression on shapes, keys elsewhere)</option>
                <option value="expression">OKLab expression</option>
                <option value="dense">Extra keys (2/255)</option>
                <option value="rgb">Plain RGB keys</option>
              </select>
            </Field>
            <Field label="Bake codec">
              <select value={options.bakeCodec} disabled={busy} onChange={(e) => setOptions({ ...options, bakeCodec: e.target.value as AeModalOptions["bakeCodec"] })} style={selectStyle()}>
                <option value="prores4444">ProRes 4444</option>
                <option value="qtrle">QuickTime Animation</option>
              </select>
            </Field>
            <Field label="Bit depth">
              <select value={options.bitsPerChannel} disabled={busy} onChange={(e) => setOptions({ ...options, bitsPerChannel: Number(e.target.value) as 8 | 16 | 32 })} style={selectStyle()}>
                <option value={8}>8 bpc</option>
                <option value={16}>16 bpc</option>
                <option value={32}>32 bpc (float)</option>
              </select>
            </Field>
            <Field label="Layer budget" title="Copies explode into one layer each up to this many; past it they bake">
              <input type="number" min={1} max={5000} value={options.layerBudget} disabled={busy} onChange={(e) => setOptions(aeWithBudget(options, e.target.value))} style={inputStyle()} />
            </Field>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "flex-end" }}>
              <label style={checkStyle()} title="Use AE built-ins that look close (e.g. Gaussian Blur for Blur); off sends them to shader regions instead">
                <input type="checkbox" checked={options.acceptApprox} disabled={busy} onChange={(e) => setOptions({ ...options, acceptApprox: e.target.checked })} />
                Accept close AE effects
              </label>
              <label style={checkStyle()} title="The AE user has the Toolbox Shader plug-in; off bakes shader regions">
                <input type="checkbox" checked={options.shaderHost} disabled={busy} onChange={(e) => setOptions({ ...options, shaderHost: e.target.checked })} />
                Toolbox Shader plug-in
              </label>
            </div>
          </div>
        </div>

        {canWriteFolder && (
          <div style={{ marginBottom: 10 }}>
            <div style={labelStyle()}>Save as</div>
            <div style={{ display: "flex", gap: 12 }}>
              <label style={checkStyle()}>
                <input type="radio" name="ae-dest" checked={destination === "folder"} disabled={busy} onChange={() => setDestination("folder")} />
                Package folder
              </label>
              <label style={checkStyle()}>
                <input type="radio" name="ae-dest" checked={destination === "zip"} disabled={busy} onChange={() => setDestination("zip")} />
                Zip
              </label>
            </div>
          </div>
        )}

        {busy && progress && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "var(--tb-n-13)", marginBottom: 3 }}>
              <span>{progress.label ?? PHASE_LABEL[progress.phase] ?? progress.phase}</span>
              {progress.total > 0 && (
                <span>
                  {progress.done} / {progress.total}
                </span>
              )}
            </div>
            <div style={{ height: 4, background: "var(--tb-n-1)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progress.total > 0 ? Math.min(100, (100 * progress.done) / progress.total) : 0}%`, background: "var(--tb-a-blue-500)" }} />
            </div>
          </div>
        )}

        {runError && <div style={{ ...noteBox(), color: "var(--tb-a-red-400)", marginBottom: 10 }}>Export failed: {runError}</div>}

        {result && (
          <div style={{ marginBottom: 10 }}>
            <div style={labelStyle()}>{result.ok ? "Exported" : "Not exported"}</div>
            {result.location && <div style={{ color: "var(--tb-n-13)", marginBottom: 4, wordBreak: "break-all" }}>{result.location}</div>}
            {result.problems.map((p, i) => (
              <div key={`p${i}`} style={{ color: "var(--tb-a-red-400)", lineHeight: 1.4 }}>
                ! {p}
              </div>
            ))}
            {result.warnings.map((w, i) => (
              <div key={`w${i}`} style={{ color: "var(--tb-a-yellow-400)", lineHeight: 1.4 }}>
                ! {w}
              </div>
            ))}
            {result.built && (
              <div style={{ color: result.built.ok ? "var(--tb-a-emerald-400)" : "var(--tb-a-red-400)", margin: "4px 0" }}>
                {result.built.ok ? `Built in After Effects${result.built.aep ? `: ${result.built.aep}` : ""}` : "After Effects build failed — see the log below"}
              </div>
            )}
            <pre style={{ ...noteBox(), whiteSpace: "pre-wrap", maxHeight: 180, overflowY: "auto", margin: 0, fontFamily: "var(--mono-font, monospace)", fontSize: 10 }}>
              {result.built && !result.built.ok ? `${result.report}\n\n${result.built.log}` : result.report}
            </pre>
          </div>
        )}

        <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center", paddingTop: 10, borderTop: "1px solid var(--tb-n-7)" }}>
          <button onClick={onClose} disabled={busy} style={btnStyle()}>
            {result?.ok ? "Done" : "Cancel"}
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            {plan && plan.shaderRegions.length > 0 && (
              <button onClick={convert} disabled={busy} style={btnStyle()} title="Open the agent panel with a prompt that fuses each shader region, then exports">
                Convert with Claude
              </button>
            )}
            <button onClick={() => void start(false)} disabled={exportDisabled} style={primaryStyle(exportDisabled)}>
              {busy ? "Exporting…" : "Export package →"}
            </button>
            {canBuildInAe && (
              <button onClick={() => void start(true)} disabled={exportDisabled} style={primaryStyle(exportDisabled)} title="Write the package folder, build the .aep headless, and open it in After Effects">
                Build in After Effects →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={labelStyle()}>{props.title}</div>
      <div style={listStyle()}>{props.children}</div>
    </div>
  );
}

function Field(props: { label: string; title?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div title={props.title}>
      <div style={{ ...labelStyle(), marginBottom: 2 }}>{props.label}</div>
      {props.children}
    </div>
  );
}

function labelStyle(): React.CSSProperties {
  return { color: "var(--tb-n-11)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    background: "var(--tb-n-0)",
    border: "1px solid var(--tb-n-7)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    outline: "none",
  };
}

function selectStyle(): React.CSSProperties {
  return { ...inputStyle(), padding: "4px 6px", appearance: "auto", cursor: "pointer" };
}

function listStyle(): React.CSSProperties {
  return {
    background: "var(--tb-n-1)",
    border: "1px solid var(--tb-n-5)",
    borderRadius: 3,
    padding: "6px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  };
}

function noteBox(): React.CSSProperties {
  return { background: "var(--tb-n-1)", border: "1px solid var(--tb-n-5)", borderRadius: 3, padding: "6px 8px" };
}

function rowStyle(): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 6, fontSize: 11 };
}

function chipStyle(color: string): React.CSSProperties {
  return {
    color,
    border: `1px solid ${color}`,
    borderRadius: 3,
    padding: "0 4px",
    fontSize: 9,
    lineHeight: "14px",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    flexShrink: 0,
    minWidth: 52,
    textAlign: "center",
  };
}

function checkStyle(): React.CSSProperties {
  return { display: "flex", alignItems: "center", gap: 5, color: "var(--tb-n-13)", cursor: "pointer" };
}

function closeStyle(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-13)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    padding: "0 6px",
    lineHeight: "16px",
    cursor: "pointer",
  };
}

function btnStyle(): React.CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: "1px solid var(--tb-n-9)",
    color: "var(--tb-n-16)",
    fontFamily: "inherit",
    fontSize: 11,
    borderRadius: 3,
    cursor: "pointer",
  };
}

function primaryStyle(disabled: boolean): React.CSSProperties {
  return {
    ...btnStyle(),
    background: "var(--tb-a-blue-900)",
    border: "1px solid var(--tb-a-blue-900)",
    color: "var(--tb-a-blue-200)",
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
