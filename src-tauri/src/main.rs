#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const DEFAULT_LIBRARY_PATH: &str = r"C:\Users\jaell\Documents\estampas-roxwana";
const FREEPIK_DIR_NAME: &str = "Freepik";
const WORKS_DIR_NAME: &str = "Trabajos";
const CATEGORIES_DIR_NAME: &str = "Categorías";
const LOOSE_DIR_NAME: &str = "Suelta";
const REFERENCES_DIR_NAME: &str = "Referencias";
const LEGACY_COMPLETE_DIR_NAME: &str = "1-COMPLETAS";
const PREVIEW_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp"];
const SUPPORT_EXTENSIONS: &[&str] = &[".ai", ".psd", ".svg", ".pdf", ".eps", ".zip", ".txt"];
const STATUSES: &[&str] = &["pending", "working", "ready", "discarded"];
const REFERENCE_STATUSES: &[&str] = &["pending", "working", "done"];
const CONTENT_LAYOUT_VERSION: &str = "github-layout-restored-v1";
const BACKUP_FILE_NAME: &str = "biblioteca-visual-respaldo.sqlite";
const RESTORE_SAFETY_FILE_NAME: &str = "biblioteca-visual-antes-de-cargar.sqlite";
const BRAND_LOGO_FILE_NAME: &str = "brand-logo.png";
const BRAND_LOGO_MAX_SOURCE_BYTES: u64 = 40 * 1024 * 1024;
const BRAND_LOGO_MAX_PIXELS: u64 = 100_000_000;
const BRAND_LOGO_MAX_SIDE: u32 = 1600;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryResponse {
    root_path: String,
    designs: Vec<Design>,
    stats: LibraryStats,
    categories: Vec<String>,
    sidebar: Vec<SidebarNode>,
    tags: Vec<String>,
}

/// One row of the category panel: either a loose category or a group that holds
/// categories inside it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidebarNode {
    kind: String,
    name: String,
    collapsed: bool,
    children: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidebarNodeInput {
    kind: String,
    name: String,
    #[serde(default)]
    collapsed: bool,
    #[serde(default)]
    children: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryStats {
    designs: usize,
    files: usize,
    previews: usize,
    support: usize,
    missing: usize,
    by_extension: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    path: String,
    folder: String,
    categories: usize,
    designs: usize,
    manual_category_designs: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrandLogo {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferencesResponse {
    root_path: String,
    references_path: String,
    works_path: String,
    references: Vec<ReferenceItem>,
    categories: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceItem {
    id: String,
    name: String,
    file_name: String,
    path: String,
    folder_path: String,
    category: String,
    thumbnail_path: Option<String>,
    size: u64,
    modified: i64,
    favorite: bool,
    status: String,
    work_path: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Design {
    id: String,
    name: String,
    path: String,
    directory: String,
    group_type: String,
    preview_path: Option<String>,
    preview_cache_path: Option<String>,
    thumbnail_path: Option<String>,
    total_files: usize,
    updated_at: i64,
    counts: SupportCounts,
    files: Vec<DesignFile>,
    classification: Classification,
    auto_category: Option<String>,
    auto_tags: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportCounts {
    ai: usize,
    psd: usize,
    svg: usize,
    pdf: usize,
    eps: usize,
    zip: usize,
    txt: usize,
    other: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesignFile {
    id: String,
    design_id: String,
    path: String,
    file_name: String,
    extension: String,
    kind: String,
    size: u64,
    modified: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Classification {
    favorite: bool,
    status: String,
    category: Option<String>,
    tags: Vec<String>,
    category_user_set: bool,
}

#[derive(Clone, Debug)]
struct CollectedDesign {
    id: String,
    name: String,
    path: PathBuf,
    directory: PathBuf,
    group_type: String,
    preview_path: Option<PathBuf>,
    preview_cache_path: Option<PathBuf>,
    thumbnail_path: Option<PathBuf>,
    files: Vec<DesignFile>,
    #[allow(dead_code)]
    counts: SupportCounts,
    updated_at: i64,
    auto_category: Option<String>,
    auto_tags: Vec<String>,
}

#[derive(Clone, Debug)]
struct GroupBuilder {
    key_path: PathBuf,
    directory: PathBuf,
    group_type: String,
    name: String,
    folder_category: Option<String>,
    files: Vec<DesignFile>,
}

#[tauri::command]
fn get_initial_state(app: AppHandle) -> Result<LibraryResponse, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    migrate_legacy_cache_to_portable(&app, &conn)?;
    let root =
        get_setting(&conn, "library_root")?.unwrap_or_else(|| DEFAULT_LIBRARY_PATH.to_string());
    let root_exists = PathBuf::from(&root).exists();
    let layout_needs_rescan =
        get_setting(&conn, "content_layout_version")?.as_deref() != Some(CONTENT_LAYOUT_VERSION);
    let should_scan = root_exists
        && (active_design_count(&conn)? == 0
            || active_library_has_missing_paths(&conn)?
            || layout_needs_rescan);

    if !root_exists {
        conn.execute("UPDATE designs SET missing = 1", [])
            .map_err(to_string)?;
        conn.execute("UPDATE files SET missing = 1", [])
            .map_err(to_string)?;
    }
    drop(conn);

    if should_scan {
        scan_library_impl(&app, &root)
    } else {
        let conn = open_database(&app)?;
        ensure_database(&conn)?;
        load_library_from_db(&conn, &root)
    }
}

#[tauri::command]
fn get_brand_logo(app: AppHandle) -> Result<Option<BrandLogo>, String> {
    read_brand_logo(&app)
}

#[tauri::command]
async fn save_brand_logo(app: AppHandle, source_path: String) -> Result<BrandLogo, String> {
    tauri::async_runtime::spawn_blocking(move || save_brand_logo_impl(&app, &source_path))
        .await
        .map_err(to_string)?
}

#[tauri::command]
fn remove_brand_logo(app: AppHandle) -> Result<(), String> {
    remove_file_if_exists(&brand_logo_path(&app)?)
}

#[tauri::command]
fn get_references(app: AppHandle, root_path: String) -> Result<ReferencesResponse, String> {
    scan_references_impl(&app, &root_path)
}

#[tauri::command]
fn scan_references(app: AppHandle, root_path: String) -> Result<ReferencesResponse, String> {
    scan_references_impl(&app, &root_path)
}

#[tauri::command]
fn create_reference_category(root_path: String, name: String) -> Result<String, String> {
    let folder_name = safe_folder_name(&name)?;
    let references_path = PathBuf::from(&root_path).join(REFERENCES_DIR_NAME);
    fs::create_dir_all(&references_path)
        .map_err(|error| format!("No se pudo preparar Referencias: {error}"))?;
    let category_path = references_path.join(&folder_name);
    if category_path.exists() {
        return Err("Ya existe una carpeta de referencias con ese nombre".to_string());
    }
    fs::create_dir(&category_path)
        .map_err(|error| format!("No se pudo crear la carpeta de referencias: {error}"))?;
    Ok(folder_name)
}

#[tauri::command]
fn update_reference_favorite(
    app: AppHandle,
    reference_id: String,
    favorite: bool,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE reference_images SET favorite = ?1 WHERE id = ?2",
        params![favorite as i32, reference_id],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn update_reference_status(
    app: AppHandle,
    reference_id: String,
    status: String,
) -> Result<(), String> {
    if !REFERENCE_STATUSES.contains(&status.as_str()) {
        return Err(format!("Estado de referencia invalido: {status}"));
    }
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE reference_images SET status = ?1 WHERE id = ?2",
        params![status, reference_id],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn send_reference_to_work(
    app: AppHandle,
    root_path: String,
    reference_id: String,
    work_name: String,
) -> Result<ReferenceItem, String> {
    send_reference_to_work_impl(&app, &root_path, &reference_id, &work_name)
}

#[tauri::command]
fn get_library_from_db(app: AppHandle) -> Result<LibraryResponse, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let root =
        get_setting(&conn, "library_root")?.unwrap_or_else(|| DEFAULT_LIBRARY_PATH.to_string());
    load_library_from_db(&conn, &root)
}

#[tauri::command]
fn get_design_detail(app: AppHandle, design_id: String) -> Result<Option<Design>, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    load_design_from_db(&conn, &design_id, true)
}

#[tauri::command]
fn scan_library(app: AppHandle, root_path: String) -> Result<LibraryResponse, String> {
    scan_library_impl(&app, &root_path)
}

#[tauri::command]
fn rescan_paths(
    app: AppHandle,
    root_path: String,
    paths: Vec<String>,
) -> Result<LibraryResponse, String> {
    if paths.is_empty() || paths.len() > 80 {
        return scan_library_impl(&app, &root_path);
    }

    rescan_paths_impl(&app, &root_path, &paths)
}

#[tauri::command]
async fn generate_thumbnail(
    app: AppHandle,
    preview_path: String,
    updated_at: i64,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&preview_path);
        let thumbnail = ensure_thumbnail(&app, Some(&path), updated_at)?;

        if let Some(thumbnail_path) = &thumbnail {
            let conn = open_database(&app)?;
            ensure_database(&conn)?;
            conn.execute(
                "UPDATE designs SET thumbnail_path = ?1 WHERE preview_path = ?2",
                params![path_to_string(thumbnail_path), preview_path],
            )
            .map_err(to_string)?;
        }

        Ok(thumbnail.map(|path| path_to_string(&path)))
    })
    .await
    .map_err(to_string)?
}

/// Cantidad de hilos para convertir imagenes en paralelo. Deja nucleos libres
/// para que la ventana de la app siga respondiendo mientras trabaja.
fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(2).max(1))
        .unwrap_or(1)
}

/// Genera las miniaturas de un lote completo repartiendo el trabajo entre
/// varios hilos, con una sola escritura a la base de datos al final. Antes se
/// hacia de a una desde el frontend, con un hilo y una conexion a la base por
/// imagen: con miles de imagenes eso tardaba horas.
#[tauri::command]
async fn generate_thumbnails_bulk(
    app: AppHandle,
    items: Vec<(String, i64)>,
) -> Result<Vec<(String, Option<String>)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workers = worker_count().min(items.len().max(1));
        let queue = std::sync::Mutex::new(items.into_iter());
        let results = std::sync::Mutex::new(Vec::new());

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let Some((preview_path, updated_at)) =
                        queue.lock().ok().and_then(|mut q| q.next())
                    else {
                        break;
                    };
                    let path = PathBuf::from(&preview_path);
                    let thumbnail = ensure_thumbnail(&app, Some(&path), updated_at)
                        .ok()
                        .flatten()
                        .map(|found| path_to_string(&found));
                    if let Ok(mut sink) = results.lock() {
                        sink.push((preview_path, thumbnail));
                    }
                });
            }
        });

        let done = results
            .into_inner()
            .map_err(|_| "hilo interrumpido".to_string())?;

        let mut conn = open_database(&app)?;
        ensure_database(&conn)?;
        let tx = conn.transaction().map_err(to_string)?;
        for (preview_path, thumbnail) in &done {
            if let Some(thumbnail_path) = thumbnail {
                tx.execute(
                    "UPDATE designs SET thumbnail_path = ?1 WHERE preview_path = ?2",
                    params![thumbnail_path, preview_path],
                )
                .map_err(to_string)?;
            }
        }
        tx.commit().map_err(to_string)?;

        Ok(done)
    })
    .await
    .map_err(to_string)?
}

/// Prepara las vistas grandes que usa el visor usando todos los trabajadores
/// reservados para cache. `worker_count` ya deja dos procesadores logicos
/// libres para que la ventana siga respondiendo.
#[tauri::command]
async fn generate_previews_bulk(
    app: AppHandle,
    items: Vec<(String, i64)>,
) -> Result<Vec<(String, Option<String>)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workers = worker_count().min(items.len().max(1));
        let queue = std::sync::Mutex::new(items.into_iter());
        let results = std::sync::Mutex::new(Vec::new());

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let Some((preview_path, updated_at)) =
                        queue.lock().ok().and_then(|mut queue| queue.next())
                    else {
                        break;
                    };
                    let path = PathBuf::from(&preview_path);
                    let preview = ensure_preview_cache(&app, Some(&path), updated_at)
                        .ok()
                        .flatten()
                        .map(|found| path_to_string(&found));
                    if let Ok(mut sink) = results.lock() {
                        sink.push((preview_path, preview));
                    }
                });
            }
        });

        let done = results
            .into_inner()
            .map_err(|_| "hilo interrumpido".to_string())?;

        let mut conn = open_database(&app)?;
        ensure_database(&conn)?;
        let tx = conn.transaction().map_err(to_string)?;
        for (preview_path, preview) in &done {
            if let Some(preview_cache_path) = preview {
                tx.execute(
                    "UPDATE designs SET preview_cache_path = ?1 WHERE preview_path = ?2",
                    params![preview_cache_path, preview_path],
                )
                .map_err(to_string)?;
            }
        }
        tx.commit().map_err(to_string)?;

        Ok(done)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
async fn generate_preview(
    app: AppHandle,
    preview_path: String,
    updated_at: i64,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&preview_path);
        let preview = ensure_preview_cache(&app, Some(&path), updated_at)?;

        if let Some(preview_cache_path) = &preview {
            let conn = open_database(&app)?;
            ensure_database(&conn)?;
            conn.execute(
                "UPDATE designs SET preview_cache_path = ?1 WHERE preview_path = ?2",
                params![path_to_string(preview_cache_path), preview_path],
            )
            .map_err(to_string)?;
        }

        Ok(preview.map(|path| path_to_string(&path)))
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
fn update_design_favorite(app: AppHandle, design_id: String, favorite: bool) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE designs SET favorite = ?1 WHERE id = ?2",
        params![favorite as i32, design_id],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn update_design_status(app: AppHandle, design_id: String, status: String) -> Result<(), String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("Estado invalido: {status}"));
    }

    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE designs SET status = ?1 WHERE id = ?2",
        params![status, design_id],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn update_design_category(
    app: AppHandle,
    design_id: String,
    category: Option<String>,
) -> Result<Option<String>, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let normalized = category.and_then(|value| normalize_category(&value));

    if let Some(category_name) = &normalized {
        upsert_category(&conn, category_name, true)?;
    }

    conn.execute(
        "UPDATE designs SET category = ?1, category_user_set = 1 WHERE id = ?2",
        params![normalized, design_id],
    )
    .map_err(to_string)?;
    Ok(normalized)
}

