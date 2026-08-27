import { invoke } from "@tauri-apps/api/core";
import type { SidebarNode } from "./categories";
import type { Design, DesignStatus, ReferenceItem, ReferenceStatus, ReferencesResponse, LibraryResponse } from "./types";

export interface BackupInfo {
  path: string;
  folder: string;
  categories: number;
  designs: number;
  manualCategoryDesigns: number;
}

export interface BrandLogo {
  dataUrl: string;
  width: number;
  height: number;
}

export async function scanLibrary(rootPath: string) {
  return invoke<LibraryResponse>("scan_library", { rootPath });
}

export async function reloadPreferencesIfUnusable(rootPath: string) {
  return invoke<LibraryResponse | null>("reload_preferences_if_unusable", { rootPath });
}

export async function rescanPaths(rootPath: string, paths: string[]) {
  return invoke<LibraryResponse>("rescan_paths", { rootPath, paths });
}

export async function detectLibraryChanges(rootPath: string) {
  return invoke<LibraryResponse | null>("detect_library_changes", { rootPath });
}

export async function getInitialState() {
  return invoke<LibraryResponse>("get_initial_state");
}

export async function getBrandLogo() {
  return invoke<BrandLogo | null>("get_brand_logo");
}

export async function saveBrandLogo(sourcePath: string) {
  return invoke<BrandLogo>("save_brand_logo", { sourcePath });
}

export async function removeBrandLogo() {
  await invoke("remove_brand_logo");
}

export async function listSystemFonts() {
  return invoke<string[]>("list_system_fonts");
}

export async function getReferences(rootPath: string) {
  return invoke<ReferencesResponse>("get_references", { rootPath });
}

export async function scanReferences(rootPath: string) {
  return invoke<ReferencesResponse>("scan_references", { rootPath });
}

export async function rescanReferencePaths(rootPath: string, paths: string[]) {
  return invoke<ReferencesResponse>("rescan_reference_paths", { rootPath, paths });
}

export async function detectReferenceChanges(rootPath: string) {
  return invoke<ReferencesResponse | null>("detect_reference_changes", { rootPath });
}

export async function createReferenceCategory(rootPath: string, name: string) {
  return invoke<string>("create_reference_category", { rootPath, name });
}

export async function updateReferenceFavorite(referenceId: string, favorite: boolean) {
  await invoke("update_reference_favorite", { referenceId, favorite });
}

export async function updateReferenceStatus(referenceId: string, status: ReferenceStatus) {
  await invoke("update_reference_status", { referenceId, status });
}

export async function sendReferenceToWork(rootPath: string, referenceId: string, workName: string) {
  return invoke<ReferenceItem>("send_reference_to_work", { rootPath, referenceId, workName });
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

export async function saveSidebarLayout(nodes: SidebarNode[]) {
  return invoke<SidebarNode[]>("save_sidebar_layout", { nodes });
}

export async function createCategoryGroup(name: string) {
  return invoke<string>("create_category_group", { name });
}

export async function renameCategoryGroup(currentName: string, newName: string) {
  return invoke<string>("rename_category_group", { currentName, newName });
}

export async function deleteCategoryGroup(name: string) {
  await invoke("delete_category_group", { name });
}

export async function setCategoryGroupCollapsed(name: string, collapsed: boolean) {
  await invoke("set_category_group_collapsed", { name, collapsed });
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

export async function generateThumbnailsBulk(items: Array<[string, number]>) {
  return invoke<Array<[string, string | null]>>("generate_thumbnails_bulk", { items });
}

export async function generatePreview(previewPath: string, updatedAt: number) {
  return invoke<string | null>("generate_preview", { previewPath, updatedAt });
}

export async function generatePreviewsBulk(items: Array<[string, number]>) {
  return invoke<Array<[string, string | null]>>("generate_previews_bulk", { items });
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
