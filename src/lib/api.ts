import { invoke } from "@tauri-apps/api/core";
import type { Design, DesignStatus, LibraryResponse } from "./types";

const DEFAULT_LIBRARY_PATH = "C:\\Users\\jaell\\Documents\\estampas-roxwana";

export interface BackupInfo {
  path: string;
  folder: string;
  categories: number;
  designs: number;
  manualCategoryDesigns: number;
}

export async function scanLibrary(rootPath = DEFAULT_LIBRARY_PATH) {
  return invoke<LibraryResponse>("scan_library", { rootPath });
}

export async function rescanPaths(rootPath: string, paths: string[]) {
  return invoke<LibraryResponse>("rescan_paths", { rootPath, paths });
}

export async function getInitialState() {
  return invoke<LibraryResponse>("get_initial_state");
}

export async function getLibraryFromDb() {
  return invoke<LibraryResponse>("get_library_from_db");
}

export async function getDesignDetail(designId: string) {
  return invoke<Design | null>("get_design_detail", { designId });
}

export async function updateFavorite(designId: string, favorite: boolean) {
  await invoke("update_design_favorite", { designId, favorite });
}

export async function updateStatus(designId: string, status: DesignStatus) {
  await invoke("update_design_status", { designId, status });
}

export async function updateCategory(designId: string, category: string | null) {
  return invoke<string | null>("update_design_category", { designId, category });
}

export async function createCategory(name: string) {
  return invoke<string>("create_category", { name });
}

export async function renameCategory(currentName: string, newName: string) {
  return invoke<string>("rename_category", { currentName, newName });
}

export async function deleteCategory(name: string) {
  await invoke("delete_category", { name });
}

export async function reorderCategories(categories: string[]) {
  return invoke<string[]>("reorder_categories", { categories });
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

export async function generatePreview(previewPath: string, updatedAt: number) {
  return invoke<string | null>("generate_preview", { previewPath, updatedAt });
}

export async function openDesignFolder(path: string) {
  await invoke("open_design_folder", { path });
}

export async function revealDesignFile(path: string) {
  await invoke("reveal_design_file", { path });
}

export async function saveDatabaseBackup() {
  return invoke<BackupInfo>("save_database_backup");
}

export async function openBackupFolder() {
  return invoke<string>("open_backup_folder");
}

export async function restoreDatabaseBackup(backupPath: string) {
  return invoke<LibraryResponse>("restore_database_backup", { backupPath });
}
