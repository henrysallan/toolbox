import { createClient } from "@/lib/supabase/client";
import type { SavedProject } from "@/lib/project";

export interface ProjectRow {
  id: string;
  name: string;
  thumbnail: string | null;
  updated_at: string;
  created_at: string;
}

export async function saveProject(
  name: string,
  graph: SavedProject,
  thumbnail: string | null
): Promise<{ id: string } | null> {
  const supabase = createClient();
  const { data: userResp } = await supabase.auth.getUser();
  if (!userResp.user) return null;
  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: userResp.user.id,
      name,
      graph,
      thumbnail,
    })
    .select("id")
    .single();
  if (error) {
    console.error("saveProject failed:", error);
    return null;
  }
  return { id: data.id };
}

// Overwrites the graph + thumbnail on an existing project row. Name is
// preserved; use a separate create (saveProject) for a rename-style save.
// `updated_at` is nudged explicitly so the load grid reorders correctly.
export async function updateProject(
  id: string,
  graph: SavedProject,
  thumbnail: string | null
): Promise<boolean> {
  const supabase = createClient();
  const { error } = await supabase
    .from("projects")
    .update({
      graph,
      thumbnail,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error("updateProject failed:", error);
    return false;
  }
  return true;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, thumbnail, updated_at, created_at")
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("listProjects failed:", error);
    return [];
  }
  return data ?? [];
}

export async function loadProject(
  id: string
): Promise<{ name: string; graph: SavedProject } | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("name, graph")
    .eq("id", id)
    .single();
  if (error) {
    console.error("loadProject failed:", error);
    return null;
  }
  return { name: data.name as string, graph: data.graph as SavedProject };
}

export async function deleteProject(id: string): Promise<boolean> {
  const supabase = createClient();
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) {
    console.error("deleteProject failed:", error);
    return false;
  }
  return true;
}
