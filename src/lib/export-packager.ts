import JSZip from "jszip";
import type { ExportManifest } from "./export-manifest";
import type { SavedProject } from "./project";

export interface ExportTemplate {
  singleFileHtml: string;
  distFiles: Record<string, string | Uint8Array>;
  sourceFiles: Record<string, string | Uint8Array>;
}

export interface PackageExportInput {
  appName: string;
  description?: string;
  manifest: ExportManifest;
  graphJson: SavedProject;
  template: ExportTemplate;
}

const PLACEHOLDER = "<!--__EXPORT_GRAPH_DATA__-->";
const HEAD_CLOSE = "</head>";
const SIZE_CAP_BYTES = 25 * 1024 * 1024;

function sanitizeAppName(name: string): string {
  const replaced = name.replace(/[^A-Za-z0-9_-]/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : "app";
}

// Escape `</` and `<!--` so embedded JSON can't terminate the host <script> tag.
function escapeJsonForScriptTag(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
}

function buildScriptBlocks(graphJson: SavedProject, manifest: ExportManifest): string {
  const graph = escapeJsonForScriptTag(graphJson);
  const mani = escapeJsonForScriptTag(manifest);
  return (
    `<script id="export-graph" type="application/json">${graph}</script>\n` +
    `<script id="export-manifest" type="application/json">${mani}</script>`
  );
}

function injectIntoHtml(
  html: string,
  graphJson: SavedProject,
  manifest: ExportManifest,
): string {
  const blocks = buildScriptBlocks(graphJson, manifest);
  if (html.includes(PLACEHOLDER)) {
    return html.replace(PLACEHOLDER, blocks);
  }
  const headIdx = html.toLowerCase().indexOf(HEAD_CLOSE);
  if (headIdx !== -1) {
    return html.slice(0, headIdx) + blocks + "\n" + html.slice(headIdx);
  }
  throw new Error("export template missing __EXPORT_GRAPH_DATA__ placeholder");
}

function byteLength(value: string | Uint8Array): number {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).length;
  }
  return value.byteLength;
}

function buildReadme(input: PackageExportInput): string {
  const slug = sanitizeAppName(input.appName);
  const lines: string[] = [];
  lines.push(`# ${input.appName}`);
  lines.push("");
  if (input.description && input.description.trim().length > 0) {
    lines.push(input.description.trim());
    lines.push("");
  }

  lines.push("## What's in this folder");
  lines.push("");
  lines.push("| Path | What it is |");
  lines.push("| --- | --- |");
  lines.push("| `index.html` | Single-file standalone app. Double-click to run. |");
  lines.push("| `dist/` | Static build. Drop on any static host. |");
  lines.push("| `source/` | Editable Vite project. For developers. |");
  lines.push("");

  lines.push("## Run it (no install)");
  lines.push("");
  lines.push("Double-click `index.html`. It opens in your browser and runs locally — no server, no internet required.");
  lines.push("");

  lines.push("## Host it (static site)");
  lines.push("");
  lines.push(`Upload the contents of \`dist/\` to any static host (Vercel, Netlify, GitHub Pages, S3). For example, with Vercel: \`vercel deploy dist --name ${slug}\`.`);
  lines.push("");

  lines.push("## Edit it (Vite)");
  lines.push("");
  lines.push("```");
  lines.push("cd source");
  lines.push("npm install");
  lines.push("npm run dev");
  lines.push("```");
  lines.push("");

  lines.push("## What controls does this app have?");
  lines.push("");
  const fileInputs = input.manifest.fileInputs ?? [];
  const controls = input.manifest.controls ?? [];
  if (fileInputs.length === 0 && controls.length === 0) {
    lines.push("Just play / pause / reset.");
  } else {
    if (fileInputs.length > 0) {
      lines.push("File inputs:");
      lines.push("");
      for (const fi of fileInputs) {
        lines.push(`- ${fi.label} — ${fi.nodeId}.${fi.paramName}`);
      }
      lines.push("");
    }
    if (controls.length > 0) {
      lines.push("Controls:");
      lines.push("");
      for (const c of controls) {
        lines.push(`- ${c.nodeName} — ${c.label} (${c.paramType})`);
      }
      lines.push("");
    }
  }

  lines.push("## How was this made?");
  lines.push("");
  lines.push("Built with Toolbox (https://example.com/toolbox) — a node-based WebGL effect editor.");
  lines.push("");

  return lines.join("\n");
}

export async function packageExportApp(input: PackageExportInput): Promise<Blob> {
  const { graphJson, manifest, template } = input;

  const zip = new JSZip();

  const tierAHtml = injectIntoHtml(template.singleFileHtml, graphJson, manifest);
  zip.file("index.html", tierAHtml);

  const distIndexRaw = template.distFiles["index.html"];
  if (distIndexRaw === undefined) {
    throw new Error("export template missing dist/index.html");
  }
  const distIndexStr =
    typeof distIndexRaw === "string"
      ? distIndexRaw
      : new TextDecoder().decode(distIndexRaw);
  const distIndexHtml = injectIntoHtml(distIndexStr, graphJson, manifest);
  zip.file("dist/index.html", distIndexHtml);

  for (const [path, content] of Object.entries(template.distFiles)) {
    if (path === "index.html") continue;
    zip.file(`dist/${path}`, content);
  }

  const graphPretty = JSON.stringify(graphJson, null, 2);
  const manifestPretty = JSON.stringify(manifest, null, 2);
  zip.file("dist/graph.json", graphPretty);
  zip.file("dist/manifest.json", manifestPretty);

  for (const [path, content] of Object.entries(template.sourceFiles)) {
    zip.file(`source/${path}`, content);
  }
  zip.file("source/src/graph.json", graphPretty);
  zip.file("source/src/manifest.json", manifestPretty);

  const readme = buildReadme(input);
  zip.file("README.md", readme);

  let totalBytes = 0;
  totalBytes += byteLength(tierAHtml);
  totalBytes += byteLength(distIndexHtml);
  for (const [path, content] of Object.entries(template.distFiles)) {
    if (path === "index.html") continue;
    totalBytes += byteLength(content);
  }
  totalBytes += byteLength(graphPretty);
  totalBytes += byteLength(manifestPretty);
  for (const content of Object.values(template.sourceFiles)) {
    totalBytes += byteLength(content);
  }
  totalBytes += byteLength(graphPretty);
  totalBytes += byteLength(manifestPretty);
  totalBytes += byteLength(readme);

  if (totalBytes > SIZE_CAP_BYTES) {
    const mb = (totalBytes / (1024 * 1024)).toFixed(2);
    throw new Error(
      `export bundle exceeds 25 MB cap (uncompressed size: ${mb} MB)`,
    );
  }

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