#[tauri::command]
fn create_category(app: AppHandle, name: String) -> Result<String, String> {
    let category =
        normalize_category(&name).ok_or_else(|| "La categoria esta vacia".to_string())?;
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    ensure_sidebar_name_free(
        &conn,
        &category.to_lowercase(),
        None,
        Some(&category.to_lowercase()),
    )?;
    upsert_category(&conn, &category, true)?;
    Ok(category)
}

#[tauri::command]
fn rename_category(
    app: AppHandle,
    current_name: String,
    new_name: String,
) -> Result<String, String> {
    let current_lower = current_name.trim().to_lowercase();
    if current_lower.is_empty() {
        return Err("La categoria actual es invalida".to_string());
    }

    let renamed =
        normalize_category(&new_name).ok_or_else(|| "La categoria esta vacia".to_string())?;
    let renamed_lower = renamed.to_lowercase();
    let conn = open_database(&app)?;
    ensure_database(&conn)?;

    let current_display_name: String = conn
        .query_row(
            "SELECT name FROM categories WHERE lower_name = ?1",
            params![current_lower],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_string)?
        .ok_or_else(|| "No encontre esa categoria".to_string())?;

    if renamed_lower != current_lower {
        let existing: Option<String> = conn
            .query_row(
                "SELECT name FROM categories WHERE lower_name = ?1",
                params![renamed_lower],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_string)?;
        if existing.is_some() {
            return Err("Ya existe una categoria con ese nombre".to_string());
        }
    }

    conn.execute(
        "UPDATE categories SET name = ?1, lower_name = ?2, user_created = 1 WHERE lower_name = ?3",
        params![renamed, renamed_lower, current_lower],
    )
    .map_err(to_string)?;
    conn.execute(
        "UPDATE designs SET category = ?1, category_user_set = 1 WHERE category = ?2 COLLATE NOCASE",
        params![renamed, current_display_name],
    )
    .map_err(to_string)?;

    Ok(renamed)
}

#[tauri::command]
fn delete_category(app: AppHandle, name: String) -> Result<(), String> {
    let lower_name = name.trim().to_lowercase();
    if lower_name.is_empty() {
        return Err("La categoria es invalida".to_string());
    }

    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let display_name: Option<String> = conn
        .query_row(
            "SELECT name FROM categories WHERE lower_name = ?1",
            params![lower_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(to_string)?;
    let Some(display_name) = display_name else {
        return Ok(());
    };

    conn.execute(
        "UPDATE designs SET category = NULL, category_user_set = 1 WHERE category = ?1 COLLATE NOCASE",
        params![display_name],
    )
    .map_err(to_string)?;
    conn.execute(
        "DELETE FROM categories WHERE lower_name = ?1",
        params![lower_name],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn save_sidebar_layout(
    app: AppHandle,
    nodes: Vec<SidebarNodeInput>,
) -> Result<Vec<SidebarNode>, String> {
    let mut conn = open_database(&app)?;
    ensure_database(&conn)?;
    write_sidebar_layout(&mut conn, &nodes)
}

#[tauri::command]
fn create_category_group(app: AppHandle, name: String) -> Result<String, String> {
    let group = normalize_category(&name).ok_or_else(|| "El grupo esta vacio".to_string())?;
    let lower = group.to_lowercase();
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    ensure_sidebar_name_free(&conn, &lower, None, None)?;

    conn.execute(
        "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
         VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(sort_order) + 1 FROM category_groups), 0), 0)",
        params![stable_id(&format!("group:{lower}")), group, lower],
    )
    .map_err(to_string)?;
    Ok(group)
}

#[tauri::command]
fn rename_category_group(
    app: AppHandle,
    current_name: String,
    new_name: String,
) -> Result<String, String> {
    let current_lower = current_name.trim().to_lowercase();
    if current_lower.is_empty() {
        return Err("El grupo actual es invalido".to_string());
    }
    let renamed = normalize_category(&new_name).ok_or_else(|| "El grupo esta vacio".to_string())?;
    let renamed_lower = renamed.to_lowercase();

    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    ensure_sidebar_name_free(&conn, &renamed_lower, Some(&current_lower), None)?;

    let updated = conn
        .execute(
            "UPDATE category_groups SET name = ?1, lower_name = ?2 WHERE lower_name = ?3",
            params![renamed, renamed_lower, current_lower],
        )
        .map_err(to_string)?;
    if updated == 0 {
        return Err("No encontre ese grupo".to_string());
    }
    Ok(renamed)
}

/// Deleting a group only removes the box: the categories inside go back to the
/// panel, keeping the spot the group had.
#[tauri::command]
fn delete_category_group(app: AppHandle, name: String) -> Result<(), String> {
    let lower = name.trim().to_lowercase();
    if lower.is_empty() {
        return Err("El grupo es invalido".to_string());
    }

    let mut conn = open_database(&app)?;
    ensure_database(&conn)?;

    let group: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, sort_order FROM category_groups WHERE lower_name = ?1",
            params![lower],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(to_string)?;
    let (group_id, sort_order) = group.ok_or_else(|| "No encontre ese grupo".to_string())?;

    let transaction = conn.transaction().map_err(to_string)?;
    transaction
        .execute(
            "UPDATE categories SET group_id = NULL, sort_order = ?1 WHERE group_id = ?2",
            params![sort_order, group_id],
        )
        .map_err(to_string)?;
    transaction
        .execute(
            "DELETE FROM category_groups WHERE id = ?1",
            params![group_id],
        )
        .map_err(to_string)?;
    transaction.commit().map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn set_category_group_collapsed(
    app: AppHandle,
    name: String,
    collapsed: bool,
) -> Result<(), String> {
    let lower = name.trim().to_lowercase();
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE category_groups SET collapsed = ?1 WHERE lower_name = ?2",
        params![collapsed as i32, lower],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn add_design_tag(app: AppHandle, design_id: String, tag: String) -> Result<(), String> {
    let normalized = normalize_tag(&tag).ok_or_else(|| "La etiqueta esta vacia".to_string())?;
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let tag_id = upsert_tag(&conn, &normalized)?;

    conn.execute(
        "DELETE FROM ignored_auto_tags WHERE design_id = ?1 AND lower_name = ?2",
        params![design_id, normalized.to_lowercase()],
    )
    .map_err(to_string)?;
    conn.execute(
        "INSERT INTO design_tags (design_id, tag_id, source)
         VALUES (?1, ?2, 'manual')
         ON CONFLICT(design_id, tag_id) DO UPDATE SET source = 'manual'",
        params![design_id, tag_id],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn remove_design_tag(app: AppHandle, design_id: String, tag: String) -> Result<(), String> {
    let normalized = normalize_tag(&tag).ok_or_else(|| "La etiqueta esta vacia".to_string())?;
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let lower = normalized.to_lowercase();

    if let Some(tag_id) = get_tag_id(&conn, &lower)? {
        conn.execute(
            "DELETE FROM design_tags WHERE design_id = ?1 AND tag_id = ?2",
            params![design_id, tag_id],
        )
        .map_err(to_string)?;
    }

    conn.execute(
        "INSERT OR IGNORE INTO ignored_auto_tags (design_id, lower_name) VALUES (?1, ?2)",
        params![design_id, lower],
    )
    .map_err(to_string)?;
    Ok(())
}

#[tauri::command]
fn open_design_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("No existe la carpeta: {path}"));
    }

    let folder = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("No se pudo resolver la carpeta: {path}"))?
    };

    Command::new("explorer")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("No se pudo abrir la carpeta: {error}"))?;

    Ok(())
}

#[tauri::command]
fn reveal_design_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("No existe el archivo: {path}"));
    }

    Command::new("explorer")
        .arg(format!("/select,{}", target.to_string_lossy()))
        .spawn()
        .map_err(|error| format!("No se pudo mostrar el archivo: {error}"))?;

    Ok(())
}

#[tauri::command]
fn save_database_backup(app: AppHandle) -> Result<BackupInfo, String> {
    let backup_path = default_backup_path(&app)?;
    export_database_backup(&app, &backup_path)?;
    backup_info(&backup_path)
}

#[tauri::command]
fn open_backup_folder(app: AppHandle) -> Result<String, String> {
    let folder = backup_directory(&app)?;
    Command::new("explorer")
        .arg(&folder)
        .spawn()
        .map_err(|error| format!("No se pudo abrir la carpeta de copias: {error}"))?;
    Ok(path_to_string(&folder))
}

#[tauri::command]
fn restore_database_backup(app: AppHandle, backup_path: String) -> Result<LibraryResponse, String> {
    let source = PathBuf::from(&backup_path);
    validate_backup_database(&source)?;

    let db_path = database_path(&app)?;
    if db_path.exists() && !same_file(&db_path, &source) {
        let safety_backup = backup_directory(&app)?.join(RESTORE_SAFETY_FILE_NAME);
        export_database_backup(&app, &safety_backup)?;
    }

    if !same_file(&db_path, &source) {
        remove_database_files(&db_path)?;
        fs::copy(&source, &db_path)
            .map_err(|error| format!("No se pudo cargar la copia de seguridad: {error}"))?;
    }

    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let root =
        get_setting(&conn, "library_root")?.unwrap_or_else(|| DEFAULT_LIBRARY_PATH.to_string());
    load_library_from_db(&conn, &root)
}

fn scan_references_impl(app: &AppHandle, root_path: &str) -> Result<ReferencesResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(format!(
            "La carpeta de la biblioteca no existe: {root_path}"
        ));
    }

    let references_path = root.join(REFERENCES_DIR_NAME);
    let works_path = root.join(WORKS_DIR_NAME);
    fs::create_dir_all(&references_path)
        .map_err(|error| format!("No se pudo preparar la carpeta Referencias: {error}"))?;

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE reference_images SET missing = 1 WHERE root_path = ?1",
        params![root_path],
    )
    .map_err(to_string)?;

    let mut categories = BTreeSet::new();
    for entry in fs::read_dir(&references_path)
        .map_err(|error| format!("No se pudo leer la carpeta Referencias: {error}"))?
    {
        let entry = entry.map_err(to_string)?;
        if entry.file_type().map_err(to_string)?.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                if !name.trim().is_empty() {
                    categories.insert(name.to_string());
                }
            }
        }
    }

    for path in collect_reference_image_paths(&references_path)? {
        let relative = path.strip_prefix(&references_path).map_err(to_string)?;
        let mut components = relative.components();
        let first = components.next();
        let category = if relative.components().count() > 1 {
            first
                .and_then(|component| component.as_os_str().to_str())
                .unwrap_or("Sin carpeta")
                .to_string()
        } else {
            "Sin carpeta".to_string()
        };
        categories.insert(category.clone());

        let metadata = fs::metadata(&path).map_err(to_string)?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(system_time_to_i64)
            .unwrap_or(0);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("referencia")
            .to_string();
        let name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .map(title_from_slug)
            .unwrap_or_else(|| "Referencia".to_string());
        let id = stable_id(&format!("reference:{}", normalize_path_for_id(&path)));
        let thumbnail_path = cached_thumbnail(app, Some(&path), modified)?;
        // Solo lee el encabezado del archivo, no decodifica la imagen: la pared
        // necesita la forma de cada referencia antes de que cargue el pixel uno.
        let (width, height) = match image::image_dimensions(&path) {
            Ok((width, height)) => (Some(width as i64), Some(height as i64)),
            Err(_) => (None, None),
        };
        let now = now_i64();

        conn.execute(
            "INSERT INTO reference_images (
                id, root_path, name, file_name, path, folder_path, category,
                thumbnail_path, size, modified, first_seen, last_seen, missing,
                width, height
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 0, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                root_path = excluded.root_path,
                name = excluded.name,
                file_name = excluded.file_name,
                path = excluded.path,
                folder_path = excluded.folder_path,
                category = excluded.category,
                thumbnail_path = excluded.thumbnail_path,
                size = excluded.size,
                modified = excluded.modified,
                last_seen = excluded.last_seen,
                missing = 0,
                width = excluded.width,
                height = excluded.height",
            params![
                id,
                root_path,
                name,
                file_name,
                path_to_string(&path),
                path_to_string(path.parent().unwrap_or(&references_path)),
                category,
                thumbnail_path.as_ref().map(|value| path_to_string(value)),
                metadata.len() as i64,
                modified,
                now,
                width,
                height,
            ],
        )
        .map_err(to_string)?;
    }

    purge_reference_cache_rows(&conn, root_path)?;
    let references = load_references_from_db(&conn, root_path)?;
    Ok(ReferencesResponse {
        root_path: root_path.to_string(),
        references_path: path_to_string(&references_path),
        works_path: path_to_string(&works_path),
        references,
        categories: categories.into_iter().collect(),
    })
}

fn collect_reference_image_paths(references_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for entry in WalkDir::new(references_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_portable_cache_path(entry.path()))
    {
        let entry = entry.map_err(to_string)?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        if PREVIEW_EXTENSIONS.contains(&extension_for(&path).as_str()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn purge_reference_cache_rows(conn: &Connection, root_path: &str) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM reference_images
         WHERE root_path = ?1
           AND instr(lower(replace(path, char(92), '/')), '/_roxwana-cache/') > 0",
        params![root_path],
    )
    .map_err(to_string)
}

fn load_references_from_db(
    conn: &Connection,
    root_path: &str,
) -> Result<Vec<ReferenceItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, file_name, path, folder_path, category,
                    thumbnail_path, size, modified, favorite, status, work_path,
                    width, height
             FROM reference_images
             WHERE root_path = ?1 AND missing = 0
             ORDER BY modified DESC, lower(name)",
        )
        .map_err(to_string)?;
    let references = stmt
        .query_map(params![root_path], reference_item_from_row)
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(references)
}

fn load_reference_by_id(conn: &Connection, reference_id: &str) -> Result<ReferenceItem, String> {
    conn.query_row(
        "SELECT id, name, file_name, path, folder_path, category,
                thumbnail_path, size, modified, favorite, status, work_path,
                width, height
         FROM reference_images WHERE id = ?1 AND missing = 0",
        params![reference_id],
        reference_item_from_row,
    )
    .optional()
    .map_err(to_string)?
    .ok_or_else(|| "No encontre esa referencia".to_string())
}

