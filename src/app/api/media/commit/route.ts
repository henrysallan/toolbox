// POST /api/media/commit — finalize a cloud-media upload (spec 081626
// §6.2). Verifies the object actually landed in R2 with the size the
// ledger promised, then flips the row pending → ready. Commit-after-
// upload means a crashed upload leaves only an aged-out pending row,
// never a ready row pointing at nothing ("assets first, row last",
// translated from the images tier).
//
// A size mismatch (presign small / upload big — a quota cheat) deletes
// both the object and the ledger row and 409s.

import { cloudMediaKey, cloudMediaUrl, isSha256Hex } from "@/lib/cloud-media";
import {
  createServiceClient,
  deleteObject,
  getR2,
  headObject,
  resolveMediaAuth,
} from "@/lib/cloud-media-server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let hash: unknown;
  try {
    ({ hash } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isSha256Hex(hash))
    return Response.json({ error: "Invalid `hash`." }, { status: 400 });

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
  const { data: row, error: rowErr } = await svc
    .from("media_assets")
    .select("status, ext, size")
    .eq("user_id", userId)
    .eq("hash", hash)
    .maybeSingle();
  if (rowErr)
    return Response.json({ error: "Ledger unavailable." }, { status: 503 });
  if (!row)
    return Response.json(
      { error: "No pending upload for this hash." },
      { status: 404 }
    );

  const url = cloudMediaUrl({ hash, ext: row.ext, owner: userId });
  if (row.status === "ready") return Response.json({ url }); // idempotent

  const key = cloudMediaKey(userId, hash, row.ext);
  let head: { exists: boolean; size: number };
  try {
    head = await headObject(r2, key);
  } catch {
    return Response.json({ error: "Storage unavailable." }, { status: 503 });
  }
  if (!head.exists)
    return Response.json(
      { error: "Object not found — upload incomplete." },
      { status: 409 }
    );
  if (head.size !== row.size) {
    try {
      await deleteObject(r2, key);
    } catch {
      // Best-effort: an orphan object is cheap; the ledger row is gone
      // either way, so it can never become ready.
    }
    await svc
      .from("media_assets")
      .delete()
      .eq("user_id", userId)
      .eq("hash", hash);
    return Response.json(
      { error: "Uploaded size doesn't match the presigned size." },
      { status: 409 }
    );
  }

  const { error: updateErr } = await svc
    .from("media_assets")
    .update({ status: "ready" })
    .eq("user_id", userId)
    .eq("hash", hash);
  if (updateErr)
    return Response.json({ error: "Ledger write failed." }, { status: 503 });

  return Response.json({ url });
}
