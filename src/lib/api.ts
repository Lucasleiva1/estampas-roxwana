import { invoke } from "@tauri-apps/api/core";
import type { DesignStatus, LibraryResponse } from "./types";

const DEFAULT_LIBRARY_PATH = "C:\\Users\\jaell\\Documents\\estampas-roxwana";

export async function scanLibrary(rootPath = DEFAULT_LIBRARY_PATH) {
  return invoke<LibraryResponse>("scan_library", { rootPath });
}

export async function rescanPaths(rootPath: string, paths: string[]) {
  return invoke<LibraryResponse>("rescan_paths", { rootPath, paths });
}

export async function getInitialState() {
  return invoke<LibraryResponse>("get_initial_state");
}

export async function updateFavorite(designId: string, favorite: boolean) {
  await invoke("update_design_favorite", { designId, favorite });
}

export async function updateStatus(designId: string, status: DesignStatus) {
  await invoke("update_design_status", { designId, status });
}

export async function updateCategory(designId: string, category: string | null) {
  await invoke("update_design_category", { designId, category });
}

export async function addTag(designId: string, tag: string) {
  await invoke("add_design_tag", { designId, tag });
}

export async function removeTag(designId: string, tag: string) {
  await invoke("remove_design_tag", { designId, tag });
}

export async function generateThumbnail(previewPath: string, updatedAt: number) {
  return invoke<string | null>("generate_thumbnail", { previewPath, updatedAt });
}

export async function openDesignFolder(path: string) {
  await invoke("open_design_folder", { path });
}

export async function revealDesignFile(path: string) {
  await invoke("reveal_design_file", { path });
}