fn reference_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReferenceItem> {
    Ok(ReferenceItem {
        id: row.get(0)?,
        name: row.get(1)?,
        file_name: row.get(2)?,
        path: row.get(3)?,
        folder_path: row.get(4)?,
        category: row.get(5)?,
        thumbnail_path: row.get(6)?,
        size: row.get::<_, i64>(7)? as u64,
        modified: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
        status: row.get(10)?,
        work_path: row.get(11)?,
        width: row
            .get::<_, Option<i64>>(12)?
            .filter(|value| *value > 0)
            .map(|value| value as u32),
        height: row
            .get::<_, Option<i64>>(13)?
            .filter(|value| *value > 0)
            .map(|value| value as u32),
    })
}

fn send_reference_to_work_impl(
    app: &AppHandle,
    root_path: &str,
    reference_id: &str,
    work_name: &str,
) -> Result<ReferenceItem, String> {
    let conn = open_database(app)?;
    ensure_database(&conn)?;
    let reference = load_reference_by_id(&conn, reference_id)?;
    let source = PathBuf::from(&reference.path);
    if !source.is_file() {
        return Err("El archivo original de la referencia ya no existe".to_string());
    }

    let root = PathBuf::from(root_path);
    let references_root = root.join(REFERENCES_DIR_NAME);
    let canonical_source = source.canonicalize().map_err(to_string)?;
    let canonical_references = references_root.canonicalize().map_err(to_string)?;
    if !canonical_source.starts_with(&canonical_references) {
        return Err("La referencia no pertenece a la carpeta Referencias activa".to_string());
    }

    let work_path = copy_reference_into_work(&root, &source, &reference.file_name, work_name)?;

    conn.execute(
        "UPDATE reference_images SET status = 'working', work_path = ?1 WHERE id = ?2",
        params![path_to_string(&work_path), reference_id],
    )
    .map_err(to_string)?;
    load_reference_by_id(&conn, reference_id)
}

fn copy_reference_into_work(
    root: &Path,
    source: &Path,
    file_name: &str,
    work_name: &str,
) -> Result<PathBuf, String> {
    let folder_name = safe_folder_name(work_name)?;
    let work_path = root.join(WORKS_DIR_NAME).join(folder_name);
    fs::create_dir_all(&work_path)
        .map_err(|error| format!("No se pudo crear la carpeta del trabajo: {error}"))?;
    let destination = work_path.join(file_name);
    if !destination.exists() {
        fs::copy(source, &destination)
            .map_err(|error| format!("No se pudo copiar la referencia al trabajo: {error}"))?;
    }
    Ok(work_path)
}

fn safe_folder_name(value: &str) -> Result<String, String> {
    let cleaned = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err("El nombre del trabajo esta vacio".to_string());
    }
    let reserved = cleaned.to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|name| reserved == *name)
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && reserved[3..].parse::<u8>().is_ok())
    {
        return Err("Ese nombre esta reservado por Windows".to_string());
    }
    Ok(cleaned)
}

fn scan_library_impl(app: &AppHandle, root_path: &str) -> Result<LibraryResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("La carpeta no existe: {root_path}"));
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    let previous_root = get_setting(&conn, "library_root")?;
    let layout_relocation_matches = load_layout_relocation_matches(&conn, &root)?;
    let content_relocation_matches = load_content_relocation_matches(&conn)?;
    let relocation_matches = previous_root
        .as_deref()
        .filter(|previous| {
            normalize_path_for_id(Path::new(previous)) != normalize_path_for_id(&root)
        })
        .map(|previous| load_relocation_matches(&conn, Path::new(previous)))
        .transpose()?;
    save_setting(&conn, "library_root", root_path)?;
    conn.execute("UPDATE designs SET missing = 1", [])
        .map_err(to_string)?;
    conn.execute("UPDATE files SET missing = 1", [])
        .map_err(to_string)?;

    let mut collected = collect_designs(&root)?;
    for design in &mut collected {
        design.thumbnail_path =
            cached_thumbnail(app, design.preview_path.as_deref(), design.updated_at)?;
        design.preview_cache_path =
            cached_preview(app, design.preview_path.as_deref(), design.updated_at)?;
        persist_design(&conn, design)?;
        let previous_id = relocation_matches
            .as_ref()
            .and_then(|matches| matches.get(&relocation_key(&root, design)))
            .or_else(|| layout_relocation_matches.get(&normalize_path_for_id(&design.path)))
            .or_else(|| content_relocation_matches.get(&design_content_fingerprint(&design.files)));
        if let Some(previous_id) = previous_id {
            copy_design_classification(&conn, previous_id, &design.id)?;
        }
        sync_auto_tags(&conn, &design.id, &design.auto_tags)?;
    }

    normalize_design_categories(&conn)?;
    save_setting(&conn, "content_layout_version", CONTENT_LAYOUT_VERSION)?;
    load_library_from_db(&conn, root_path)
}

fn rescan_paths_impl(
    app: &AppHandle,
    root_path: &str,
    paths: &[String],
) -> Result<LibraryResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("La carpeta no existe: {root_path}"));
    }

    let mut affected_dirs = BTreeSet::new();
    let mut needs_full_scan = false;
    for path in paths {
        let path = PathBuf::from(path);
        let target = if path.is_dir() {
            path
        } else {
            path.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| root.clone())
        };

        if same_path(&target, &root) {
            needs_full_scan = true;
            break;
        }

        if target.starts_with(&root) {
            affected_dirs.insert(scan_scope_root(&root, &target));
        }
    }

    if needs_full_scan || affected_dirs.is_empty() {
        return scan_library_impl(app, root_path);
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    let layout_relocation_matches = load_layout_relocation_matches(&conn, &root)?;
    let content_relocation_matches = load_content_relocation_matches(&conn)?;
    save_setting(&conn, "library_root", root_path)?;

    for dir in &affected_dirs {
        let dir_string = path_to_string(dir);
        let descendant_prefix = format!("{}{}", dir_string, std::path::MAIN_SEPARATOR);
        conn.execute(
            "UPDATE designs
             SET missing = 1
             WHERE directory = ?1 OR instr(lower(directory), lower(?2)) = 1",
            params![dir_string, descendant_prefix],
        )
        .map_err(to_string)?;
        conn.execute(
            "UPDATE files SET missing = 1
             WHERE design_id IN (
                 SELECT id FROM designs
                 WHERE directory = ?1 OR instr(lower(directory), lower(?2)) = 1
             )",
            params![path_to_string(dir), descendant_prefix],
        )
        .map_err(to_string)?;
    }

    let walk_roots = affected_dirs.into_iter().collect::<Vec<_>>();
    let mut collected = collect_designs_from_walk_roots(&root, &walk_roots)?;
    for design in &mut collected {
        design.thumbnail_path =
            cached_thumbnail(app, design.preview_path.as_deref(), design.updated_at)?;
        design.preview_cache_path =
            cached_preview(app, design.preview_path.as_deref(), design.updated_at)?;
        persist_design(&conn, design)?;
        let previous_id = layout_relocation_matches
            .get(&normalize_path_for_id(&design.path))
            .or_else(|| content_relocation_matches.get(&design_content_fingerprint(&design.files)));
        if let Some(previous_id) = previous_id {
            copy_design_classification(&conn, previous_id, &design.id)?;
        }
        sync_auto_tags(&conn, &design.id, &design.auto_tags)?;
    }

    normalize_design_categories(&conn)?;
    load_library_from_db(&conn, root_path)
}

fn load_library_from_db(conn: &Connection, root_path: &str) -> Result<LibraryResponse, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id
             FROM designs
             WHERE missing = 0
             ORDER BY name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;

    let mut designs = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(design) = load_design_from_db(conn, &id, false)? {
            designs.push(design);
        }
    }

    let stats = build_stats_from_db(conn)?;
    let sidebar = load_sidebar(conn)?;
    let categories = flatten_sidebar(&sidebar);
    let tags = load_tags(conn)?;

    Ok(LibraryResponse {
        root_path: root_path.to_string(),
        designs,
        stats,
        categories,
        sidebar,
        tags,
    })
}

