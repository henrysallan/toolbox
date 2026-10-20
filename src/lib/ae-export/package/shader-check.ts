// validate_ae_shader's compile step on the desktop: main runs
// tbxshader-check --json on the bundle (electron/ae.js checkShader) and this
// turns its answer into the ShaderCompileResult validateAeShader takes — the
// same reading shader/native.ts gives the Node-side compiler, kept pure so
// the editor bundle can use it (native.ts spawns processes).

import type { AeShaderCheck } from "@/lib/platform/types";
import type { ShaderCompileResult } from "../shader/validate";

interface Diag {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
}

export function hostCheckResult(chk: AeShaderCheck): ShaderCompileResult {
  const j = chk.json ?? null;
  if (!j) {
    return {
      validator: "tbxshader-check",
      ok: false,
      log: `tbxshader-check gave no JSON (exit ${chk.status ?? "?"}): ${[chk.stdout, chk.stderr].filter(Boolean).join("\n")}`.trim(),
    };
  }
  const errors = (Array.isArray(j.errors) ? j.errors : []) as Diag[];
  const warnings = (Array.isArray(j.warnings) ? j.warnings : []) as Diag[];
  const text = [
    ...(typeof j.error === "string" ? [`${String(j.stage ?? "error")}: ${j.error}`] : []),
    ...errors.map((d) => `${d.file || "source.msl"}:${d.line ?? 0}: error: ${d.message ?? ""}`),
    ...warnings.map((d) => `${d.file || "source.msl"}:${d.line ?? 0}: warning: ${d.message ?? ""}`),
  ].join("\n");
  return {
    validator: "tbxshader-check",
    ok: j.ok === true && chk.status === 0,
    log: text || [chk.stdout, chk.stderr].filter(Boolean).join("\n"),
    device: `host ${String(j.host ?? "?")}, ABI ${String(j.abi ?? "?")}`,
    diagnostics: errors
      .filter((d) => !d.file || /source\.msl/.test(d.file))
      .map((d) => ({ mslLine: Number(d.line ?? 0), message: String(d.message ?? "") })),
  };
}
