// AE rig census corpus (specdocs/102126_ae-rig-export.md §5.1): download the
// owner's cloud projects as plain SavedProject JSON, so the census runner
// can plan them offline with no editor and no sign-in.
//
//   npx tsx scripts/ae-rig/fetch-corpus.mts --owner-of Sketch_017 [--folder <name>]
//       [--pick 12] [--out .corpus/ae-rig] [--keep-media] [--list]
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
// .env.local. The service-role key bypasses RLS, so the script only ever
// SELECTs, and only rows whose user_id is the owner it resolved (--user-id;
// --email through the auth admin API; or --owner-of, the one account that
// owns a project with that exact name). It never prints the key.
//
// Output (gitignored):
//   <out>/projects/<name>--<id8>.json   { meta, graph }
//   <out>/index.json, <out>/index.md    per project: node count, node types,
//                                       and whether the coverage pick chose it
//
// Inline media (data: URLs from ≤v8 saves, composition thumbnails) is
// replaced by a "data:stripped" stub unless --keep-media: planning never
// reads pixels, and old inline rows can run to tens of MB. Storage asset
// refs ({ kind, asset, ext }) are left as they are.
//
// --pick N chooses N representatives greedily: each pick is the project
// that adds the most node types not yet covered (ties: more nodes, then
// newer). Structural types (layer, group, reroute, output…) don't count.
// The pick is a suggestion; index.md lists every project so the owner can
// curate.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const STRUCTURAL = new Set([
  "output",
  "layer",
  "node-group",
  "group-input",
  "group-output",
  "reroute",
  "frame",
]);

const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

