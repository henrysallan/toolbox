// POST /api/media/presign — authorize + presign one cloud-media upload
// (spec 081626 §6.1). Auth (cookie session) → entitlement → quota against
// the media_assets ledger → pending ledger row → presigned R2 PUT.
//
// The server derives ext AND mime from the filename against the kind's
// allowlist and signs the Content-Type into the URL — the client never
// chooses a mime (public-read bucket; see cloud-media.ts).
//
// Dedup: a (user, hash) already `ready` returns { already: true, url }
// with no upload — the content-addressed idempotent-re-save property the
// images tier has.

import {
  MAX_CLOUD_UPLOAD_BYTES,
  CLOUD_MEDIA_KINDS,
  cloudMediaKey,
  cloudMediaType,
  cloudMediaUrl,
  isSha256Hex,
  type CloudMediaKind,
} from "@/lib/cloud-media";
import {
  createServiceClient,
  getR2,
  presignPut,
  PRESIGN_EXPIRES_SECONDS,
  resolveMediaAuth,
} from "@/lib/cloud-media-server";

export const runtime = "nodejs";

interface Body {
  hash?: string;
  size?: number;
  filename?: string;
  kind?: string;
}

// Pending rows younger than this still count toward quota (prevents
// overshoot via parallel presigns); older pendings are abandoned uploads
// and age out of the sum (swept in M3).
const PENDING_FRESH_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { hash, size, filename } = body;
  const kind = body.kind as CloudMediaKind;
  if (!isSha256Hex(hash))
    return Response.json({ error: "Invalid `hash`." }, { status: 400 });
  if (!Number.isInteger(size) || (size as number) <= 0)
    return Response.json({ error: "Invalid `size`." }, { status: 400 });
  if ((size as number) > MAX_CLOUD_UPLOAD_BYTES)
    return Response.json(
      { error: "File exceeds the 2 GB single-upload limit." },
      { status: 413 }
    );
  if (!filename || typeof filename !== "string" || filename.length > 300)
    return Response.json({ error: "Invalid `filename`." }, { status: 400 });
  if (!CLOUD_MEDIA_KINDS.includes(kind))
    return Response.json({ error: "Invalid `kind`." }, { status: 400 });

  const type = cloudMediaType(filename, kind);
  if (!type)
    return Response.json(
      { error: `Unsupported ${kind} file type.` },
      { status: 415 }
    );

  const auth = await resolveMediaAuth();
  if (!auth.ok)
    return Response.json({ error: auth.error }, { status: auth.status });

  const svc = createServiceClient();
  const r2 = getR2();
  if (!svc || !r2)
    return Response.json(
      { error: "Cloud media storage isn't configured on this server." },
      { status: 503 }
    );

  const userId = auth.user.id;

  // Dedup: already stored → zero upload.
  const { data: existing, error: existingErr } = await svc
    .from("media_assets")
    .select("status, ext")
    .eq("user_id", userId)
    .eq("hash", hash)
    .maybeSingle();
  if (existingErr)
    return Response.json({ error: "Ledger unavailable." }, { status: 503 });
  if (existing?.status === "ready")
    return Response.json({
      already: true,
      // key included so the client can seed its ref registry (owner/ext
      // parse out of it) without a second lookup.
      key: cloudMediaKey(userId, hash as string, existing.ext),
      url: cloudMediaUrl({ hash: hash as string, ext: existing.ext, owner: userId }),
    });

  // Quota: ready rows + fresh pendings.
  if (auth.entitlement.quotaBytes != null) {
    const { data: rows, error: quotaErr } = await svc
      .from("media_assets")
      .select("size, status, created_at")
      .eq("user_id", userId);
    if (quotaErr)
      return Response.json({ error: "Ledger unavailable." }, { status: 503 });
    const cutoff = Date.now() - PENDING_FRESH_MS;
    let used = 0;
    for (const r of rows ?? []) {
      if (
        r.status === "ready" ||
        (r.status === "pending" && Date.parse(r.created_at) > cutoff)
      )
        used += r.size;
    }
    if (used + (size as number) > auth.entitlement.quotaBytes)
      return Response.json(
        {
          error: "Storage quota exceeded.",
          used,
          quota: auth.entitlement.quotaBytes,
        },
        { status: 413 }
      );
  }

  // Ledger row first, presign second: a crashed request leaves a pending
  // row that ages out, never an untracked upload URL.
  const { error: upsertErr } = await svc.from("media_assets").upsert(
    {
      user_id: userId,
      hash,
      ext: type.ext,
      mime: type.mime,
      size,
      filename,
      kind,
      status: "pending",
    },
    { onConflict: "user_id,hash" }
  );
  if (upsertErr)
    return Response.json({ error: "Ledger write failed." }, { status: 503 });

  const key = cloudMediaKey(userId, hash as string, type.ext);
  const uploadUrl = await presignPut(r2, key, type.mime);
  return Response.json({
    uploadUrl,
    key,
    // The uploader must send exactly this header — it's signed.
    headers: { "Content-Type": type.mime },
    expiresSeconds: PRESIGN_EXPIRES_SECONDS,
  });
}
