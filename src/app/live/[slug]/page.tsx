import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPublicProjectBySlug } from "@/lib/supabase/projects";
import LiveClient from "./LiveClient";
import type { Metadata } from "next";

// Live links are dynamic — every visit re-resolves the row by slug so
// flipping a project private (or renaming it) is reflected on the next
// page load without revalidation lag.
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
    return { title: "Live · not found" };
  }
  return {
    title: `${project.name} · Toolbox Live`,
    description: project.author?.display_name
      ? `A live patch by ${project.author.display_name} on Toolbox`
      : "A live patch on Toolbox",
  };
}

export default async function LivePage({ params }: PageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const project = await loadPublicProjectBySlug(supabase, slug);
  if (!project) notFound();

  return (
    <LiveClient
      slug={slug}
      name={project.name}
      authorName={project.author?.display_name ?? null}
      graph={project.graph}
    />
  );
}
