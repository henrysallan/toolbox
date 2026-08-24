import { createClient } from "@/lib/supabase/client";
import { invalidateProjectCaches } from "@/lib/supabase/projects";

// Shared projects M2 — collaborator management + invite links
// (specdocs/081426_shared-projects.md). Low-frequency management calls
// for the Collaborators popover and the /join/<token> page, so unlike
// projects.ts there is no session cache here — every open fetches
// fresh. All reads degrade to empty on pre-migration DBs (42P01).

export interface CollaboratorEntry {
  user_id: string;
  role: string;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface InviteLink {
  token: string;
  url: string;
  expiresAt: string;
}

export interface InvitePreview {
  projectId: string;
  projectName: string;
  ownerName: string | null;
  // Mirrors get_project_invite's status column. 'owner'/'member' mean
  // redeeming is a no-op — the page shows "already in" copy instead of
  // a Join button.
  status: "valid" | "expired" | "revoked" | "owner" | "member";
}

// 16 chars base36 ≈ 82 bits — same recipe as projects.ts's
// mintPublicSlug but longer, because an invite token GRANTS membership
// rather than just naming a public row.
function mintInviteToken(): string {
  const out: string[] = [];
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    out.push((b % 36).toString(36));
  }
  return out.join("");
}

export function inviteUrlFor(token: string): string {
  if (typeof window === "undefined") return `/join/${token}`;
  return `${window.location.origin}/join/${token}`;
}

// Members of a project (collaborators only — the owner is implicit via
// projects.user_id and rendered separately by the popover). Two-step
// like the listing queries: membership rows, then a profiles batch.
export async function listCollaborators(
  projectId: string
): Promise<CollaboratorEntry[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("project_collaborators")
    .select("user_id, role, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) {
    if (error.code !== "42P01") {
      console.error("listCollaborators failed:", error);
    }
    return [];
  }
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.user_id as string);
  const { data: profs } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url")
    .in("id", ids);
  const byId = new Map<
    string,
    { display_name: string | null; avatar_url: string | null }
  >();
  for (const p of profs ?? []) {
    byId.set(p.id as string, {
      display_name: (p.display_name as string | null) ?? null,
      avatar_url: (p.avatar_url as string | null) ?? null,
    });
  }
  return rows.map((r) => ({
    user_id: r.user_id as string,
    role: r.role as string,
    created_at: r.created_at as string,
    display_name: byId.get(r.user_id as string)?.display_name ?? null,
    avatar_url: byId.get(r.user_id as string)?.avatar_url ?? null,
  }));
}

// Owner removes a member (RLS also lets a member remove themself —
// "leave" — through the same call). The removed user's open editor
// keeps working until their next save, which RLS then rejects into the
// fork-a-copy path; their Shared tab drops the row on next refresh.
export async function removeCollaborator(
  projectId: string,
  userId: string
): Promise<boolean> {
  const supabase = createClient();
  const { error } = await supabase
    .from("project_collaborators")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) {
    console.error("removeCollaborator failed:", error);
    return false;
  }
  return true;
}

function toInviteLink(row: {
  token: string;
  expires_at: string;
}): InviteLink {
  return {
    token: row.token,
    url: inviteUrlFor(row.token),
    expiresAt: row.expires_at,
  };
}

// The popover shows ONE link per project: the newest live (unrevoked,
// unexpired) invite, minting on demand. Repeated opens reuse the same
// link, so "copy" is idempotent until the owner resets or it expires.
export async function getOrCreateInviteLink(
  projectId: string
): Promise<InviteLink | null> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return null;
  const { data, error } = await supabase
    .from("project_invites")
    .select("token, expires_at")
    .eq("project_id", projectId)
    .eq("revoked", false)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (error.code !== "42P01") {
      console.error("getOrCreateInviteLink lookup failed:", error);
    }
    return null;
  }
  if (data && data.length > 0) {
    return toInviteLink(data[0] as { token: string; expires_at: string });
  }
  const token = mintInviteToken();
  const { data: inserted, error: insErr } = await supabase
    .from("project_invites")
    .insert({
      token,
      project_id: projectId,
      created_by: userResp.user.id,
    })
    .select("token, expires_at")
    .single();
  if (insErr || !inserted) {
    console.error("getOrCreateInviteLink insert failed:", insErr);
    return null;
  }
  return toInviteLink(inserted as { token: string; expires_at: string });
}

// Revoke every live invite for the project and mint a fresh one. The
// old links fail closed at the RPC (revoked flag), so a leaked link
// dies the moment the owner resets.
export async function resetInviteLink(
  projectId: string
): Promise<InviteLink | null> {
  const supabase = createClient();
  const { error } = await supabase
    .from("project_invites")
    .update({ revoked: true })
    .eq("project_id", projectId)
    .eq("revoked", false);
  if (error && error.code !== "42P01") {
    console.error("resetInviteLink revoke failed:", error);
    return null;
  }
  return getOrCreateInviteLink(projectId);
}

// Preview for /join/<token>. Takes the supabase client as an argument
// so the server page (SSR client) and the browser share one code path.
// Null = token doesn't exist (or pre-migration DB) → 404.
export async function getProjectInvite(
  client: ReturnType<typeof createClient>,
  token: string
): Promise<InvitePreview | null> {
  const { data, error } = await client.rpc("get_project_invite", {
    invite_token: token,
  });
  if (error) {
    if (error.code !== "42883") {
      // 42883 = function doesn't exist (pre-migration) — quiet 404.
      console.error("getProjectInvite failed:", error);
    }
    return null;
  }
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (!row) return null;
  return {
    projectId: row.project_id as string,
    projectName: row.project_name as string,
    ownerName: (row.owner_name as string | null) ?? null,
    status: row.status as InvitePreview["status"],
  };
}

export async function redeemProjectInvite(
  token: string
): Promise<{ projectId: string } | { error: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("redeem_project_invite", {
    invite_token: token,
  });
  if (error) {
    console.error("redeemProjectInvite failed:", error);
    return { error: error.message ?? "could not accept the invite" };
  }
  // The new membership must show up in the Shared tab and in
  // loadProject's shared_with_me immediately.
  invalidateProjectCaches();
  return { projectId: data as string };
}
