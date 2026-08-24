import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProjectInvite } from "@/lib/supabase/project-collaborators";
import JoinClient from "./JoinClient";
import type { Metadata } from "next";

// `/join/<token>` — invite-link redemption (shared projects M2,
// specdocs/081426_shared-projects.md). The preview (project name +
// owner + validity) resolves server-side through the security-definer
// get_project_invite RPC — the redeemer can't read the invites table or
// the project row directly. Redemption itself is an explicit client
// action (a stray prefetch of the URL must never grant membership).
//
// Dynamic on purpose: a revoked or expired link must die on the next
// page load, not after a revalidation window.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { token } = await params;
  const supabase = await createClient();
  const invite = await getProjectInvite(supabase, token);
  if (!invite) {
    return { title: "Invite · not found" };
  }
  return {
    title: `Join ${invite.projectName} · Toolbox`,
    description: invite.ownerName
      ? `${invite.ownerName} invited you to collaborate on Toolbox`
      : "An invitation to collaborate on Toolbox",
  };
}

export default async function JoinPage({ params }: PageProps) {
  const { token } = await params;
  const supabase = await createClient();
  const invite = await getProjectInvite(supabase, token);
  if (!invite) notFound();

  return <JoinClient token={token} initial={invite} />;
}