fn load_design_from_db(
    conn: &Connection,
    design_id: &str,
    include_files: bool,
) -> Result<Option<Design>, String> {
    let row = conn
        .query_row(
            "SELECT id, name, path, directory, group_type, preview_path, preview_cache_path,
                    thumbnail_path, total_files, updated_at, auto_category
             FROM designs
             WHERE id = ?1 AND missing = 0",
            params![design_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(to_string)?;

    let Some((
        id,
        name,
        path,
        directory,
        group_type,
        preview_path,
        preview_cache_path,
        thumbnail_path,
        total_files,
        updated_at,
        auto_category,
    )) = row
    else {
        return Ok(None);
    };

    let files = if include_files {
        load_design_files(conn, &id)?
    } else {
        Vec::new()
    };
    let counts = load_support_counts(conn, &id)?;
    let classification = load_classification(conn, &id)?;
    let auto_tags = load_auto_tags(conn, &id)?;

    Ok(Some(Design {
        id,
        name,
        path,
        directory,
        group_type,
        preview_path,
        preview_cache_path,
        thumbnail_path,
        total_files: total_files as usize,
        updated_at,
        counts,
        files,
        classification,
        auto_category,
        auto_tags,
    }))
}

fn load_design_files(conn: &Connection, design_id: &str) -> Result<Vec<DesignFile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, design_id, path, file_name, extension, kind, size, modified
             FROM files
             WHERE design_id = ?1 AND missing = 0
             ORDER BY file_name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let files = stmt
        .query_map(params![design_id], |row| {
            Ok(DesignFile {
                id: row.get(0)?,
                design_id: row.get(1)?,
                path: row.get(2)?,
                file_name: row.get(3)?,
                extension: row.get(4)?,
                kind: row.get(5)?,
                size: row.get::<_, i64>(6)? as u64,
                modified: row.get(7)?,
            })
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(files)
}

fn load_support_counts(conn: &Connection, design_id: &str) -> Result<SupportCounts, String> {
    let mut counts = SupportCounts::default();
    let mut stmt = conn
        .prepare(
            "SELECT extension, COUNT(*)
             FROM files
             WHERE design_id = ?1 AND missing = 0
             GROUP BY extension",
        )
        .map_err(to_string)?;
    let rows = stmt
        .query_map(params![design_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(to_string)?;

    for row in rows {
        let (extension, count) = row.map_err(to_string)?;
        let count = count as usize;
        match extension.as_str() {
            ".ai" => counts.ai = count,
            ".psd" => counts.psd = count,
            ".svg" => counts.svg = count,
            ".pdf" => counts.pdf = count,
            ".eps" => counts.eps = count,
            ".zip" => counts.zip = count,
            ".txt" => counts.txt = count,
            extension if SUPPORT_EXTENSIONS.contains(&extension) => counts.other += count,
            _ => {}
        }
    }

    Ok(counts)
}

fn load_auto_tags(conn: &Connection, design_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT tags.name
             FROM tags
             INNER JOIN design_tags ON design_tags.tag_id = tags.id
             WHERE design_tags.design_id = ?1 AND design_tags.source = 'auto'
             ORDER BY tags.name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let tags = stmt
        .query_map(params![design_id], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(tags)
}

fn build_stats_from_db(conn: &Connection) -> Result<LibraryStats, String> {
    let designs = conn
        .query_row(
            "SELECT COUNT(*) FROM designs WHERE missing = 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(to_string)? as usize;
    let missing = conn
        .query_row(
            "SELECT COUNT(*) FROM designs WHERE missing = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(to_string)? as usize;

    let mut by_extension = BTreeMap::new();
    let mut previews = 0usize;
    let mut support = 0usize;
    let mut files = 0usize;
    let mut stmt = conn
        .prepare(
            "SELECT files.extension, files.kind, COUNT(*)
             FROM files
             INNER JOIN designs ON designs.id = files.design_id
             WHERE files.missing = 0 AND designs.missing = 0
             GROUP BY files.extension, files.kind",
        )
        .map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(to_string)?;

    for row in rows {
        let (extension, kind, count) = row.map_err(to_string)?;
        let count = count as usize;
        *by_extension.entry(extension).or_insert(0) += count;
        files += count;
        if kind == "preview" {
            previews += count;
        } else {
            support += count;
        }
    }

    Ok(LibraryStats {
        designs,
        files,
        previews,
        support,
        missing,
        by_extension,
    })
}

fn active_design_count(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM designs WHERE missing = 0",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count as usize)
    .map_err(to_string)
}

fn active_library_has_missing_paths(conn: &Connection) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT path, group_type FROM designs WHERE missing = 0")
        .map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_string)?;

    for row in rows {
        let (path, group_type) = row.map_err(to_string)?;
        if group_type == "folder" && !PathBuf::from(path).exists() {
            return Ok(true);
        }
    }

    let mut files_stmt = conn
        .prepare("SELECT path FROM files WHERE missing = 0")
        .map_err(to_string)?;
    let file_paths = files_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?;
    for file_path in file_paths {
        if !PathBuf::from(file_path.map_err(to_string)?).exists() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn load_relocation_matches(
    conn: &Connection,
    previous_root: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT id, path FROM designs")
        .map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_string)?;
    let mut matches = BTreeMap::new();

    for row in rows {
        let (design_id, path) = row.map_err(to_string)?;
        let mut files_stmt = conn
            .prepare(
                "SELECT file_name, size FROM files
                 WHERE design_id = ?1
                 ORDER BY lower(file_name), size",
            )
            .map_err(to_string)?;
        let files = files_stmt
            .query_map(params![design_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(to_string)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(to_string)?;

        if let Some(key) = relocation_key_parts(previous_root, Path::new(&path), &files) {
            matches.insert(key, design_id);
        }
    }

    Ok(matches)
}

fn relocation_key(root: &Path, design: &CollectedDesign) -> String {
    let files = design
        .files
        .iter()
        .map(|file| (file.file_name.clone(), file.size))
        .collect::<Vec<_>>();
    relocation_key_parts(root, &design.path, &files).unwrap_or_default()
}

/// Identifica un diseño por el conjunto de archivos que contiene, sin incluir
/// su carpeta. Permite conservar favoritos, estados, categorías y etiquetas
/// cuando el usuario reorganiza carpetas dentro de la misma biblioteca.
fn design_content_fingerprint(files: &[DesignFile]) -> String {
    let mut fingerprint = files
        .iter()
        .map(|file| format!("{}:{}", file.file_name.to_lowercase(), file.size))
        .collect::<Vec<_>>();
    fingerprint.sort();
    fingerprint.join("|")
}

/// Calcula la ruta de un diseño en la nueva estructura. Los proyectos que
/// estaban sueltos pasan a Freepik y 1-COMPLETAS pasa a Trabajos.
fn reorganized_design_path(root: &Path, design_path: &Path) -> Option<PathBuf> {
    let relative = design_path.strip_prefix(root).ok()?;
    let mut components = relative.components();
    let first = components.next()?;
    let first_name = first.as_os_str().to_str()?;

    if first_name.eq_ignore_ascii_case(LEGACY_COMPLETE_DIR_NAME) {
        let mut target = root.join(WORKS_DIR_NAME);
        for component in components {
            target.push(component.as_os_str());
        }
        return Some(target);
    }

    if first_name.eq_ignore_ascii_case(FREEPIK_DIR_NAME)
        || first_name.eq_ignore_ascii_case(WORKS_DIR_NAME)
        || is_categories_container_name(first_name)
        || first_name.eq_ignore_ascii_case(LOOSE_DIR_NAME)
        || first_name.eq_ignore_ascii_case(REFERENCES_DIR_NAME)
        || first_name.eq_ignore_ascii_case(PORTABLE_CACHE_DIR_NAME)
    {
        return Some(design_path.to_path_buf());
    }

    Some(root.join(FREEPIK_DIR_NAME).join(relative))
}

/// Conserva la relación exacta ruta-a-ruta durante la reorganización. Si una
/// fila vieja y una nueva apuntan al mismo destino, se prioriza la que contiene
/// clasificación manual, favorita, estado o etiquetas del usuario.
fn load_layout_relocation_matches(
    conn: &Connection,
    root: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, path, favorite, status, category_user_set, missing,
                    (SELECT COUNT(*) FROM design_tags
                     WHERE design_id = designs.id AND source = 'manual')
             FROM designs",
        )
        .map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(to_string)?;
    let mut best: BTreeMap<String, (i64, String)> = BTreeMap::new();

    for row in rows {
        let (id, path, favorite, status, category_user_set, missing, manual_tags) =
            row.map_err(to_string)?;
        let Some(target) = reorganized_design_path(root, Path::new(&path)) else {
            continue;
        };
        let score = favorite * 1_000
            + category_user_set * 100
            + i64::from(status != "pending") * 50
            + manual_tags * 10
            + i64::from(missing == 0);
        let key = normalize_path_for_id(&target);
        match best.get(&key) {
            Some((current_score, _)) if *current_score >= score => {}
            _ => {
                best.insert(key, (score, id));
            }
        }
    }

    Ok(best
        .into_iter()
        .map(|(path, (_, design_id))| (path, design_id))
        .collect())
}

fn load_content_relocation_matches(conn: &Connection) -> Result<BTreeMap<String, String>, String> {
    let mut designs_stmt = conn
        .prepare("SELECT id FROM designs WHERE missing = 0")
        .map_err(to_string)?;
    let design_ids = designs_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    let mut candidates: BTreeMap<String, Option<String>> = BTreeMap::new();

    for design_id in design_ids {
        let mut files_stmt = conn
            .prepare(
                "SELECT file_name, size FROM files
                 WHERE design_id = ?1 AND missing = 0
                 ORDER BY lower(file_name), size",
            )
            .map_err(to_string)?;
        let files = files_stmt
            .query_map(params![design_id], |row| {
                Ok(DesignFile {
                    id: String::new(),
                    design_id: String::new(),
                    path: String::new(),
                    file_name: row.get(0)?,
                    extension: String::new(),
                    kind: String::new(),
                    size: row.get::<_, i64>(1)? as u64,
                    modified: 0,
                })
            })
            .map_err(to_string)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(to_string)?;
        if files.is_empty() {
            continue;
        }
        let fingerprint = design_content_fingerprint(&files);
        candidates
            .entry(fingerprint)
            .and_modify(|candidate| *candidate = None)
            .or_insert(Some(design_id));
    }

    Ok(candidates
        .into_iter()
        .filter_map(|(fingerprint, design_id)| design_id.map(|id| (fingerprint, id)))
        .collect())
}

fn relocation_key_parts(
    root: &Path,
    design_path: &Path,
    files: &[(String, u64)],
) -> Option<String> {
    let relative = design_path.strip_prefix(root).ok()?;
    let mut fingerprint = files
        .iter()
        .map(|(name, size)| format!("{}:{size}", name.to_lowercase()))
        .collect::<Vec<_>>();
    fingerprint.sort();
    Some(format!(
        "{}|{}",
        normalize_path_for_id(relative),
        fingerprint.join("|")
    ))
}

fn copy_design_classification(
    conn: &Connection,
    previous_id: &str,
    current_id: &str,
) -> Result<(), String> {
    if previous_id == current_id {
        return Ok(());
    }

    conn.execute(
        "UPDATE designs
         SET favorite = (SELECT favorite FROM designs WHERE id = ?1),
             status = (SELECT status FROM designs WHERE id = ?1),
             category = CASE
                 WHEN (SELECT category_user_set FROM designs WHERE id = ?1) = 1
                 THEN (SELECT category FROM designs WHERE id = ?1)
                 ELSE category
             END,
             category_user_set = (SELECT category_user_set FROM designs WHERE id = ?1),
             first_seen = (SELECT first_seen FROM designs WHERE id = ?1)
         WHERE id = ?2",
        params![previous_id, current_id],
    )
    .map_err(to_string)?;
    conn.execute(
        "INSERT OR REPLACE INTO design_tags (design_id, tag_id, source)
         SELECT ?2, tag_id, source
         FROM design_tags
         WHERE design_id = ?1 AND source = 'manual'",
        params![previous_id, current_id],
    )
    .map_err(to_string)?;
    conn.execute(
        "INSERT OR IGNORE INTO ignored_auto_tags (design_id, lower_name)
         SELECT ?2, lower_name FROM ignored_auto_tags WHERE design_id = ?1",
        params![previous_id, current_id],
    )
    .map_err(to_string)?;
    Ok(())
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("No se pudo resolver APPLOCALDATA: {error}"))?;
    fs::create_dir_all(&dir).map_err(to_string)?;
    Ok(dir.join("roxwana-biblioteca.sqlite"))
}

fn brand_logo_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("No se pudo resolver APPLOCALDATA: {error}"))?
        .join("branding");
    Ok(dir.join(BRAND_LOGO_FILE_NAME))
}

fn read_brand_logo(app: &AppHandle) -> Result<Option<BrandLogo>, String> {
    let path = brand_logo_path(app)?;
    if !path.is_file() {
        return Ok(None);
    }

    let bytes =
        fs::read(&path).map_err(|error| format!("No se pudo leer el logo guardado: {error}"))?;
    let (width, height) = image::image_dimensions(&path)
        .map_err(|error| format!("El logo guardado no es una imagen valida: {error}"))?;

    Ok(Some(BrandLogo {
        data_url: format!("data:image/png;base64,{}", encode_base64(&bytes)),
        width,
        height,
    }))
}

fn save_brand_logo_impl(app: &AppHandle, source_path: &str) -> Result<BrandLogo, String> {
    let source_path = PathBuf::from(source_path);
    let metadata = fs::metadata(&source_path)
        .map_err(|error| format!("No se pudo abrir la imagen elegida: {error}"))?;
    if !metadata.is_file() {
        return Err("La ruta elegida no es un archivo de imagen".to_string());
    }
    if metadata.len() > BRAND_LOGO_MAX_SOURCE_BYTES {
        return Err("La imagen supera el limite de 40 MB".to_string());
    }

    let (source_width, source_height) = image::image_dimensions(&source_path)
        .map_err(|_| "El archivo no es una imagen PNG, JPG o WebP valida".to_string())?;
    let pixels = u64::from(source_width) * u64::from(source_height);
    if pixels == 0 || pixels > BRAND_LOGO_MAX_PIXELS {
        return Err("La imagen tiene dimensiones demasiado grandes".to_string());
    }

    let source = image::open(&source_path)
        .map_err(|_| "El archivo no es una imagen PNG, JPG o WebP valida".to_string())?;
    let logo = if source.width() > BRAND_LOGO_MAX_SIDE || source.height() > BRAND_LOGO_MAX_SIDE {
        source.resize(
            BRAND_LOGO_MAX_SIDE,
            BRAND_LOGO_MAX_SIDE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        source
    };
    let (width, height) = (logo.width(), logo.height());

    let target = brand_logo_path(app)?;
    let directory = target
        .parent()
        .ok_or_else(|| "La ruta del logo no tiene carpeta padre".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("No se pudo crear la carpeta del logo: {error}"))?;

    let sequence = BRAND_LOGO_TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = target.with_extension(format!("png.{}.{}.part", std::process::id(), sequence));
    if let Err(error) = logo
        .into_rgba8()
        .save_with_format(&temporary, image::ImageFormat::Png)
    {
        let _ = fs::remove_file(&temporary);
        return Err(format!("No se pudo preparar el logo: {error}"));
    }

    if target.exists() {
        fs::remove_file(&target)
            .map_err(|error| format!("No se pudo reemplazar el logo anterior: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("No se pudo guardar el logo: {error}"));
    }

    read_brand_logo(app)?
        .ok_or_else(|| "El logo se guardo, pero no se pudo volver a leer".to_string())
        .map(|mut saved| {
            saved.width = width;
            saved.height = height;
            saved
        })
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);

        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }

    encoded
}

static BRAND_LOGO_TEMP_SEQUENCE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let db_path = database_path(app)?;
    let conn = Connection::open(db_path).map_err(to_string)?;
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        ",
    )
    .map_err(to_string)?;
    Ok(conn)
}

fn backup_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("No se pudo resolver APPLOCALDATA: {error}"))?
        .join("copias-de-seguridad");
    fs::create_dir_all(&dir).map_err(to_string)?;
    Ok(dir)
}

fn default_backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(backup_directory(app)?.join(BACKUP_FILE_NAME))
}

fn export_database_backup(app: &AppHandle, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(to_string)?;
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    conn.execute_batch("PRAGMA wal_checkpoint(FULL);")
        .map_err(to_string)?;

    let temporary = target.with_extension("sqlite.tmp");
    remove_file_if_exists(&temporary)?;

    let quoted_path = sqlite_string_literal(&path_to_string(&temporary));
    conn.execute_batch(&format!("VACUUM INTO {quoted_path};"))
        .map_err(to_string)?;
    drop(conn);

    remove_file_if_exists(target)?;
    fs::rename(&temporary, target)
        .map_err(|error| format!("No se pudo guardar la copia de seguridad: {error}"))?;
    Ok(())
}

fn validate_backup_database(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "No existe la copia de seguridad: {}",
            path.display()
        ));
    }

    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("No pude abrir la copia de seguridad: {error}"))?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(to_string)?;
    if integrity != "ok" {
        return Err(format!(
            "La copia de seguridad no esta integra: {integrity}"
        ));
    }

    for table in ["settings", "categories", "designs"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .map_err(to_string)?;
        if exists != 1 {
            return Err(format!(
                "La copia no parece ser de Biblioteca Visual: falta la tabla {table}"
            ));
        }
    }

    Ok(())
}

fn backup_info(path: &Path) -> Result<BackupInfo, String> {
    validate_backup_database(path)?;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("No pude leer la copia de seguridad: {error}"))?;
    let categories = count_query(&conn, "SELECT COUNT(*) FROM categories")?;
    let designs = count_query(&conn, "SELECT COUNT(*) FROM designs WHERE missing = 0")?;
    let manual_category_designs = count_query(
        &conn,
        "SELECT COUNT(*) FROM designs WHERE category_user_set = 1",
    )?;
    let folder = path
        .parent()
        .map(path_to_string)
        .unwrap_or_else(|| String::from(""));

    Ok(BackupInfo {
        path: path_to_string(path),
        folder,
        categories,
        designs,
        manual_category_designs,
    })
}

fn count_query(conn: &Connection, sql: &str) -> Result<usize, String> {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|count| count as usize)
        .map_err(to_string)
}

fn remove_database_files(db_path: &Path) -> Result<(), String> {
    remove_file_if_exists(db_path)?;
    remove_file_if_exists(&PathBuf::from(format!("{}-wal", db_path.to_string_lossy())))?;
    remove_file_if_exists(&PathBuf::from(format!("{}-shm", db_path.to_string_lossy())))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn ensure_database(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lower_name TEXT NOT NULL UNIQUE,
            color TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            user_created INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS category_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lower_name TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            collapsed INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS designs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            directory TEXT NOT NULL,
            group_type TEXT NOT NULL,
            preview_path TEXT,
            preview_cache_path TEXT,
            thumbnail_path TEXT,
            total_files INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            missing INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            category TEXT,
            category_user_set INTEGER NOT NULL DEFAULT 0,
            auto_category TEXT
        );

        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            design_id TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            extension TEXT NOT NULL,
            kind TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            missing INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(design_id) REFERENCES designs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            lower_name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS design_tags (
            design_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            PRIMARY KEY (design_id, tag_id),
            FOREIGN KEY(design_id) REFERENCES designs(id) ON DELETE CASCADE,
            FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ignored_auto_tags (
            design_id TEXT NOT NULL,
            lower_name TEXT NOT NULL,
            PRIMARY KEY (design_id, lower_name),
            FOREIGN KEY(design_id) REFERENCES designs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS reference_images (
            id TEXT PRIMARY KEY,
            root_path TEXT NOT NULL,
            name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            folder_path TEXT NOT NULL,
            category TEXT NOT NULL,
            thumbnail_path TEXT,
            size INTEGER NOT NULL DEFAULT 0,
            modified INTEGER NOT NULL DEFAULT 0,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL,
            missing INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            work_path TEXT,
            width INTEGER,
            height INTEGER
        );

        CREATE INDEX IF NOT EXISTS reference_images_root_active
        ON reference_images(root_path, missing, category);
        ",
    )
    .map_err(to_string)?;

    conn.execute("ALTER TABLE designs ADD COLUMN preview_cache_path TEXT", [])
        .or_else(|error| {
            if error.to_string().contains("duplicate column name") {
                Ok(0)
            } else {
                Err(error)
            }
        })
        .map_err(to_string)?;

    conn.execute("ALTER TABLE categories ADD COLUMN group_id TEXT", [])
        .or_else(|error| {
            if error.to_string().contains("duplicate column name") {
                Ok(0)
            } else {
                Err(error)
            }
        })
        .map_err(to_string)?;

    for column in ["width", "height"] {
        conn.execute(
            &format!("ALTER TABLE reference_images ADD COLUMN {column} INTEGER"),
            [],
        )
        .or_else(|error| {
            if error.to_string().contains("duplicate column name") {
                Ok(0)
            } else {
                Err(error)
            }
        })
        .map_err(to_string)?;
    }

    seed_categories(conn)?;
    normalize_design_categories(conn)?;
    Ok(())
}

fn normalize_design_categories(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE designs
         SET category = (
             SELECT c.name
             FROM categories c
             WHERE c.lower_name = lower(trim(designs.category))
             LIMIT 1
         )
         WHERE category IS NOT NULL
           AND trim(category) <> ''
           AND EXISTS (
             SELECT 1 FROM categories c
             WHERE c.lower_name = lower(trim(designs.category))
               AND trim(designs.category) <> c.name
           )",
        [],
    )
    .map_err(to_string)?;

    conn.execute(
        "UPDATE designs
         SET category = NULL,
             category_user_set = 1
         WHERE category IS NOT NULL
           AND trim(category) <> ''
           AND NOT EXISTS (
             SELECT 1 FROM categories c
             WHERE c.lower_name = lower(trim(designs.category))
           )",
        [],
    )
    .map_err(to_string)?;

    conn.execute(
        "UPDATE designs
         SET category = NULL,
             category_user_set = 1
         WHERE category IS NOT NULL
           AND trim(category) = ''",
        [],
    )
    .map_err(to_string)?;

    Ok(())
}