interface Args {
  email?: string;
  userId?: string;
  ownerOf?: string;
  folder?: string;
  pick: number;
  out: string;
  keepMedia: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { pick: 12, out: join(ROOT, ".corpus/ae-rig"), keepMedia: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${k} needs a value`);
      return next;
    };
    if (k === "--email") a.email = v();
    else if (k === "--user-id") a.userId = v();
    else if (k === "--owner-of") a.ownerOf = v();
    else if (k === "--folder") a.folder = v();
    else if (k === "--pick") a.pick = Math.max(0, Number(v()) | 0);
    else if (k === "--out") a.out = resolve(v());
    else if (k === "--keep-media") a.keepMedia = true;
    else if (k === "--list") a.list = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.email && !a.userId && !a.ownerOf) {
    throw new Error("pass --email <owner>, --user-id <uuid> or --owner-of <a project name only the owner has>");
  }
  return a;
}

// .env.local is KEY=VALUE lines; values are never logged.
function readEnv(): Record<string, string> {
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) throw new Error(".env.local not found");
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function withTimeout<T>(p: PromiseLike<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
  ]);
}

async function resolveOwner(supa: any, a: Args): Promise<string> {
  if (a.userId) return a.userId;
  if (a.ownerOf) {
    const { data, error } = await supa.from("projects").select("user_id").eq("name", a.ownerOf);
    if (error) throw new Error(`owner lookup failed: ${error.message}`);
    const owners = [...new Set(((data ?? []) as any[]).map((r) => r.user_id as string))];
    if (owners.length !== 1) {
      throw new Error(`${owners.length} accounts own a project named "${a.ownerOf}"; pass --user-id or --email`);
    }
    return owners[0];
  }
  const want = a.email!.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await supa.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u: any) => (u.email ?? "").toLowerCase() === want);
    if (hit) return hit.id as string;
    if (data.users.length < 1000) break;
  }
  throw new Error("no user with that email");
}

// Folder name → ids, including every subfolder under a match.
async function folderScope(supa: any, owner: string, name: string): Promise<Set<string>> {
  const { data, error } = await supa
    .from("project_folders")
    .select("id, name, parent_id")
    .eq("user_id", owner);
  if (error) throw new Error(`project_folders failed: ${error.message}`);
  const rows = (data ?? []) as { id: string; name: string; parent_id: string | null }[];
  const ids = new Set(rows.filter((r) => r.name.toLowerCase() === name.toLowerCase()).map((r) => r.id));
  if (ids.size === 0) {
    const names = [...new Set(rows.map((r) => r.name))].sort().join(", ");
    throw new Error(`no folder named "${name}" (folders: ${names || "none"})`);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (r.parent_id && ids.has(r.parent_id) && !ids.has(r.id)) {
        ids.add(r.id);
        grew = true;
      }
    }
  }
  return ids;
}

function stripMedia(value: unknown): { value: unknown; stripped: number } {
  let stripped = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("data:") && v.length > 256) {
        stripped += v.length;
        return `data:stripped;chars=${v.length}`;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value), stripped };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

interface Entry {
  id: string;
  name: string;
  updated_at: string;
  folder: string | null;
  file?: string;
  nodes?: number;
  types?: string[];
  compositions?: number;
  error?: string;
  picked?: number;
}

function summarize(graph: any): Pick<Entry, "nodes" | "types" | "compositions"> {
  const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const types = new Set<string>();
  let counted = 0;
  for (const n of nodes) {
    const t = typeof n?.defType === "string" ? n.defType : null;
    if (!t || STRUCTURAL.has(t)) continue;
    types.add(t);
    counted++;
  }
  return {
    nodes: counted,
    types: [...types].sort(),
    compositions: Array.isArray(graph?.compositions) ? graph.compositions.length : 1,
  };
}

function pickCoverage(entries: Entry[], n: number): void {
  const covered = new Set<string>();
  const pool = entries.filter((e) => e.types && e.types.length > 0);
  for (let k = 1; k <= n; k++) {
    let best: Entry | null = null;
    let bestGain = 0;
    for (const e of pool) {
      if (e.picked) continue;
      const gain = e.types!.filter((t) => !covered.has(t)).length;
      const better =
        gain > bestGain ||
        (gain === bestGain && best && gain > 0 &&
          ((e.nodes ?? 0) > (best.nodes ?? 0) ||
            ((e.nodes ?? 0) === (best.nodes ?? 0) && e.updated_at > best.updated_at)));
      if (better) {
        best = e;
        bestGain = gain;
      }
    }
    if (!best) break;
    best.picked = k;
    for (const t of best.types!) covered.add(t);
  }
}

function writeIndex(out: string, entries: Entry[], owner: string, folder?: string) {
  const allTypes = new Set(entries.flatMap((e) => e.types ?? []));
  const pickedTypes = new Set(entries.filter((e) => e.picked).flatMap((e) => e.types ?? []));
  writeFileSync(
    join(out, "index.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), owner, folder: folder ?? null, projects: entries }, null, 1)
  );
  const lines = [
    "# AE rig census corpus",
    "",
    `Fetched ${new Date().toISOString()} · ${entries.length} projects${folder ? ` in folder "${folder}"` : ""} · ${allTypes.size} node types`,
    `Coverage pick: ${entries.filter((e) => e.picked).length} projects cover ${pickedTypes.size} of ${allTypes.size} types.`,
    "",
    "| pick | project | updated | nodes | types | file |",
    "|---|---|---|---|---|---|",
  ];
  const sorted = [...entries].sort(
    (a, b) => (a.picked ?? 1e9) - (b.picked ?? 1e9) || b.updated_at.localeCompare(a.updated_at)
  );
  for (const e of sorted) {
    const types = e.error ? `error: ${e.error}` : (e.types ?? []).join(", ");
    lines.push(
      `| ${e.picked ?? ""} | ${e.name.replace(/\|/g, "/")} | ${e.updated_at.slice(0, 10)} | ${e.nodes ?? ""} | ${types} | ${e.file ?? ""} |`
    );
  }
  const missing = [...allTypes].filter((t) => !pickedTypes.has(t)).sort();
  if (missing.length) lines.push("", `Types outside the pick: ${missing.join(", ")}`);
  writeFileSync(join(out, "index.md"), lines.join("\n") + "\n");
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  const supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const owner = await resolveOwner(supa, a);
  const { data: prof } = await supa.from("profiles").select("display_name, handle").eq("id", owner).maybeSingle();
  console.log(`owner: ${prof?.display_name ?? "(no display name)"}${prof?.handle ? ` @${prof.handle}` : ""}`);
  const scope = a.folder ? await folderScope(supa, owner, a.folder) : null;

  const { data: folders } = await supa.from("project_folders").select("id, name").eq("user_id", owner);
  const folderName = new Map<string, string>((folders ?? []).map((f: any) => [f.id, f.name]));

  let { data: rows, error } = await supa
    .from("projects")
    .select("id, name, updated_at, folder_id")
    .eq("user_id", owner)
    .order("updated_at", { ascending: false });
  if (error?.code === "42703") {
    ({ data: rows, error } = await supa
      .from("projects")
      .select("id, name, updated_at")
      .eq("user_id", owner)
      .order("updated_at", { ascending: false }));
  }
  if (error) throw new Error(`projects list failed: ${error.message}`);
  const listed = ((rows ?? []) as any[]).filter((r) => !scope || (r.folder_id && scope.has(r.folder_id)));
  console.log(`${listed.length} projects${a.folder ? ` in "${a.folder}"` : ""}`);

  if (a.list) {
    for (const r of listed) {
      const f = r.folder_id ? folderName.get(r.folder_id) ?? "?" : "-";
      console.log(`  ${String(r.updated_at).slice(0, 10)}  ${f.padEnd(16)}  ${r.name}`);
    }
    return;
  }

  const projectsDir = join(a.out, "projects");
  mkdirSync(projectsDir, { recursive: true });
  const entries: Entry[] = listed.map((r) => ({
    id: r.id,
    name: r.name ?? "Untitled",
    updated_at: r.updated_at,
    folder: r.folder_id ? folderName.get(r.folder_id) ?? null : null,
  }));

  let next = 0;
  let strippedChars = 0;
  const worker = async () => {
    while (next < entries.length) {
      const e = entries[next++];
      try {
        const { data, error: err } = await withTimeout(
          supa.from("projects").select("graph").eq("id", e.id).eq("user_id", owner).maybeSingle(),
          FETCH_TIMEOUT_MS,
          e.name
        );
        if (err) throw new Error(err.message);
        if (!data?.graph) throw new Error("no graph");
        let graph = data.graph;
        if (!a.keepMedia) {
          const s = stripMedia(graph);
          graph = s.value;
          strippedChars += s.stripped;
        }
        Object.assign(e, summarize(graph));
        e.file = `projects/${slug(e.name)}--${e.id.slice(0, 8)}.json`;
        const meta = { id: e.id, name: e.name, updated_at: e.updated_at, folder: e.folder, mediaStripped: !a.keepMedia };
        writeFileSync(join(a.out, e.file), JSON.stringify({ meta, graph }));
        process.stdout.write(".");
      } catch (err) {
        e.error = (err as Error).message;
        process.stdout.write("x");
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write("\n");

  pickCoverage(entries, a.pick);
  writeIndex(a.out, entries, owner, a.folder);
  const failed = entries.filter((e) => e.error).length;
  console.log(
    `wrote ${entries.length - failed} projects to ${a.out}` +
      (failed ? ` (${failed} failed, see index.md)` : "") +
      (strippedChars ? ` · stripped ${(strippedChars / 1e6).toFixed(1)} MB of inline media` : "")
  );
}

main().catch((e) => {
  console.error(`fetch-corpus: ${(e as Error).message}`);
  process.exit(1);
});
