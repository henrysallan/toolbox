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

export async function loadProject(id: string): Promise<SavedProject | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("graph")
    .eq("id", id)
    .single();
  if (error) {
    console.error("loadProject failed:", error);
    return null;
  }
  return data.graph as SavedProject;
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