fn seed_categories(conn: &Connection) -> Result<(), String> {
    if get_setting(conn, "default_categories_seeded")?.is_some() {
        return Ok(());
    }

    let categories = [
        ("Skater", "#65a30d"),
        ("Calaveras", "#ef4444"),
        ("Surf y playa", "#0891b2"),
        ("Animales", "#f59e0b"),
        ("Hombre", "#d29332"),
        ("Mujer", "#e11d48"),
        ("Motos", "#52525b"),
        ("Musica", "#7c3aed"),
        ("Rock", "#ef4444"),
        ("Frases", "#2563eb"),
        ("Gotico", "#111827"),
        ("Retro", "#db2777"),
        ("Naturaleza", "#16a34a"),
        ("Amor", "#e11d48"),
        ("Halloween", "#f97316"),
        ("Dia de los muertos", "#9333ea"),
        ("Deportes", "#0d9488"),
        ("Oeste", "#a16207"),
        ("Urbano", "#334155"),
        ("Textos y efectos", "#4f46e5"),
        ("Abstracto", "#64748b"),
        ("Infantil", "#ec4899"),
        ("Verano", "#0284c7"),
        ("Otros", "#71717a"),
    ];

    for (index, (name, color)) in categories.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO categories (id, name, lower_name, color, sort_order, user_created)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![stable_id(&format!("category:{name}")), name, name.to_lowercase(), color, index as i64],
        )
        .map_err(to_string)?;
    }

    save_setting(conn, "default_categories_seeded", "1")?;
    Ok(())
}

fn collect_designs(root: &Path) -> Result<Vec<CollectedDesign>, String> {
    collect_designs_from_walk_roots(root, &[root.to_path_buf()])
}

fn collect_designs_from_walk_roots(
    root: &Path,
    walk_roots: &[PathBuf],
) -> Result<Vec<CollectedDesign>, String> {
    let mut groups: BTreeMap<String, GroupBuilder> = BTreeMap::new();
    let root = root.to_path_buf();

    for walk_root in walk_roots {
        if !walk_root.exists() {
            continue;
        }

        for entry in WalkDir::new(walk_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                !is_portable_cache_path(entry.path())
                    && !is_reference_library_path(&root, entry.path())
            })
        {
            let entry = entry.map_err(to_string)?;
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path().to_path_buf();
            let extension = extension_for(&path);
            if !is_supported_extension(&extension) {
                continue;
            }

            let parent = path.parent().unwrap_or(&root).to_path_buf();
            let file_stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("sin-nombre")
                .to_string();
            let folder_category = physical_folder_category(&root, &parent);
            let is_direct_loose_file = parent
                .parent()
                .is_some_and(|parent_root| same_path(parent_root, &root))
                && parent
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_loose_container_name);
            let is_direct_category_file = folder_category
                .as_ref()
                .is_some_and(|(_, category_dir)| same_path(category_dir, &parent));
            let (key, key_path, directory, group_type, name) = if is_direct_loose_file {
                let key_path = parent.join(&file_stem);
                let has_matching_folder = key_path.is_dir();
                (
                    normalize_path_for_id(&key_path),
                    key_path.clone(),
                    if has_matching_folder {
                        key_path
                    } else {
                        parent.clone()
                    },
                    if has_matching_folder {
                        "folder".to_string()
                    } else {
                        "loose_file".to_string()
                    },
                    title_from_slug(&file_stem),
                )
            } else if same_path(&parent, &root) || is_direct_category_file {
                let key_path = root.join(&file_stem);
                let key_path = if is_direct_category_file {
                    parent.join(&file_stem)
                } else {
                    key_path
                };
                (
                    format!(
                        "loose:{}:{}",
                        normalize_path_for_id(&parent),
                        file_stem.to_lowercase()
                    ),
                    key_path,
                    parent.clone(),
                    "loose_file".to_string(),
                    title_from_slug(&file_stem),
                )
            } else {
                let dir_name = parent
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("sin-nombre")
                    .to_string();
                (
                    normalize_path_for_id(&parent),
                    parent.clone(),
                    parent.clone(),
                    "folder".to_string(),
                    title_from_slug(&dir_name),
                )
            };

            let metadata = fs::metadata(&path).map_err(to_string)?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(system_time_to_i64)
                .unwrap_or(0);
            let file = DesignFile {
                id: stable_id(&normalize_path_for_id(&path)),
                design_id: String::new(),
                path: path_to_string(&path),
                file_name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("archivo")
                    .to_string(),
                extension: extension.clone(),
                kind: kind_for_extension(&extension).to_string(),
                size: metadata.len(),
                modified,
            };

            groups
                .entry(key)
                .or_insert_with(|| GroupBuilder {
                    key_path,
                    directory,
                    group_type,
                    name,
                    folder_category: folder_category.map(|(category, _)| category),
                    files: Vec::new(),
                })
                .files
                .push(file);
        }
    }

    let mut designs = Vec::with_capacity(groups.len());
    for (_, mut group) in groups {
        group
            .files
            .sort_by(|left, right| left.file_name.cmp(&right.file_name));
        let design_id = stable_id(&normalize_path_for_id(&group.key_path));
        for file in &mut group.files {
            file.design_id = design_id.clone();
        }

        let preview_path = choose_preview(&group.files).map(PathBuf::from);
        let counts = build_counts(&group.files);
        let updated_at = group
            .files
            .iter()
            .map(|file| file.modified)
            .max()
            .unwrap_or(0);
        let (_, auto_tags) = classify_design(&group.name, &group.files);
        let auto_category = group.folder_category;

        designs.push(CollectedDesign {
            id: design_id,
            name: group.name,
            path: group.key_path,
            directory: group.directory,
            group_type: group.group_type,
            preview_path,
            preview_cache_path: None,
            thumbnail_path: None,
            files: group.files,
            counts,
            updated_at,
            auto_category,
            auto_tags,
        });
    }

    designs.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(designs)
}

fn physical_folder_category(root: &Path, parent: &Path) -> Option<(String, PathBuf)> {
    let root_is_classifying_container = root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_classifying_container_name);
    let relative = parent.strip_prefix(root).ok()?;
    let mut components = relative.components();
    let (container_root, category_component) = if root_is_classifying_container {
        (root.to_path_buf(), components.next()?)
    } else {
        let container_component = components.next()?;
        if !container_component
            .as_os_str()
            .to_str()
            .is_some_and(is_classifying_container_name)
        {
            return None;
        }
        (
            root.join(container_component.as_os_str()),
            components.next()?,
        )
    };
    let category_folder = container_root.join(category_component.as_os_str());
    let raw_name = category_component.as_os_str().to_str()?;
    let category = normalize_category(&title_from_slug(raw_name))?;
    Some((category, category_folder))
}

fn scan_scope_root(root: &Path, path: &Path) -> PathBuf {
    physical_folder_category(root, path)
        .map(|(_, folder)| folder)
        .unwrap_or_else(|| path.to_path_buf())
}

fn is_works_container_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(WORKS_DIR_NAME) || name.eq_ignore_ascii_case(LEGACY_COMPLETE_DIR_NAME)
}

fn is_categories_container_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(CATEGORIES_DIR_NAME) || name.eq_ignore_ascii_case("Categorias")
}

fn is_classifying_container_name(name: &str) -> bool {
    is_categories_container_name(name) || is_works_container_name(name)
}

fn is_loose_container_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(FREEPIK_DIR_NAME) || name.eq_ignore_ascii_case(LOOSE_DIR_NAME)
}

fn is_reference_library_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative.components().next().is_some_and(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(REFERENCES_DIR_NAME))
    })
}

fn choose_preview(files: &[DesignFile]) -> Option<String> {
    files
        .iter()
        .filter(|file| file.kind == "preview")
        .min_by_key(|file| preview_score(file))
        .map(|file| file.path.clone())
}

fn preview_score(file: &DesignFile) -> (i32, String) {
    let name = file.file_name.to_lowercase();
    let mut score = 0;
    if name.contains("mockup") {
        score += 20;
    }
    if name.contains("preview") {
        score -= 5;
    }
    if file.extension == ".png" {
        score -= 2;
    }
    (score, name)
}

fn build_counts(files: &[DesignFile]) -> SupportCounts {
    let mut counts = SupportCounts::default();
    for file in files {
        match file.extension.as_str() {
            ".ai" => counts.ai += 1,
            ".psd" => counts.psd += 1,
            ".svg" => counts.svg += 1,
            ".pdf" => counts.pdf += 1,
            ".eps" => counts.eps += 1,
            ".zip" => counts.zip += 1,
            ".txt" => counts.txt += 1,
            extension if SUPPORT_EXTENSIONS.contains(&extension) => counts.other += 1,
            _ => {}
        }
    }
    counts
}

fn persist_design(conn: &Connection, design: &CollectedDesign) -> Result<(), String> {
    let now = now_i64();
    let path = path_to_string(&design.path);
    let directory = path_to_string(&design.directory);
    let preview_path = design
        .preview_path
        .as_ref()
        .map(|path| path_to_string(path));
    let preview_cache_path = design
        .preview_cache_path
        .as_ref()
        .map(|path| path_to_string(path));
    let thumbnail_path = design
        .thumbnail_path
        .as_ref()
        .map(|path| path_to_string(path));

    let auto_category = design
        .auto_category
        .as_ref()
        .map(|category| title_caseish(category));

    conn.execute(
        "INSERT INTO designs (
            id, name, path, directory, group_type, preview_path, preview_cache_path, thumbnail_path, total_files,
            updated_at, first_seen, last_seen, missing, favorite, status, category,
            category_user_set, auto_category
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 0, 0, 'pending', ?12, 0, ?12)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            path = excluded.path,
            directory = excluded.directory,
            group_type = excluded.group_type,
            preview_path = excluded.preview_path,
            preview_cache_path = excluded.preview_cache_path,
            thumbnail_path = excluded.thumbnail_path,
            total_files = excluded.total_files,
            updated_at = excluded.updated_at,
            last_seen = excluded.last_seen,
            missing = 0,
            auto_category = excluded.auto_category,
            category = CASE
                WHEN designs.category_user_set = 1 THEN designs.category
                WHEN excluded.auto_category IS NOT NULL THEN excluded.auto_category
                ELSE designs.category
            END",
        params![
            design.id,
            design.name,
            path,
            directory,
            design.group_type,
            preview_path,
            preview_cache_path,
            thumbnail_path,
            design.files.len() as i64,
            design.updated_at,
            now,
            auto_category,
        ],
    )
    .map_err(to_string)?;

    for file in &design.files {
        conn.execute(
            "INSERT INTO files (id, design_id, path, file_name, extension, kind, size, modified, missing)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
             ON CONFLICT(id) DO UPDATE SET
                design_id = excluded.design_id,
                path = excluded.path,
                file_name = excluded.file_name,
                extension = excluded.extension,
                kind = excluded.kind,
                size = excluded.size,
                modified = excluded.modified,
                missing = 0",
            params![
                file.id,
                file.design_id,
                file.path,
                file.file_name,
                file.extension,
                file.kind,
                file.size as i64,
                file.modified,
            ],
        )
        .map_err(to_string)?;
    }

    if let Some(category) = &design.auto_category {
        let category_user_set: i64 = conn
            .query_row(
                "SELECT category_user_set FROM designs WHERE id = ?1",
                params![design.id],
                |row| row.get(0),
            )
            .map_err(to_string)?;
        if category_user_set == 0 {
            upsert_category(conn, category, false)?;
        }
    }

    Ok(())
}

