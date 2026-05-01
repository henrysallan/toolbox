import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPublicProjectBySlug } from "@/lib/supabase/projects";
import EditorClient from "./EditorClient";
import type { Metadata } from "next";

// `/p/<slug>` opens a public project in the FULL editor UI (in
// contrast to `/live/<slug>`, which renders the minimal client view).
// The graph itself is loaded server-side from the slug; the client
// component bootstraps EffectsApp with that payload.
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
  const project = await loadPublicProjectBySlug(supabase, slug);
  if (!project) {
    return { title: "Project · not found" };
  }
  return {
    title: `${project.name} · Toolbox`,
    description: project.author?.display_name
      ? `A patch by ${project.author.display_name} on Toolbox`
      : "A patch on Toolbox",
  };
}

export default async function ProjectPage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const project = await loadPublicProjectBySlug(supabase, slug);
  if (!project) notFound();

  return (
    <EditorClient
      id={project.id}
      name={project.name}
      isPublic={true}
      publicSlug={project.public_slug}
      ownerId={project.user_id}
      authorName={project.author?.display_name ?? null}
      graph={project.graph}
    />
  );
}
