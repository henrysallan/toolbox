import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadEditorProjectBySlug } from "@/lib/supabase/projects";
import EditorClient from "./EditorClient";
import PrivateProjectGate from "./PrivateProjectGate";
import type { Metadata } from "next";

// `/p/<slug>` opens a project in the FULL editor UI (in contrast to
// `/live/<slug>`, which renders the minimal client view and stays
// public-only). Owner and collaborator can open a private slug; anyone
// else sees a login gate — the graph never reaches the client.
//
// The slug → row resolve is dynamic (force-dynamic) so private flips
// or renames propagate immediately, same as /live/<slug>.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const project = await loadEditorProjectBySlug(supabase, slug);
  if (project.status === "missing") {
    return { title: "Project · not found" };
  }
  if (project.status === "private") {
    return {
      title: "Private project · Toolbox",
      robots: { index: false, follow: false },
    };
  }
  const meta: Metadata = {
    title: `${project.name} · Toolbox`,
    description: project.author?.display_name
      ? `A patch by ${project.author.display_name} on Toolbox`
      : "A patch on Toolbox",
  };
  if (!project.is_public) {
    meta.robots = { index: false, follow: false };
  }
  return meta;
}

export default async function ProjectPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const project = await loadEditorProjectBySlug(supabase, slug);
  if (project.status === "missing") notFound();
  if (project.status === "private") {
    return <PrivateProjectGate slug={slug} />;
  }

  return (
    <EditorClient
      id={project.id}
      name={project.name}
      isPublic={project.is_public}
      publicSlug={project.public_slug}
      ownerId={project.user_id}
      authorName={project.author?.display_name ?? null}
      graph={project.graph}
      updatedAt={project.updated_at}
      sharedWithMe={project.shared_with_me}
      hasCollaborators={project.has_collaborators}
    />
  );
}