fn load_classification(conn: &Connection, design_id: &str) -> Result<Classification, String> {
    let (favorite, status, category, category_user_set): (i64, String, Option<String>, i64) = conn
        .query_row(
            "SELECT favorite, status, category, category_user_set FROM designs WHERE id = ?1",
            params![design_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(to_string)?;

    let mut stmt = conn
        .prepare(
            "SELECT tags.name
             FROM tags
             INNER JOIN design_tags ON design_tags.tag_id = tags.id
             WHERE design_tags.design_id = ?1
             ORDER BY tags.name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let tags = stmt
        .query_map(params![design_id], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;

    Ok(Classification {
        favorite: favorite != 0,
        status,
        category,
        tags,
        category_user_set: category_user_set != 0,
    })
}

fn sync_auto_tags(conn: &Connection, design_id: &str, auto_tags: &[String]) -> Result<(), String> {
    conn.execute(
        "DELETE FROM design_tags WHERE design_id = ?1 AND source = 'auto'",
        params![design_id],
    )
    .map_err(to_string)?;

    for tag in auto_tags {
        let lower = tag.to_lowercase();
        let ignored: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM ignored_auto_tags WHERE design_id = ?1 AND lower_name = ?2",
                params![design_id, lower],
                |row| row.get(0),
            )
            .optional()
            .map_err(to_string)?;
        if ignored.is_some() {
            continue;
        }

        let tag_id = upsert_tag(conn, tag)?;
        conn.execute(
            "INSERT OR IGNORE INTO design_tags (design_id, tag_id, source) VALUES (?1, ?2, 'auto')",
            params![design_id, tag_id],
        )
        .map_err(to_string)?;
    }

    Ok(())
}

/// Extensiones que puede tener una imagen cacheada, en orden de preferencia.
/// WebP conserva transparencia; JPG es mas liviano para imagenes opacas.
const CACHE_EXTENSIONS: [&str; 2] = ["webp", "jpg"];

/// Lado maximo de una miniatura de la grilla.
const THUMBNAIL_MAX_SIDE: u32 = 320;

/// Lado maximo de la vista previa grande. Las imagenes mas chicas no se agrandan.
const PREVIEW_MAX_SIDE: u32 = 1600;

/// Calidad del JPG cacheado. Solo se usa para imagenes sin transparencia.
const JPEG_QUALITY: u8 = 75;

/// Nombre reservado para la cache que viaja junto a cada carpeta de originales.
const PORTABLE_CACHE_DIR_NAME: &str = "_roxwana-cache";

/// Busca una imagen ya cacheada probando cada extension posible.
fn cached_image(
    app: &AppHandle,
    cache_name: &str,
    preview_path: Option<&Path>,
    updated_at: i64,
) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };
    for extension in CACHE_EXTENSIONS {
        let target = portable_image_cache_path(cache_name, preview_path, extension)?;
        if portable_cache_is_fresh(&target, preview_path) {
            return Ok(Some(target));
        }
    }

    // Compatibilidad transitoria con instalaciones anteriores. La migracion de
    // inicio copia estos archivos a cada carpeta; este respaldo evita una vista
    // vacia si la aplicacion se interrumpiera mientras migra.
    for extension in CACHE_EXTENSIONS {
        let target = legacy_image_cache_path(app, cache_name, preview_path, updated_at, extension)?;
        if target.exists() {
            return Ok(Some(target));
        }
    }
    Ok(None)
}

fn cached_thumbnail(
    app: &AppHandle,
    preview_path: Option<&Path>,
    updated_at: i64,
) -> Result<Option<PathBuf>, String> {
    cached_image(app, "thumbnails", preview_path, updated_at)
}

fn cached_preview(
    app: &AppHandle,
    preview_path: Option<&Path>,
    updated_at: i64,
) -> Result<Option<PathBuf>, String> {
    cached_image(app, "previews", preview_path, updated_at)
}

fn ensure_thumbnail(
    app: &AppHandle,
    preview_path: Option<&Path>,
    updated_at: i64,
) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };

    ensure_cached_image(
        app,
        "thumbnails",
        preview_path,
        updated_at,
        THUMBNAIL_MAX_SIDE,
    )
}

fn ensure_preview_cache(
    app: &AppHandle,
    preview_path: Option<&Path>,
    updated_at: i64,
) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };

    ensure_cached_image(app, "previews", preview_path, updated_at, PREVIEW_MAX_SIDE)
}

/// True si la imagen tiene al menos un pixel que no es totalmente opaco.
/// Un PNG puede declarar canal alfa sin usarlo; en ese caso conviene el JPG liviano.
fn uses_transparency(image: &image::DynamicImage) -> bool {
    use image::GenericImageView;

    if !image.color().has_alpha() {
        return false;
    }
    image.pixels().any(|(_, _, pixel)| pixel.0[3] < 255)
}

/// Genera la copia cacheada de una imagen.
///
/// Reglas:
/// - Nunca agranda: si la imagen ya entra en `max_side`, se guarda en su tamano original.
/// - Si hay que achicar, usa Lanczos3 (mas nitido que el filtro rapido).
/// - Con transparencia real guarda WebP sin perdida; sin transparencia, JPG.
fn ensure_cached_image(
    app: &AppHandle,
    cache_name: &str,
    preview_path: &Path,
    updated_at: i64,
    max_side: u32,
) -> Result<Option<PathBuf>, String> {
    if let Some(existing) = cached_image(app, cache_name, Some(preview_path), updated_at)? {
        return Ok(Some(existing));
    }

    let Ok(source) = image::open(preview_path) else {
        return Ok(None);
    };

    let (width, height) = (source.width(), source.height());
    let cached = if width > max_side || height > max_side {
        // Reduccion en dos pasos. Lanczos3 directo sobre una imagen enorme
        // (8000x8000 = 69 millones de pixeles) tarda decenas de segundos, asi
        // que primero se baja el grueso con el filtro rapido y solo el tramo
        // final se hace con Lanczos3, que es el que aporta la nitidez.
        let prescale = max_side.saturating_mul(3);
        let reduced = if width > prescale || height > prescale {
            source.thumbnail(prescale, prescale)
        } else {
            source
        };
        reduced.resize(max_side, max_side, image::imageops::FilterType::Lanczos3)
    } else {
        source
    };

    let (extension, format) = if uses_transparency(&cached) {
        ("webp", image::ImageFormat::WebP)
    } else {
        ("jpg", image::ImageFormat::Jpeg)
    };

    let target = portable_image_cache_path(cache_name, preview_path, extension)?;
    let cache_dir = target
        .parent()
        .ok_or_else(|| "La ruta de cache portatil no tiene carpeta padre".to_string())?;
    fs::create_dir_all(cache_dir).map_err(to_string)?;
    let sequence = CACHE_TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = target.with_extension(format!(
        "{extension}.{}.{}.part",
        std::process::id(),
        sequence
    ));
    let write_result = match format {
        image::ImageFormat::Jpeg => {
            let mut file = fs::File::create(&temporary).map_err(to_string)?;
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, JPEG_QUALITY);
            cached
                .to_rgb8()
                .write_with_encoder(encoder)
                .map_err(to_string)
        }
        _ => cached
            .into_rgba8()
            .save_with_format(&temporary, format)
            .map_err(to_string),
    };
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    if target.exists() {
        fs::remove_file(&target).map_err(to_string)?;
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        if target.exists() {
            return Ok(Some(target));
        }
        return Err(to_string(error));
    }
    Ok(Some(target))
}

static CACHE_TEMP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn portable_image_cache_path(
    cache_name: &str,
    preview_path: &Path,
    extension: &str,
) -> Result<PathBuf, String> {
    let parent = preview_path.parent().ok_or_else(|| {
        format!(
            "La imagen no tiene carpeta padre: {}",
            preview_path.display()
        )
    })?;
    let file_name = preview_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("imagen")
        .to_lowercase();
    let cache_key = stable_id(&file_name);
    Ok(parent
        .join(PORTABLE_CACHE_DIR_NAME)
        .join(cache_name)
        .join(format!("{cache_key}.{extension}")))
}

fn portable_cache_is_fresh(cache_path: &Path, source_path: &Path) -> bool {
    if !cache_path.exists() {
        return false;
    }

    let Ok(source_metadata) = fs::metadata(source_path) else {
        // Si falta temporalmente el original, conservar la vista previa que ya
        // viajo en la carpeta es mejor que dejar el visor vacio.
        return true;
    };
    let Ok(cache_metadata) = fs::metadata(cache_path) else {
        return false;
    };
    match (source_metadata.modified(), cache_metadata.modified()) {
        (Ok(source_modified), Ok(cache_modified)) => cache_modified >= source_modified,
        _ => true,
    }
}

fn legacy_image_cache_path(
    app: &AppHandle,
    cache_name: &str,
    preview_path: &Path,
    updated_at: i64,
    extension: &str,
) -> Result<PathBuf, String> {
    let metadata = fs::metadata(preview_path).map_err(to_string)?;
    let cache_key = stable_id(&format!(
        "{}:{}:{}",
        normalize_path_for_id(preview_path),
        metadata.len(),
        updated_at
    ));
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("No se pudo resolver APPLOCALDATA: {error}"))?
        .join(cache_name);
    Ok(cache_dir.join(format!("{cache_key}.{extension}")))
}

fn is_portable_cache_path(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(PORTABLE_CACHE_DIR_NAME)
    })
}

/// Copia la cache central de versiones anteriores al lado de cada original y
/// actualiza la base. No borra el origen: la eliminacion se hace solo despues
/// de una verificacion externa completa y de conservar una copia de seguridad.
fn migrate_legacy_cache_to_portable(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT preview_path, updated_at, thumbnail_path, preview_cache_path
             FROM designs
             WHERE missing = 0 AND preview_path IS NOT NULL",
        )
        .map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    drop(stmt);

    for (preview_path, _updated_at, thumbnail_path, preview_cache_path) in rows {
        let source_image = PathBuf::from(&preview_path);
        for (cache_name, stored_path, column) in [
            ("thumbnails", thumbnail_path, "thumbnail_path"),
            ("previews", preview_cache_path, "preview_cache_path"),
        ] {
            let Some(stored_path) = stored_path else {
                continue;
            };
            let legacy = PathBuf::from(&stored_path);
            if !legacy.exists() || is_portable_cache_path(&legacy) {
                continue;
            }
            let Some(extension) = legacy.extension().and_then(|value| value.to_str()) else {
                continue;
            };
            let target = portable_image_cache_path(cache_name, &source_image, extension)?;
            if !target.exists() {
                let target_dir = target
                    .parent()
                    .ok_or_else(|| "La cache portatil no tiene carpeta padre".to_string())?;
                fs::create_dir_all(target_dir).map_err(to_string)?;
                let sequence =
                    CACHE_TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let temporary = target.with_extension(format!(
                    "{extension}.migration.{}.{}.part",
                    std::process::id(),
                    sequence
                ));
                let copied = fs::copy(&legacy, &temporary).map_err(to_string)?;
                if copied == 0 || copied != fs::metadata(&legacy).map_err(to_string)?.len() {
                    let _ = fs::remove_file(&temporary);
                    return Err(format!("La copia quedo incompleta: {}", legacy.display()));
                }
                fs::rename(&temporary, &target).map_err(to_string)?;
            }
            let sql = format!("UPDATE designs SET {column} = ?1 WHERE preview_path = ?2");
            conn.execute(&sql, params![path_to_string(&target), preview_path])
                .map_err(to_string)?;
        }
    }

    // Resolver la ruta valida aqui tambien mantiene fallos de configuracion
    // visibles durante la migracion, aunque no haya filas antiguas.
    let _ = app.path().app_local_data_dir().map_err(to_string)?;
    Ok(())
}

fn classify_design(name: &str, files: &[DesignFile]) -> (Option<String>, Vec<String>) {
    let mut haystack = name.to_lowercase();
    for file in files {
        haystack.push(' ');
        haystack.push_str(&file.file_name.to_lowercase());
    }

    let mut tags = BTreeSet::new();
    let mut category = None;

    let mut rule = |needles: &[&str], chosen_category: &str, rule_tags: &[&str]| {
        if needles.iter().any(|needle| haystack.contains(needle)) {
            if category.is_none() {
                category = Some(chosen_category.to_string());
            }
            for tag in rule_tags {
                tags.insert((*tag).to_string());
            }
        }
    };

    rule(
        &["skate", "skater", "skateboard", "longboard"],
        "Skater",
        &["skate", "skater", "urbano"],
    );
    rule(
        &["skull", "calavera", "dead", "death", "skeleton", "muertos"],
        "Calaveras",
        &["calavera"],
    );
    rule(
        &[
            "surf", "surfer", "wave", "beach", "summer", "tropical", "palms",
        ],
        "Surf y playa",
        &["surf", "playa"],
    );
    rule(
        &[
            "dog",
            "cat",
            "tiger",
            "lion",
            "bear",
            "wolf",
            "panther",
            "shark",
            "crocodile",
            "frog",
            "eagle",
            "raven",
            "moth",
            "butterfly",
            "animal",
            "axolotl",
            "whale",
            "vulture",
            "turtle",
        ],
        "Animales",
        &["animales"],
    );
    rule(
        &[
            "man",
            "men",
            "male",
            "boy",
            "father",
            "cowboy",
            "professor",
            "rider",
            "biker",
        ],
        "Hombre",
        &["hombre"],
    );
    rule(
        &["woman", "women", "female", "girl", "mother", "mujer"],
        "Mujer",
        &["mujer"],
    );
    rule(
        &["motorcycle", "bike", "biker", "cafe-racer", "ride"],
        "Motos",
        &["motos"],
    );
    rule(
        &["rock", "punk", "metal", "guitar"],
        "Rock",
        &["rock", "musica"],
    );
    rule(
        &[
            "music",
            "musician",
            "trumpet",
            "reggae",
            "cumbia",
            "reggaeton",
            "bachata",
            "album",
        ],
        "Musica",
        &["musica"],
    );
    rule(
        &[
            "quote",
            "motivational",
            "lettering",
            "typography",
            "slogan",
            "frase",
        ],
        "Frases",
        &["frases", "tipografia"],
    );
    rule(
        &["gothic", "occult", "raven", "dark", "graveyard"],
        "Gotico",
        &["gotico"],
    );
    rule(
        &["retro", "vintage", "80s", "y2k", "neon", "pop-art"],
        "Retro",
        &["retro", "vintage"],
    );
    rule(
        &[
            "flower", "nature", "sun", "moon", "desert", "cactus", "climate",
        ],
        "Naturaleza",
        &["naturaleza"],
    );
    rule(&["love", "heart", "valentine", "mother"], "Amor", &["amor"]);
    rule(
        &["halloween", "hocus", "ghost"],
        "Halloween",
        &["halloween"],
    );
    rule(
        &["dia-de-los-muertos", "muertos"],
        "Dia de los muertos",
        &["dia de los muertos"],
    );
    rule(
        &["football", "basket", "skiing", "hunting", "sport"],
        "Deportes",
        &["deportes"],
    );
    rule(
        &["cowboy", "western", "wild-west", "arizona"],
        "Oeste",
        &["oeste"],
    );
    rule(
        &[
            "streetwear",
            "street-wear",
            "urban",
            "bronx",
            "los-angeles",
            "brutalism",
        ],
        "Urbano",
        &["urbano", "streetwear"],
    );
    rule(
        &[
            "text-effect",
            "logo",
            "badge",
            "template",
            "poster",
            "emblem",
        ],
        "Textos y efectos",
        &["editable"],
    );
    rule(
        &["abstract", "grunge", "gradient", "pattern"],
        "Abstracto",
        &["abstracto"],
    );
    rule(
        &["cute", "dinosaur", "bunny", "unicorn", "happy"],
        "Infantil",
        &["infantil"],
    );

    if files.iter().any(|file| file.extension == ".ai") {
        tags.insert("ai".to_string());
    }
    if files.iter().any(|file| file.extension == ".psd") {
        tags.insert("psd".to_string());
    }
    if files.iter().any(|file| file.extension == ".eps") {
        tags.insert("eps".to_string());
    }
    if files.iter().any(|file| file.extension == ".zip") {
        tags.insert("zip".to_string());
    }

    let category = category.or_else(|| Some("Otros".to_string()));
    (category, tags.into_iter().collect())
}

fn save_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(to_string)?;
    Ok(())
}

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(to_string)
}

fn upsert_category(conn: &Connection, name: &str, user_created: bool) -> Result<(), String> {
    let normalized = title_caseish(name);
    conn.execute(
        "INSERT INTO categories (id, name, lower_name, sort_order, user_created)
         VALUES (?1, ?2, ?3, COALESCE((SELECT MAX(sort_order) + 1 FROM categories), 0), ?4)
         ON CONFLICT(lower_name) DO UPDATE SET
            name = excluded.name,
            user_created = categories.user_created OR excluded.user_created",
        params![
            stable_id(&format!("category:{}", normalized.to_lowercase())),
            normalized,
            name.to_lowercase(),
            user_created as i32,
        ],
    )
    .map_err(to_string)?;
    Ok(())
}

fn normalize_category(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(title_caseish(trimmed))
    }
}

fn upsert_tag(conn: &Connection, tag: &str) -> Result<String, String> {
    let normalized = normalize_tag(tag).ok_or_else(|| "La etiqueta esta vacia".to_string())?;
    let lower = normalized.to_lowercase();
    let tag_id = stable_id(&format!("tag:{lower}"));
    conn.execute(
        "INSERT INTO tags (id, name, lower_name)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(lower_name) DO UPDATE SET name = excluded.name",
        params![tag_id, normalized, lower],
    )
    .map_err(to_string)?;
    Ok(tag_id)
}

fn get_tag_id(conn: &Connection, lower_name: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM tags WHERE lower_name = ?1",
        params![lower_name],
        |row| row.get(0),
    )
    .optional()
    .map_err(to_string)
}

/// Categories in the order the panel shows them: loose categories and groups by
/// their position, with the categories of a group right after their group.
fn load_categories(conn: &Connection) -> Result<Vec<String>, String> {
    Ok(flatten_sidebar(&load_sidebar(conn)?))
}

fn flatten_sidebar(sidebar: &[SidebarNode]) -> Vec<String> {
    let mut names = Vec::new();
    for node in sidebar {
        if node.kind == "group" {
            names.extend(node.children.iter().cloned());
        } else {
            names.push(node.name.clone());
        }
    }
    names
}

fn load_sidebar(conn: &Connection) -> Result<Vec<SidebarNode>, String> {
    let mut group_stmt = conn
        .prepare(
            "SELECT id, name, sort_order, collapsed FROM category_groups
             ORDER BY sort_order, name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let groups = group_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)? != 0,
            ))
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;

    let mut category_stmt = conn
        .prepare(
            "SELECT name, sort_order, group_id FROM categories
             WHERE user_created = 1
                OR EXISTS (
                    SELECT 1 FROM designs
                    WHERE designs.missing = 0
                      AND lower(trim(designs.category)) = categories.lower_name
                )
             ORDER BY sort_order, name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let categories = category_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;

    let group_ids = groups
        .iter()
        .map(|(id, _, _, _)| id.clone())
        .collect::<BTreeSet<_>>();

    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut roots: Vec<(i64, String, SidebarNode)> = Vec::new();

    for (name, sort_order, group_id) in categories {
        match group_id {
            Some(id) if group_ids.contains(&id) => {
                children.entry(id).or_default().push(name);
            }
            _ => {
                let lower = name.to_lowercase();
                roots.push((
                    sort_order,
                    lower,
                    SidebarNode {
                        kind: String::from("category"),
                        name,
                        collapsed: false,
                        children: Vec::new(),
                    },
                ));
            }
        }
    }

    for (id, name, sort_order, collapsed) in groups {
        let group_children = children.remove(&id).unwrap_or_default();
        let lower = name.to_lowercase();
        roots.push((
            sort_order,
            lower,
            SidebarNode {
                kind: String::from("group"),
                name,
                collapsed,
                children: group_children,
            },
        ));
    }

    roots.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(roots.into_iter().map(|(_, _, node)| node).collect())
}

fn load_group_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM category_groups ORDER BY sort_order, name COLLATE NOCASE")
        .map_err(to_string)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(names)
}

/// Groups and categories share the panel, so a name can only belong to one of them.
fn ensure_sidebar_name_free(
    conn: &Connection,
    lower_name: &str,
    allow_group: Option<&str>,
    allow_category: Option<&str>,
) -> Result<(), String> {
    let group_taken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM category_groups WHERE lower_name = ?1 AND lower_name <> ?2",
            params![lower_name, allow_group.unwrap_or("")],
            |row| row.get(0),
        )
        .map_err(to_string)?;
    if group_taken > 0 {
        return Err("Ya existe un grupo con ese nombre".to_string());
    }

    let category_taken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM categories WHERE lower_name = ?1 AND lower_name <> ?2",
            params![lower_name, allow_category.unwrap_or("")],
            |row| row.get(0),
        )
        .map_err(to_string)?;
    if category_taken > 0 {
        return Err("Ya existe una categoria con ese nombre".to_string());
    }

    Ok(())
}

fn write_sidebar_layout(
    conn: &mut Connection,
    nodes: &[SidebarNodeInput],
) -> Result<Vec<SidebarNode>, String> {
    let existing_categories = load_categories(conn)?
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect::<BTreeSet<_>>();
    let existing_groups = load_group_names(conn)?
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect::<BTreeSet<_>>();

    let mut seen_categories = BTreeSet::new();
    let mut seen_groups = BTreeSet::new();
    for node in nodes {
        let lower = node.name.trim().to_lowercase();
        if node.kind == "group" {
            if !seen_groups.insert(lower) {
                return Err("El panel tiene grupos repetidos".to_string());
            }
            for child in &node.children {
                if !seen_categories.insert(child.trim().to_lowercase()) {
                    return Err("El panel tiene categorias repetidas".to_string());
                }
            }
        } else {
            if !node.children.is_empty() {
                return Err("Una categoria no puede contener otras".to_string());
            }
            if !seen_categories.insert(lower) {
                return Err("El panel tiene categorias repetidas".to_string());
            }
        }
    }

    if seen_categories != existing_categories || seen_groups != existing_groups {
        return Err("El orden del panel no coincide con la biblioteca actual".to_string());
    }

    let transaction = conn.transaction().map_err(to_string)?;
    for (index, node) in nodes.iter().enumerate() {
        let lower = node.name.trim().to_lowercase();
        if node.kind == "group" {
            transaction
                .execute(
                    "UPDATE category_groups SET sort_order = ?1, collapsed = ?2 WHERE lower_name = ?3",
                    params![index as i64, node.collapsed as i32, lower],
                )
                .map_err(to_string)?;
            let group_id: String = transaction
                .query_row(
                    "SELECT id FROM category_groups WHERE lower_name = ?1",
                    params![lower],
                    |row| row.get(0),
                )
                .map_err(to_string)?;
            for (child_index, child) in node.children.iter().enumerate() {
                transaction
                    .execute(
                        "UPDATE categories SET group_id = ?1, sort_order = ?2 WHERE lower_name = ?3",
                        params![group_id, child_index as i64, child.trim().to_lowercase()],
                    )
                    .map_err(to_string)?;
            }
        } else {
            transaction
                .execute(
                    "UPDATE categories SET group_id = NULL, sort_order = ?1 WHERE lower_name = ?2",
                    params![index as i64, lower],
                )
                .map_err(to_string)?;
        }
    }
    transaction.commit().map_err(to_string)?;
    load_sidebar(conn)
}

fn load_tags(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM tags ORDER BY name COLLATE NOCASE")
        .map_err(to_string)?;
    let tags = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(tags)
}

fn extension_for(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default()
}

fn is_supported_extension(extension: &str) -> bool {
    PREVIEW_EXTENSIONS.contains(&extension) || SUPPORT_EXTENSIONS.contains(&extension)
}

fn kind_for_extension(extension: &str) -> &'static str {
    if PREVIEW_EXTENSIONS.contains(&extension) {
        "preview"
    } else if SUPPORT_EXTENSIONS.contains(&extension) {
        "support"
    } else {
        "other"
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize_path_for_id(left) == normalize_path_for_id(right)
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => same_path(&left, &right),
        _ => same_path(left, right),
    }
}

fn normalize_path_for_id(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn sqlite_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn stable_id(input: &str) -> String {
    let hash = Sha256::digest(input.as_bytes());
    hash.iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn system_time_to_i64(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs() as i64)
}

fn now_i64() -> i64 {
    system_time_to_i64(SystemTime::now()).unwrap_or(0)
}

fn title_from_slug(value: &str) -> String {
    value
        .replace(['_', '-'], " ")
        .split_whitespace()
        .map(title_caseish)
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_caseish(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_tag(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase().replace('_', " ");
    let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn to_string<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_initial_state,
            get_brand_logo,
            save_brand_logo,
            remove_brand_logo,
            get_references,
            scan_references,
            create_reference_category,
            update_reference_favorite,
            update_reference_status,
            send_reference_to_work,
            get_library_from_db,
            get_design_detail,
            scan_library,
            rescan_paths,
            generate_thumbnail,
            generate_thumbnails_bulk,
            generate_preview,
            generate_previews_bulk,
            update_design_favorite,
            update_design_status,
            update_design_category,
            create_category,
            rename_category,
            delete_category,
            save_sidebar_layout,
            create_category_group,
            rename_category_group,
            delete_category_group,
            set_category_group_collapsed,
            add_design_tag,
            remove_design_tag,
            open_design_folder,
            reveal_design_file,
            save_database_backup,
            open_backup_folder,
            restore_database_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn encodes_brand_logo_bytes_as_base64() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn groups_root_files_by_stem_and_subfolders_by_directory() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("submit_09.jpg"), b"image").unwrap();
        fs::write(dir.path().join("submit_09.eps"), b"eps").unwrap();
        let child = dir.path().join("skateboard-skull");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("preview.jpg"), b"image").unwrap();
        fs::write(child.join("editable.psd"), b"psd").unwrap();

        let designs = collect_designs(dir.path()).unwrap();
        assert_eq!(designs.len(), 2);
        assert!(designs
            .iter()
            .any(|design| design.group_type == "loose_file" && design.files.len() == 2));
        assert!(designs
            .iter()
            .any(|design| design.name == "Skateboard Skull" && design.counts.psd == 1));
    }

    #[test]
    fn imports_category_folders_as_categories_and_keeps_each_image_separate() {
        let dir = tempdir().unwrap();
        let category = dir.path().join(CATEGORIES_DIR_NAME).join("Ninos y bebes");
        fs::create_dir_all(&category).unwrap();
        fs::write(category.join("osito.png"), b"image-one").unwrap();
        fs::write(category.join("dinosaurio.jpg"), b"image-two").unwrap();

        let designs = collect_designs(dir.path()).unwrap();

        assert_eq!(designs.len(), 2);
        assert!(designs.iter().all(|design| {
            design.auto_category.as_deref() == Some("Ninos Y Bebes")
                && design.group_type == "loose_file"
                && design.files.len() == 1
        }));
    }

    #[test]
    fn applies_physical_category_to_nested_design_folders() {
        let dir = tempdir().unwrap();
        let categories_root = dir.path().join(CATEGORIES_DIR_NAME);
        let design_dir = categories_root.join("Animales").join("tigre-editable");
        fs::create_dir_all(&design_dir).unwrap();
        fs::write(design_dir.join("preview.png"), b"image").unwrap();
        fs::write(design_dir.join("editable.psd"), b"support").unwrap();

        let designs = collect_designs(&categories_root).unwrap();

        assert_eq!(designs.len(), 1);
        assert_eq!(designs[0].auto_category.as_deref(), Some("Animales"));
        assert_eq!(designs[0].files.len(), 2);
    }

    #[test]
    fn reads_reorganized_library_and_reserves_references() {
        let dir = tempdir().unwrap();
        let freepik_design = dir.path().join("Freepik").join("skull-poster");
        let freepik_root = dir.path().join("Freepik");
        let work = dir.path().join("Trabajos").join("Che Guevara");
        let loose = dir.path().join(LOOSE_DIR_NAME).join("ideas-varias");
        let reference = dir.path().join("Referencias").join("Rolling Stones");
        fs::create_dir_all(&freepik_design).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&loose).unwrap();
        fs::create_dir_all(&reference).unwrap();
        fs::write(freepik_design.join("preview.png"), b"freepik-folder").unwrap();
        fs::write(freepik_root.join("skull-poster.png"), b"matching-loose").unwrap();
        fs::write(freepik_root.join("imagen-suelta.jpg"), b"freepik-loose").unwrap();
        fs::write(work.join("che.png"), b"work-image").unwrap();
        fs::write(loose.join("idea.png"), b"loose-image").unwrap();
        fs::write(reference.join("idea.png"), b"reference-image").unwrap();

        let designs = collect_designs(dir.path()).unwrap();

        assert_eq!(designs.len(), 4);
        assert!(designs.iter().any(|design| design.name == "Skull Poster"
            && design.files.len() == 2
            && design.auto_category.is_none()));
        assert!(designs.iter().any(|design| {
            design.name == "Imagen Suelta"
                && design.group_type == "loose_file"
                && design.auto_category.is_none()
        }));
        assert!(designs.iter().any(|design| {
            design.name == "Che"
                && design.group_type == "loose_file"
                && design.auto_category.as_deref() == Some("Che Guevara")
        }));
        assert!(designs.iter().any(|design| {
            design.name == "Ideas Varias"
                && design.group_type == "folder"
                && design.auto_category.is_none()
        }));
        assert!(designs.iter().all(|design| {
            !design
                .files
                .iter()
                .any(|file| file.path.contains(REFERENCES_DIR_NAME))
        }));
    }

    #[test]
    fn reads_each_nested_work_item_and_assigns_the_work_name() {
        let dir = tempdir().unwrap();
        let work = dir.path().join(WORKS_DIR_NAME).join("Campana verano");
        let previews = work.join("previews");
        let editables = work.join("editables");
        fs::create_dir_all(&previews).unwrap();
        fs::create_dir_all(&editables).unwrap();
        fs::write(previews.join("frente.png"), b"preview").unwrap();
        fs::write(editables.join("frente.psd"), b"editable").unwrap();

        let designs = collect_designs(dir.path()).unwrap();

        assert_eq!(designs.len(), 2);
        assert!(designs.iter().any(|design| {
            design.name == "Previews"
                && design.files.len() == 1
                && design.auto_category.as_deref() == Some("Campana Verano")
        }));
        assert!(designs.iter().any(|design| {
            design.name == "Editables"
                && design.files.len() == 1
                && design.auto_category.as_deref() == Some("Campana Verano")
        }));
    }

    #[test]
    fn prepares_safe_windows_folder_names() {
        assert_eq!(
            safe_folder_name(" Capitan: America ").unwrap(),
            "Capitan- America"
        );
        assert!(safe_folder_name("CON").is_err());
        assert!(safe_folder_name("  ...  ").is_err());
    }

    #[test]
    fn copies_a_reference_into_a_flat_work_folder_without_moving_the_original() {
        let dir = tempdir().unwrap();
        let source = dir
            .path()
            .join(REFERENCES_DIR_NAME)
            .join("Superheroes")
            .join("capitan.png");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"reference-image").unwrap();

        let work_path =
            copy_reference_into_work(dir.path(), &source, "capitan.png", "Capitan America")
                .unwrap();

        assert!(source.is_file());
        assert_eq!(
            work_path,
            dir.path().join(WORKS_DIR_NAME).join("Capitan America")
        );
        assert_eq!(
            fs::read(work_path.join("capitan.png")).unwrap(),
            b"reference-image"
        );
        assert!(!work_path.join(REFERENCES_DIR_NAME).exists());
    }

    #[test]
    fn reference_scan_ignores_portable_cache_at_any_depth() {
        let dir = tempdir().unwrap();
        let category = dir.path().join(REFERENCES_DIR_NAME).join("Che");
        let cache = category
            .join(PORTABLE_CACHE_DIR_NAME)
            .join("thumbnails");
        let nested_cache = cache
            .join(PORTABLE_CACHE_DIR_NAME)
            .join("thumbnails");
        fs::create_dir_all(&nested_cache).unwrap();

        let original = category.join("original.jpg");
        fs::write(&original, b"original").unwrap();
        fs::write(cache.join("miniatura.jpg"), b"cache").unwrap();
        fs::write(nested_cache.join("miniatura-de-miniatura.jpg"), b"cache").unwrap();

        let paths = collect_reference_image_paths(&dir.path().join(REFERENCES_DIR_NAME)).unwrap();

        assert_eq!(paths, vec![original]);
    }

    #[test]
    fn purges_only_reference_rows_that_belong_to_portable_cache() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO reference_images (
                id, root_path, name, file_name, path, folder_path, category,
                size, modified, first_seen, last_seen, missing
             ) VALUES
                ('original', 'D:\\Biblioteca', 'Original', 'original.jpg',
                 'D:\\Biblioteca\\Referencias\\Che\\original.jpg',
                 'D:\\Biblioteca\\Referencias\\Che', 'Che', 1, 1, 1, 1, 0),
                ('cache', 'D:\\Biblioteca', 'Cache', 'cache.jpg',
                 'D:\\Biblioteca\\Referencias\\Che\\_roxwana-cache\\thumbnails\\cache.jpg',
                 'D:\\Biblioteca\\Referencias\\Che\\_roxwana-cache\\thumbnails',
                 'Che', 1, 1, 1, 1, 1);",
        )
        .unwrap();

        assert_eq!(purge_reference_cache_rows(&conn, "D:\\Biblioteca").unwrap(), 1);
        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM reference_images ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec!["original".to_string()]);
    }

    #[test]
    fn persists_reference_state_separately_from_library_designs() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO reference_images (
                id, root_path, name, file_name, path, folder_path, category,
                size, modified, first_seen, last_seen, favorite, status, work_path
             ) VALUES ('ref-1', 'C:\\Biblioteca', 'Capitan', 'capitan.png',
                       'C:\\Biblioteca\\Referencias\\Marvel\\capitan.png',
                       'C:\\Biblioteca\\Referencias\\Marvel', 'Marvel',
                       42, 123, 1, 1, 1, 'working',
                       'C:\\Biblioteca\\Trabajos\\Capitan America')",
            [],
        )
        .unwrap();

        let references = load_references_from_db(&conn, "C:\\Biblioteca").unwrap();
        assert_eq!(references.len(), 1);
        assert!(references[0].favorite);
        assert_eq!(references[0].status, "working");
        assert_eq!(references[0].category, "Marvel");
        assert_eq!(
            references[0].work_path.as_deref(),
            Some("C:\\Biblioteca\\Trabajos\\Capitan America")
        );
    }

    #[test]
    fn preserves_manual_classification_when_design_moves_inside_library() {
        let dir = tempdir().unwrap();
        let original_folder = dir.path().join("poster-original");
        fs::create_dir_all(&original_folder).unwrap();
        fs::write(original_folder.join("preview.png"), b"same-image").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        let previous = collect_designs(dir.path()).unwrap().remove(0);
        persist_design(&conn, &previous).unwrap();
        upsert_category(&conn, "Mi rubro", true).unwrap();
        conn.execute(
            "UPDATE designs SET favorite = 1, status = 'ready', category = 'Mi Rubro', category_user_set = 1 WHERE id = ?1",
            params![previous.id],
        )
        .unwrap();
        let matches = load_content_relocation_matches(&conn).unwrap();

        let moved_folder = dir.path().join("Freepik").join("poster-original");
        fs::create_dir_all(moved_folder.parent().unwrap()).unwrap();
        fs::rename(&original_folder, &moved_folder).unwrap();
        conn.execute("UPDATE designs SET missing = 1", []).unwrap();
        conn.execute("UPDATE files SET missing = 1", []).unwrap();

        let current = collect_designs(dir.path()).unwrap().remove(0);
        persist_design(&conn, &current).unwrap();
        let previous_id = matches
            .get(&design_content_fingerprint(&current.files))
            .unwrap();
        copy_design_classification(&conn, previous_id, &current.id).unwrap();
        let classification = load_classification(&conn, &current.id).unwrap();

        assert!(classification.favorite);
        assert_eq!(classification.status, "ready");
        assert_eq!(classification.category.as_deref(), Some("Mi Rubro"));
        assert!(classification.category_user_set);
    }

    #[test]
    fn keeps_existing_category_when_rescanning_loose_content() {
        let dir = tempdir().unwrap();
        let design_folder = dir.path().join(FREEPIK_DIR_NAME).join("oso-infantil");
        fs::create_dir_all(&design_folder).unwrap();
        fs::write(design_folder.join("preview.png"), b"image").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        let design = collect_designs(dir.path()).unwrap().remove(0);
        persist_design(&conn, &design).unwrap();
        conn.execute(
            "UPDATE designs
             SET category = 'Infantil', auto_category = 'Infantil', category_user_set = 0
             WHERE id = ?1",
            params![design.id],
        )
        .unwrap();

        let rescanned = collect_designs(dir.path()).unwrap().remove(0);
        assert!(rescanned.auto_category.is_none());
        persist_design(&conn, &rescanned).unwrap();

        let category: Option<String> = conn
            .query_row(
                "SELECT category FROM designs WHERE id = ?1",
                params![rescanned.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(category.as_deref(), Some("Infantil"));
    }

    #[test]
    fn preserves_exact_metadata_when_moved_designs_have_identical_files() {
        let dir = tempdir().unwrap();
        let first_folder = dir.path().join("poster-a");
        let second_folder = dir.path().join("poster-b");
        fs::create_dir_all(&first_folder).unwrap();
        fs::create_dir_all(&second_folder).unwrap();
        fs::write(first_folder.join("preview.png"), b"same-image").unwrap();
        fs::write(second_folder.join("preview.png"), b"same-image").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        let previous = collect_designs(dir.path()).unwrap();
        for design in &previous {
            persist_design(&conn, design).unwrap();
        }
        let favorite_id = previous
            .iter()
            .find(|design| design.name == "Poster A")
            .unwrap()
            .id
            .clone();
        conn.execute(
            "UPDATE designs SET favorite = 1 WHERE id = ?1",
            params![favorite_id],
        )
        .unwrap();
        let matches = load_layout_relocation_matches(&conn, dir.path()).unwrap();

        let freepik = dir.path().join("Freepik");
        fs::create_dir_all(&freepik).unwrap();
        fs::rename(&first_folder, freepik.join("poster-a")).unwrap();
        fs::rename(&second_folder, freepik.join("poster-b")).unwrap();
        conn.execute("UPDATE designs SET missing = 1", []).unwrap();
        conn.execute("UPDATE files SET missing = 1", []).unwrap();

        let current = collect_designs(dir.path()).unwrap();
        for design in &current {
            persist_design(&conn, design).unwrap();
            let previous_id = matches.get(&normalize_path_for_id(&design.path)).unwrap();
            copy_design_classification(&conn, previous_id, &design.id).unwrap();
        }

        let first = current
            .iter()
            .find(|design| design.name == "Poster A")
            .unwrap();
        let second = current
            .iter()
            .find(|design| design.name == "Poster B")
            .unwrap();
        assert!(load_classification(&conn, &first.id).unwrap().favorite);
        assert!(!load_classification(&conn, &second.id).unwrap().favorite);
    }

    #[test]
    fn preserves_manual_classification_when_library_root_moves() {
        let dir = tempdir().unwrap();
        let previous_root = dir.path().join("anterior");
        let current_root = dir.path().join("actual");
        fs::create_dir_all(previous_root.join("diseno")).unwrap();
        fs::create_dir_all(current_root.join("diseno")).unwrap();
        fs::write(
            previous_root.join("diseno").join("preview.png"),
            b"same-image",
        )
        .unwrap();
        fs::write(
            current_root.join("diseno").join("preview.png"),
            b"same-image",
        )
        .unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        let previous = collect_designs(&previous_root).unwrap().remove(0);
        persist_design(&conn, &previous).unwrap();
        upsert_category(&conn, "Mi rubro", true).unwrap();
        conn.execute(
            "UPDATE designs SET favorite = 1, status = 'ready', category = 'Mi Rubro', category_user_set = 1 WHERE id = ?1",
            params![previous.id],
        )
        .unwrap();
        conn.execute("UPDATE designs SET missing = 1", []).unwrap();
        conn.execute("UPDATE files SET missing = 1", []).unwrap();

        let matches = load_relocation_matches(&conn, &previous_root).unwrap();
        let current = collect_designs(&current_root).unwrap().remove(0);
        persist_design(&conn, &current).unwrap();
        let previous_id = matches
            .get(&relocation_key(&current_root, &current))
            .unwrap();
        copy_design_classification(&conn, previous_id, &current.id).unwrap();
        let classification = load_classification(&conn, &current.id).unwrap();

        assert!(classification.favorite);
        assert_eq!(classification.status, "ready");
        assert_eq!(classification.category.as_deref(), Some("Mi Rubro"));
        assert!(classification.category_user_set);
    }

    #[test]
    fn classifies_spanish_editable_suggestions() {
        let files = vec![DesignFile {
            id: "1".into(),
            design_id: "1".into(),
            path: "skateboard-skull/editable.ai".into(),
            file_name: "skateboard-skull.ai".into(),
            extension: ".ai".into(),
            kind: "support".into(),
            size: 1,
            modified: 1,
        }];

        let (category, tags) = classify_design("skateboard skull", &files);
        assert_eq!(category.as_deref(), Some("Skater"));
        assert!(tags.contains(&"skate".to_string()));
        assert!(tags.contains(&"ai".to_string()));
    }

    #[test]
    fn persists_sidebar_order() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        upsert_category(&conn, "Categoria A", true).unwrap();
        upsert_category(&conn, "Categoria B", true).unwrap();
        let mut sidebar = load_sidebar(&conn).unwrap();
        sidebar.swap(0, 1);
        let nodes = sidebar
            .iter()
            .map(|node| SidebarNodeInput {
                kind: node.kind.clone(),
                name: node.name.clone(),
                collapsed: node.collapsed,
                children: node.children.clone(),
            })
            .collect::<Vec<_>>();
        let expected = flatten_sidebar(&sidebar);

        let saved = write_sidebar_layout(&mut conn, &nodes).unwrap();

        assert_eq!(flatten_sidebar(&saved), expected);
        assert_eq!(load_categories(&conn).unwrap(), expected);
    }

    #[test]
    fn normalizes_orphan_design_categories() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        conn.execute(
            "UPDATE categories SET name = 'Textos Y Efectos' WHERE lower_name = 'textos y efectos'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO designs (
                id, name, path, directory, group_type, total_files, updated_at, first_seen, last_seen,
                category, category_user_set
             )
             VALUES
                ('canonical', 'Canonical', 'c:/canonical', 'c:/', 'folder', 1, 1, 1, 1, 'Textos y efectos', 0),
                ('orphan', 'Orphan', 'c:/orphan', 'c:/', 'folder', 1, 1, 1, 1, 'Categoria Perdida', 0),
                ('blank', 'Blank', 'c:/blank', 'c:/', 'folder', 1, 1, 1, 1, '   ', 0)",
            [],
        )
        .unwrap();

        normalize_design_categories(&conn).unwrap();

        let canonical: Option<String> = conn
            .query_row(
                "SELECT category FROM designs WHERE id = 'canonical'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let orphan: (Option<String>, i64) = conn
            .query_row(
                "SELECT category, category_user_set FROM designs WHERE id = 'orphan'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let blank: (Option<String>, i64) = conn
            .query_row(
                "SELECT category, category_user_set FROM designs WHERE id = 'blank'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(canonical.as_deref(), Some("Textos Y Efectos"));
        assert_eq!(orphan, (None, 1));
        assert_eq!(blank, (None, 1));
    }

    #[test]
    fn exports_database_backup_with_vacuum_into() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("source.sqlite");
        let backup_path = dir.path().join("backup.sqlite");
        let conn = Connection::open(&db_path).unwrap();
        ensure_database(&conn).unwrap();
        upsert_category(&conn, "Categoria prueba", true).unwrap();

        conn.execute_batch("PRAGMA wal_checkpoint(FULL);").unwrap();
        let quoted_path = sqlite_string_literal(&path_to_string(&backup_path));
        conn.execute_batch(&format!("VACUUM INTO {quoted_path};"))
            .unwrap();
        drop(conn);

        validate_backup_database(&backup_path).unwrap();
        let backup =
            Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let categories = load_categories(&backup).unwrap();

        assert!(categories
            .iter()
            .any(|category| category == "Categoria Prueba"));
    }
}
