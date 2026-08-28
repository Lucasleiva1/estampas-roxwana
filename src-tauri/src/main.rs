#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;
use walkdir::WalkDir;

const FREEPIK_DIR_NAME: &str = "Freepik";
const WORKS_DIR_NAME: &str = "Trabajos";
const CATEGORIES_DIR_NAME: &str = "Categorías";
const LOOSE_DIR_NAME: &str = "Suelta";
/// Nombre de la carpeta suelta en las instalaciones nuevas. Convive con
/// `Suelta`: las dos hacen lo mismo, para que una biblioteca armada antes siga
/// funcionando igual.
const MISC_DIR_NAME: &str = "Varios";
/// Carpetas que se crean al elegir una biblioteca por primera vez, para que el
/// usuario sepa donde va cada cosa sin tener que adivinar.
const STARTER_DIR_NAMES: &[&str] = &[
    CATEGORIES_DIR_NAME,
    WORKS_DIR_NAME,
    REFERENCES_DIR_NAME,
    MISC_DIR_NAME,
];
const REFERENCES_DIR_NAME: &str = "Referencias";
const PREFERENCES_DIR_NAME: &str = "Preferences";
const LEGACY_COMPLETE_DIR_NAME: &str = "1-COMPLETAS";
const PREVIEW_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp"];
const SUPPORT_EXTENSIONS: &[&str] = &[".ai", ".psd", ".svg", ".pdf", ".eps", ".zip", ".txt"];
const STATUSES: &[&str] = &["pending", "working", "ready", "discarded"];
const REFERENCE_STATUSES: &[&str] = &["pending", "working", "done"];
const CONTENT_LAYOUT_VERSION: &str = "github-layout-restored-v1";
const BACKUP_FILE_NAME: &str = "biblioteca-visual-respaldo.sqlite";
const RESTORE_SAFETY_FILE_NAME: &str = "biblioteca-visual-antes-de-cargar.sqlite";
const LOCAL_DATABASE_RESCUE_FILE_NAME: &str = "biblioteca-visual-antes-de-reemplazar.sqlite";
const PORTABLE_PREFERENCES_FILE_NAME: &str = "roxwana-preferences-v1.0.0.sqlite";
const PORTABLE_PREFERENCES_PREVIOUS_FILE_NAME: &str =
    "roxwana-preferences-v1.0.0-anterior-1.sqlite";
const PORTABLE_PREFERENCES_OLDER_FILE_NAME: &str = "roxwana-preferences-v1.0.0-anterior-2.sqlite";
const PORTABLE_PREFERENCES_REVISION_SETTING: &str = "portable_preferences_revision";
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
    /// Explicacion en criollo de por que la carpeta guardada no se puede usar
    /// ahora mismo: disco desconectado, carpeta movida o permisos bloqueados.
    /// Vacio cuando la biblioteca esta sana.
    root_issue: Option<String>,
}

/// Resultado de revisar una carpeta antes de adoptarla como biblioteca.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderCheck {
    path: String,
    warnings: Vec<String>,
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
    // La migracion de la cache vieja es transitoria. Si falla, la aplicacion
    // tiene que abrir igual y regenerar las miniaturas que falten: nunca puede
    // dejar al usuario sin poder entrar.
    if let Err(error) = migrate_legacy_cache_to_portable(&app, &conn) {
        eprintln!("No se pudo migrar la cache anterior: {error}");
    }
    // Sin biblioteca elegida la ruta queda vacia: es una instalacion nueva y la
    // interfaz muestra la bienvenida en lugar de inventar una carpeta.
    let root = get_setting(&conn, "library_root")?.unwrap_or_default();
    drop(conn);

    // Antes de tocar nada se comprueba que la carpeta guardada siga estando y
    // siga siendo escribible. Un disco externo desconectado, una carpeta movida
    // o el Acceso controlado a carpetas de Windows tienen que dar un mensaje
    // claro, no una biblioteca vacia sin explicacion.
    let mut root_issue = if root.is_empty() {
        None
    } else {
        validate_library_root_usable(Path::new(&root)).err()
    };
    let root_usable = !root.is_empty() && root_issue.is_none();

    if root_usable {
        allow_library_access(&app, Path::new(&root))?;
        // Si las copias de Preferences estan ilegibles (antivirus, OneDrive
        // sincronizando, archivo bloqueado) se sigue con la base local en vez
        // de dejar la aplicacion sin abrir.
        if let Err(error) = apply_portable_preferences_authority(&app, Path::new(&root)) {
            root_issue = Some(format!(
                "No se pudieron leer las preferencias guardadas dentro de la biblioteca, así que \
                 la aplicación abrió con la última configuración de esta PC.\n\n\
                 Si tenés un antivirus o OneDrive sincronizando esa carpeta, esperá un momento y \
                 volvé a abrir la aplicación.\n\n{error}"
            ));
        }
    }

    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let layout_needs_rescan =
        get_setting(&conn, "content_layout_version")?.as_deref() != Some(CONTENT_LAYOUT_VERSION);
    let should_scan = root_usable && (active_design_count(&conn)? == 0 || layout_needs_rescan);

    if !root_usable {
        conn.execute("UPDATE designs SET missing = 1", [])
            .map_err(to_string)?;
        conn.execute("UPDATE files SET missing = 1", [])
            .map_err(to_string)?;
    }
    drop(conn);

    let mut response = if should_scan {
        scan_library_impl(&app, &root)?
    } else {
        let conn = open_database(&app)?;
        ensure_database(&conn)?;
        load_library_from_db(&conn, &root)?
    };
    response.root_issue = root_issue;
    Ok(response)
}

/// Revisa una carpeta antes de adoptarla como biblioteca: devuelve error si no
/// sirve y, si sirve, la lista de avisos que conviene mostrarle al usuario.
///
/// Deja la carpeta autorizada aunque el usuario todavia no haya confirmado. Sin
/// eso la pantalla no puede probar el vigilante antes de escanear, y el permiso
/// se reconstruye igual en cada arranque desde la ruta guardada.
#[tauri::command]
fn check_library_folder(app: AppHandle, path: String) -> Result<FolderCheck, String> {
    let root = PathBuf::from(&path);
    validate_library_root_access(&root)?;
    allow_library_access(&app, &root)?;
    Ok(FolderCheck {
        warnings: library_root_warnings(&root),
        path,
    })
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
async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(list_system_fonts_impl)
        .await
        .map_err(to_string)?
}

#[tauri::command]
fn get_references(app: AppHandle, root_path: String) -> Result<ReferencesResponse, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(format!(
            "La carpeta de la biblioteca no existe: {root_path}"
        ));
    }
    let references_path = root.join(REFERENCES_DIR_NAME);
    fs::create_dir_all(&references_path)
        .map_err(|error| format!("No se pudo preparar la carpeta Referencias: {error}"))?;
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    purge_reference_cache_rows(&conn, &root_path)?;
    load_references_response_from_db(&conn, &root_path)
}

#[tauri::command]
fn scan_references(app: AppHandle, root_path: String) -> Result<ReferencesResponse, String> {
    scan_references_impl(&app, &root_path)
}

#[tauri::command]
async fn rescan_reference_paths(
    app: AppHandle,
    root_path: String,
    paths: Vec<String>,
) -> Result<ReferencesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rescan_reference_paths_impl(&app, &root_path, &paths)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
async fn detect_reference_changes(
    app: AppHandle,
    root_path: String,
) -> Result<Option<ReferencesResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_reference_changes_impl(&app, &root_path))
        .await
        .map_err(to_string)?
}

#[tauri::command]
fn create_reference_category(root_path: String, name: String) -> Result<String, String> {
    let folder_name = safe_folder_name(&name)?;
    let root = PathBuf::from(&root_path);
    let references_path = root.join(REFERENCES_DIR_NAME);
    fs::create_dir_all(&references_path)
        .map_err(|error| describe_root_failure(&root, "preparar la carpeta Referencias", &error))?;
    let category_path = references_path.join(&folder_name);
    if category_path.exists() {
        return Err("Ya existe una carpeta de referencias con ese nombre".to_string());
    }
    fs::create_dir(&category_path).map_err(|error| {
        describe_root_failure(
            &references_path,
            &format!("crear la carpeta de referencias {folder_name}"),
            &error,
        )
    })?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
    Ok(())
}

#[tauri::command]
fn send_reference_to_work(
    app: AppHandle,
    root_path: String,
    reference_id: String,
    work_name: String,
) -> Result<ReferenceItem, String> {
    let reference = send_reference_to_work_impl(&app, &root_path, &reference_id, &work_name)?;
    sync_portable_preferences(&app)?;
    Ok(reference)
}

#[tauri::command]
fn get_library_from_db(app: AppHandle) -> Result<LibraryResponse, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let root =
        get_setting(&conn, "library_root")?.unwrap_or_default();
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
    let root = PathBuf::from(&root_path);
    validate_library_root_access(&root)?;
    apply_portable_preferences_authority(&app, &root)?;
    scan_library_impl(&app, &root_path)
}

#[tauri::command]
fn reload_preferences_if_unusable(
    app: AppHandle,
    root_path: String,
) -> Result<Option<LibraryResponse>, String> {
    let root = PathBuf::from(&root_path);
    let current = portable_preferences_path(&root);
    if !root.is_dir() || (current.is_file() && validate_backup_database(&current).is_ok()) {
        return Ok(None);
    }

    apply_portable_preferences_authority(&app, &root)?;
    scan_library_impl(&app, &root_path).map(Some)
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
async fn detect_library_changes(
    app: AppHandle,
    root_path: String,
) -> Result<Option<LibraryResponse>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_library_changes_impl(&app, &root_path))
        .await
        .map_err(to_string)?
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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

    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
    Ok(())
}

#[tauri::command]
fn save_sidebar_layout(
    app: AppHandle,
    nodes: Vec<SidebarNodeInput>,
) -> Result<Vec<SidebarNode>, String> {
    let mut conn = open_database(&app)?;
    ensure_database(&conn)?;
    let sidebar = write_sidebar_layout(&mut conn, &nodes)?;
    drop(conn);
    sync_portable_preferences(&app)?;
    Ok(sidebar)
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    drop(conn);
    sync_portable_preferences(&app)?;
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
    refresh_portable_preferences(&app)?;
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
        get_setting(&conn, "library_root")?.unwrap_or_default();
    let response = load_library_from_db(&conn, &root)?;
    drop(conn);
    if Path::new(&root).is_dir() {
        sync_portable_preferences_for_root(&app, Path::new(&root))?;
    }
    Ok(response)
}

fn scan_references_impl(app: &AppHandle, root_path: &str) -> Result<ReferencesResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(format!(
            "La carpeta de la biblioteca no existe: {root_path}"
        ));
    }

    let references_path = root.join(REFERENCES_DIR_NAME);
    fs::create_dir_all(&references_path)
        .map_err(|error| format!("No se pudo preparar la carpeta Referencias: {error}"))?;

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    conn.execute(
        "UPDATE reference_images SET missing = 1 WHERE root_path = ?1",
        params![root_path],
    )
    .map_err(to_string)?;

    for path in collect_reference_image_paths(&references_path)? {
        upsert_reference_image(app, &conn, root_path, &references_path, &path)?;
    }

    purge_reference_cache_rows(&conn, root_path)?;
    let response = load_references_response_from_db(&conn, root_path)?;
    drop(conn);
    refresh_portable_preferences_for_root(app, &root)?;
    Ok(response)
}

fn load_references_response_from_db(
    conn: &Connection,
    root_path: &str,
) -> Result<ReferencesResponse, String> {
    let root = PathBuf::from(root_path);
    let references_path = root.join(REFERENCES_DIR_NAME);
    Ok(ReferencesResponse {
        root_path: root_path.to_string(),
        references_path: path_to_string(&references_path),
        works_path: path_to_string(&root.join(WORKS_DIR_NAME)),
        references: load_references_from_db(conn, root_path)?,
        categories: reference_categories(&references_path)?,
    })
}

fn reference_categories(references_path: &Path) -> Result<Vec<String>, String> {
    if !references_path.is_dir() {
        return Ok(Vec::new());
    }
    let mut categories = BTreeSet::new();
    for entry in fs::read_dir(references_path)
        .map_err(|error| format!("No se pudo leer la carpeta Referencias: {error}"))?
    {
        let entry = entry.map_err(to_string)?;
        if entry.file_type().map_err(to_string)?.is_dir() && !is_portable_cache_path(&entry.path())
        {
            if let Some(name) = entry.file_name().to_str() {
                if !name.trim().is_empty() {
                    categories.insert(name.to_string());
                }
            }
        }
    }
    Ok(categories.into_iter().collect())
}

fn reference_category_for_path(references_path: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(references_path).map_err(to_string)?;
    if relative.components().count() > 1 {
        Ok(relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            .unwrap_or("Sin carpeta")
            .to_string())
    } else {
        Ok("Sin carpeta".to_string())
    }
}

fn upsert_reference_image(
    app: &AppHandle,
    conn: &Connection,
    root_path: &str,
    references_path: &Path,
    path: &Path,
) -> Result<(), String> {
    if is_portable_cache_path(path)
        || !path.is_file()
        || !PREVIEW_EXTENSIONS.contains(&extension_for(path).as_str())
    {
        return Ok(());
    }
    let metadata = fs::metadata(path).map_err(to_string)?;
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
    let id = stable_id(&format!("reference:{}", normalize_path_for_id(path)));
    let thumbnail_path = cached_thumbnail(app, Some(path), modified)?;
    let (width, height) = match image::image_dimensions(path) {
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
            path_to_string(path),
            path_to_string(path.parent().unwrap_or(references_path)),
            reference_category_for_path(references_path, path)?,
            thumbnail_path.as_ref().map(|value| path_to_string(value)),
            metadata.len() as i64,
            modified,
            now,
            width,
            height,
        ],
    )
    .map_err(to_string)?;
    Ok(())
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

fn rescan_reference_paths_impl(
    app: &AppHandle,
    root_path: &str,
    paths: &[String],
) -> Result<ReferencesResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(format!(
            "La carpeta de la biblioteca no existe: {root_path}"
        ));
    }
    let references_path = root.join(REFERENCES_DIR_NAME);
    fs::create_dir_all(&references_path)
        .map_err(|error| format!("No se pudo preparar la carpeta Referencias: {error}"))?;

    let mut scopes = BTreeMap::<String, PathBuf>::new();
    for value in paths {
        let path = PathBuf::from(value);
        if is_portable_cache_path(&path) || !is_same_or_descendant_path(&path, &references_path) {
            continue;
        }
        if same_path(&path, &references_path) {
            return scan_references_impl(app, root_path);
        }
        scopes.insert(normalize_path_for_id(&path), path);
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    if scopes.is_empty() {
        return load_references_response_from_db(&conn, root_path);
    }

    mark_reference_scopes_missing(&conn, root_path, scopes.values())?;
    let mut image_paths = BTreeMap::<String, PathBuf>::new();
    for scope in scopes.values() {
        if scope.is_dir() {
            for path in collect_reference_image_paths(scope)? {
                image_paths.insert(normalize_path_for_id(&path), path);
            }
        } else if scope.is_file() && PREVIEW_EXTENSIONS.contains(&extension_for(scope).as_str()) {
            image_paths.insert(normalize_path_for_id(scope), scope.clone());
        }
    }
    for path in image_paths.values() {
        upsert_reference_image(app, &conn, root_path, &references_path, path)?;
    }

    purge_reference_cache_rows(&conn, root_path)?;
    let response = load_references_response_from_db(&conn, root_path)?;
    drop(conn);
    refresh_portable_preferences_for_root(app, &root)?;
    Ok(response)
}

fn mark_reference_scopes_missing<'a>(
    conn: &Connection,
    root_path: &str,
    scopes: impl Iterator<Item = &'a PathBuf>,
) -> Result<usize, String> {
    let scopes = scopes.collect::<Vec<_>>();
    let exact_scopes = scopes
        .iter()
        .map(|scope| normalize_path_for_id(scope))
        .collect::<BTreeSet<_>>();
    let descendant_scopes = scopes
        .iter()
        .filter(|scope| {
            scope.is_dir() || !PREVIEW_EXTENSIONS.contains(&extension_for(scope).as_str())
        })
        .map(|scope| format!("{}/", normalize_path_for_id(scope)))
        .collect::<Vec<_>>();
    let mut stmt = conn
        .prepare("SELECT id, path FROM reference_images WHERE root_path = ?1 AND missing = 0")
        .map_err(to_string)?;
    let rows = stmt
        .query_map(params![root_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    drop(stmt);

    let ids = rows
        .into_iter()
        .filter_map(|(id, path)| {
            let normalized = normalize_path_for_id(Path::new(&path));
            (exact_scopes.contains(&normalized)
                || descendant_scopes
                    .iter()
                    .any(|scope| normalized.starts_with(scope)))
            .then_some(id)
        })
        .collect::<Vec<_>>();
    for id in &ids {
        conn.execute(
            "UPDATE reference_images SET missing = 1 WHERE id = ?1",
            params![id],
        )
        .map_err(to_string)?;
    }
    Ok(ids.len())
}

fn detect_reference_changes_impl(
    app: &AppHandle,
    root_path: &str,
) -> Result<Option<ReferencesResponse>, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Ok(None);
    }
    let references_path = root.join(REFERENCES_DIR_NAME);
    if !references_path.is_dir() {
        return Ok(None);
    }
    let conn = open_database(app)?;
    ensure_database(&conn)?;
    let changed_paths = changed_reference_paths(&conn, root_path, &references_path)?;
    drop(conn);
    if changed_paths.is_empty() {
        return Ok(None);
    }
    rescan_reference_paths_impl(app, root_path, &changed_paths).map(Some)
}

fn changed_reference_paths(
    conn: &Connection,
    root_path: &str,
    references_path: &Path,
) -> Result<Vec<String>, String> {
    let mut indexed = BTreeMap::<String, (String, u64, i64)>::new();
    let mut stmt = conn
        .prepare(
            "SELECT path, size, modified
             FROM reference_images
             WHERE root_path = ?1 AND missing = 0",
        )
        .map_err(to_string)?;
    let rows = stmt
        .query_map(params![root_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(to_string)?;
    for row in rows {
        let (path, size, modified) = row.map_err(to_string)?;
        indexed.insert(
            normalize_path_for_id(Path::new(&path)),
            (path, size, modified),
        );
    }
    drop(stmt);

    let mut changed = BTreeSet::new();
    for path in collect_reference_image_paths(references_path)? {
        let previous = indexed.remove(&normalize_path_for_id(&path));
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(system_time_to_i64)
            .unwrap_or(0);
        if previous.as_ref().is_none_or(|(_, size, stored_modified)| {
            *size != metadata.len() || *stored_modified != modified
        }) {
            changed.insert(path_to_string(&path));
        }
    }
    for (_, (path, _, _)) in indexed {
        changed.insert(path);
    }
    Ok(changed.into_iter().collect())
}

fn is_same_or_descendant_path(path: &Path, ancestor: &Path) -> bool {
    let path = normalize_path_for_id(path);
    let ancestor = normalize_path_for_id(ancestor);
    path == ancestor || path.starts_with(&format!("{ancestor}/"))
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
    let works_path = root.join(WORKS_DIR_NAME);
    let work_path = works_path.join(&folder_name);
    fs::create_dir_all(&work_path).map_err(|error| {
        describe_root_failure(
            &works_path,
            &format!("crear la carpeta del trabajo {folder_name}"),
            &error,
        )
    })?;
    let destination = work_path.join(file_name);
    if !destination.exists() {
        fs::copy(source, &destination).map_err(|error| {
            describe_root_failure(
                &work_path,
                &format!("copiar la referencia {file_name} al trabajo"),
                &error,
            )
        })?;
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

/// Autoriza exclusivamente la biblioteca elegida para mostrar imagenes y
/// observar cambios. El permiso se reconstruye desde la ruta guardada en cada
/// inicio: una instalacion nueva no contiene rutas de ningun usuario.
fn allow_library_access(app: &AppHandle, root: &Path) -> Result<(), String> {
    let asset_scope = app.asset_protocol_scope();
    asset_scope
        .allow_directory(root, true)
        .map_err(|error| format!("No se pudo autorizar la vista de la biblioteca: {error}"))?;

    let fs_scope = app.fs_scope();
    fs_scope
        .allow_directory(root, true)
        .map_err(|error| format!("No se pudo autorizar el vigilante de la biblioteca: {error}"))?;
    Ok(())
}

// Codigos de error de Windows que conviene traducir a una instruccion concreta.
// El usuario de esta aplicacion no lee numeros de error: necesita saber que
// boton tocar para desbloquear su carpeta.
const WIN_ERROR_ACCESS_DENIED: i32 = 5;
const WIN_ERROR_WRITE_PROTECT: i32 = 19;
const WIN_ERROR_NOT_READY: i32 = 21;
const WIN_ERROR_SHARING_VIOLATION: i32 = 32;
const WIN_ERROR_DISK_FULL: i32 = 112;
const WIN_ERROR_PATH_TOO_LONG: i32 = 206;

/// Longitud a partir de la cual una ruta empieza a acercarse al limite de
/// Windows. La cache agrega `\_roxwana-cache\thumbnails\<64 caracteres>.webp`
/// al lado de cada imagen, asi que la carpeta elegida tiene que dejar margen.
const ROOT_PATH_LENGTH_WARNING: usize = 120;

/// Compara rutas como lo hace Windows: sin distinguir mayusculas, con las dos
/// barras equivalentes y sin la barra final. `normalize_path_for_id` no sirve
/// aca porque deja `C:\` como `c:/` y ninguna subcarpeta parece descender de el.
fn comparable_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let trimmed = text.trim_end_matches('\\');
    if trimmed.is_empty() {
        text
    } else {
        trimmed.to_string()
    }
}

fn path_is_inside(path: &Path, ancestor: &Path) -> bool {
    let path = comparable_path(path);
    let ancestor = comparable_path(ancestor);
    if ancestor.is_empty() {
        return false;
    }
    path == ancestor || path.starts_with(&format!("{ancestor}\\"))
}

fn env_directory(variable: &str) -> Option<PathBuf> {
    let value = std::env::var_os(variable)?;
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Carpetas del sistema que nunca pueden ser una biblioteca. Elegir una de
/// estas haria que el escaneo recorriera decenas de miles de archivos ajenos y
/// que la aplicacion escribiera carpetas `_roxwana-cache` dentro de Windows o
/// del perfil completo del usuario.
fn protected_root_reason(root: &Path) -> Option<String> {
    if let Some(system_drive) = env_directory("SystemDrive") {
        if comparable_path(root) == comparable_path(&system_drive) {
            return Some(format!(
                "Elegiste {} entero, que es el disco donde esta instalado Windows.\n\n\
                 Creá una carpeta propia y elegí esa, por ejemplo {}\\ROXWANA.",
                system_drive.display(),
                system_drive.display()
            ));
        }
    }

    let system_directories = [
        ("Windows", env_directory("SystemRoot")),
        ("Archivos de programa", env_directory("ProgramFiles")),
        (
            "Archivos de programa (x86)",
            env_directory("ProgramFiles(x86)"),
        ),
        ("ProgramData", env_directory("ProgramData")),
        (
            "los datos internos de los programas",
            env_directory("LOCALAPPDATA"),
        ),
        (
            "los datos internos de los programas",
            env_directory("APPDATA"),
        ),
    ];
    for (label, directory) in system_directories {
        let Some(directory) = directory else { continue };
        if path_is_inside(root, &directory) {
            return Some(format!(
                "Esa carpeta pertenece a {label} ({}).\n\n\
                 Windows la protege y borra su contenido al actualizar o desinstalar programas. \
                 Elegí una carpeta tuya, por ejemplo Documentos\\ROXWANA.",
                directory.display()
            ));
        }
    }

    if let Some(profile) = env_directory("USERPROFILE") {
        if comparable_path(root) == comparable_path(&profile) {
            return Some(format!(
                "Elegiste tu carpeta de usuario completa ({}).\n\n\
                 Ahí adentro está todo lo que Windows guarda de vos, y la biblioteca tendría que recorrer \
                 decenas de miles de archivos. Elegí una carpeta puntual, por ejemplo \
                 Documentos\\ROXWANA.",
                profile.display()
            ));
        }
        if let Some(users) = profile.parent() {
            if comparable_path(root) == comparable_path(users) {
                return Some(format!(
                    "Elegiste {}, que contiene las carpetas de todos los usuarios de esta PC.\n\n\
                     Elegí una carpeta tuya, por ejemplo Documentos\\ROXWANA.",
                    users.display()
                ));
            }
        }
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(install_dir) = executable.parent() {
            if path_is_inside(root, install_dir) {
                return Some(format!(
                    "Esa carpeta es donde está instalada la aplicación ({}).\n\n\
                     Al actualizar ROXWANA se reemplaza su contenido y perderías las imágenes. \
                     Elegí una carpeta aparte.",
                    install_dir.display()
                ));
            }
        }
    }

    None
}

/// Traduce el fallo real de Windows a una instruccion que el usuario pueda
/// seguir sin ayuda.
fn describe_root_failure(root: &Path, action: &str, error: &std::io::Error) -> String {
    let advice = match error.raw_os_error() {
        Some(WIN_ERROR_ACCESS_DENIED) => {
            "Windows bloqueó el acceso a esa carpeta.\n\n\
             • Si está en Documentos, Escritorio o Imágenes: abrí Seguridad de Windows → \
               Protección contra ransomware → Acceso controlado a carpetas, y permití \
               \"ROXWANA Biblioteca Visual\".\n\
             • Si es una carpeta de otro usuario o de red: pedí permiso de escritura.\n\
             • O elegí otra carpeta tuya, por ejemplo Documentos\\ROXWANA."
        }
        Some(WIN_ERROR_WRITE_PROTECT) => {
            "La unidad está protegida contra escritura.\n\n\
             Si es un pendrive, fijate la pestañita de bloqueo al costado. Si es un disco externo, \
             revisá que no esté conectado como solo lectura."
        }
        Some(WIN_ERROR_NOT_READY) => {
            "La unidad no responde.\n\n\
             Conectá el disco externo o el pendrive donde está la biblioteca y volvé a intentar."
        }
        Some(WIN_ERROR_DISK_FULL) => {
            "No queda espacio libre en esa unidad.\n\n\
             La aplicación necesita lugar para guardar las miniaturas. Liberá espacio o elegí otro disco."
        }
        Some(WIN_ERROR_PATH_TOO_LONG) => {
            "La ruta es demasiado larga para Windows.\n\n\
             Mové la biblioteca más cerca de la raíz del disco, por ejemplo D:\\ROXWANA."
        }
        Some(WIN_ERROR_SHARING_VIOLATION) => {
            "Otro programa está usando esa carpeta.\n\n\
             Cerrá el Explorador de archivos, el antivirus o el programa que la tenga abierta y volvé a intentar."
        }
        _ => {
            "La aplicación necesita poder leer y guardar dentro de la carpeta que elijas: ahí van \
             las miniaturas y tus preferencias.\n\n\
             Elegí una carpeta donde puedas crear archivos, por ejemplo Documentos\\ROXWANA."
        }
    };
    format!(
        "{advice}\n\nNo se pudo {action}.\nCarpeta: {}\nDetalle de Windows: {error}",
        root.display()
    )
}

/// Comprobacion completa para adoptar una carpeta nueva: ademas de los
/// permisos, rechaza las carpetas del sistema.
fn validate_library_root_access(root: &Path) -> Result<(), String> {
    if root.is_dir() {
        if let Some(reason) = protected_root_reason(root) {
            return Err(reason);
        }
    }
    validate_library_root_usable(root)
}

/// Comprueba los permisos reales de Windows sobre una carpeta. Los archivos
/// temporales se eliminan inmediatamente y nunca reemplazan contenido del
/// usuario. Se usa tambien al arrancar sobre la biblioteca ya guardada, por eso
/// no repite el rechazo de carpetas del sistema: una biblioteca que ya venia
/// funcionando no se le quita al usuario de un dia para el otro.
fn validate_library_root_usable(root: &Path) -> Result<(), String> {
    if root.as_os_str().is_empty() {
        return Err("No se eligió ninguna carpeta.".to_string());
    }
    if !root.is_dir() {
        return Err(format!(
            "La carpeta elegida no existe o ya no está disponible.\n\n\
             Si la biblioteca vive en un disco externo o un pendrive, conectalo y volvé a intentar. \
             Si le cambiaste el nombre o la moviste, elegila de nuevo.\n\nCarpeta: {}",
            root.display()
        ));
    }
    fs::read_dir(root)
        .map_err(|error| describe_root_failure(root, "leer la carpeta elegida", &error))?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let stamp = format!("{}-{nonce}", std::process::id());

    // Primera prueba: crear un archivo suelto, como la copia de Preferences.
    let probe = root.join(format!(".roxwana-permission-check-{stamp}.tmp"));
    let probe_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| describe_root_failure(root, "guardar un archivo de prueba", &error))?;
    drop(probe_file);
    let file_cleanup = fs::remove_file(&probe);

    // Segunda prueba: crear una subcarpeta con un archivo adentro, que es lo
    // que hace la cache `_roxwana-cache` al lado de cada imagen. El Acceso
    // controlado a carpetas de Windows puede permitir una cosa y bloquear la otra.
    let probe_dir = root.join(format!(".roxwana-permission-check-{stamp}"));
    let nested_result = fs::create_dir_all(&probe_dir).and_then(|()| {
        let nested = probe_dir.join("prueba.tmp");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&nested)
            .map(drop)
            .and_then(|()| fs::remove_file(&nested))
    });
    let _ = fs::remove_dir_all(&probe_dir);
    nested_result
        .map_err(|error| describe_root_failure(root, "crear una subcarpeta de prueba", &error))?;

    file_cleanup
        .map_err(|error| describe_root_failure(root, "borrar el archivo de prueba", &error))?;
    Ok(())
}

/// Avisos que no impiden usar la carpeta pero que explican de antemano por que
/// la aplicacion podria comportarse distinto en esa ubicacion.
fn library_root_warnings(root: &Path) -> Vec<String> {
    let mut warnings = Vec::new();
    let text = root.to_string_lossy().to_string();

    if text.starts_with("\\\\") || text.starts_with("//") {
        warnings.push(
            "La carpeta está en la red, no en esta PC. Si la red se corta, las imágenes dejan de \
             verse y el aviso automático de cambios puede no funcionar. Anda mucho mejor con la \
             biblioteca en un disco de la máquina."
                .to_string(),
        );
    }

    let in_onedrive = root
        .components()
        .any(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .to_lowercase()
                .starts_with("onedrive")
        })
        || ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]
            .iter()
            .filter_map(|variable| env_directory(variable))
            .any(|directory| path_is_inside(root, &directory));
    if in_onedrive {
        warnings.push(
            "La carpeta está dentro de OneDrive. Si las imágenes están \"solo en línea\", la \
             aplicación las va a descargar al generar las miniaturas y el primer escaneo va a \
             tardar mucho más. Conviene hacer clic derecho en la carpeta y elegir \"Conservar \
             siempre en este dispositivo\"."
                .to_string(),
        );
    }

    if text.chars().count() > ROOT_PATH_LENGTH_WARNING {
        warnings.push(format!(
            "La ruta de la carpeta es muy larga ({} caracteres). Windows tiene un límite y las \
             miniaturas se guardan en subcarpetas dentro de la biblioteca. Si algo falla, mové la \
             biblioteca más cerca de la raíz del disco, por ejemplo D:\\ROXWANA.",
            text.chars().count()
        ));
    }

    if root.parent().is_none() {
        warnings.push(
            "Elegiste una unidad entera. La aplicación va a crear sus carpetas de trabajo \
             directamente en la raíz del disco y va a recorrer todo lo que haya adentro. Si el \
             disco tiene otras cosas, conviene elegir una carpeta puntual."
                .to_string(),
        );
    }

    warnings
}

/// Deja creadas las carpetas de trabajo dentro de la biblioteca elegida para
/// que el usuario sepa donde va cada cosa. Nunca toca lo que ya existe.
fn ensure_starter_directories(root: &Path) -> Result<(), String> {
    for name in STARTER_DIR_NAMES {
        let directory = root.join(name);
        if directory.is_dir() {
            continue;
        }
        fs::create_dir_all(&directory).map_err(|error| {
            describe_root_failure(root, &format!("crear la carpeta {name}"), &error)
        })?;
        // Windows puede aceptar la orden y no dejar la carpeta: el Acceso
        // controlado a carpetas, un antivirus o una unidad de red que se corta
        // devuelven exito y despues revierten. Comprobarlo aca evita descubrirlo
        // mas tarde con la biblioteca a medio armar.
        if !directory.is_dir() {
            return Err(format!(
                "Windows aceptó crear la carpeta {name} pero después no quedó en el disco.\n\n\
                 Suele pasar cuando un antivirus o el Acceso controlado a carpetas de Windows \
                 revierten lo que escribe la aplicación, o cuando la unidad se desconectó en el \
                 medio.\n\n\
                 Permití \"ROXWANA Biblioteca Visual\" en Seguridad de Windows, o elegí otra \
                 carpeta.\n\nCarpeta: {}",
                directory.display()
            ));
        }
    }
    Ok(())
}

fn scan_library_impl(app: &AppHandle, root_path: &str) -> Result<LibraryResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(format!(
            "La carpeta no existe o no esta disponible: {root_path}"
        ));
    }

    allow_library_access(app, &root)?;
    ensure_starter_directories(&root)?;

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
    let response = load_library_from_db(&conn, root_path)?;
    drop(conn);
    refresh_portable_preferences_for_root(app, &root)?;
    Ok(response)
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
    let response = load_library_from_db(&conn, root_path)?;
    drop(conn);
    refresh_portable_preferences_for_root(app, &root)?;
    Ok(response)
}

fn detect_library_changes_impl(
    app: &AppHandle,
    root_path: &str,
) -> Result<Option<LibraryResponse>, String> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Ok(None);
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    let changed_paths = changed_library_paths(&conn, &root)?;
    drop(conn);
    if changed_paths.is_empty() {
        return Ok(None);
    }

    rescan_paths_impl(app, root_path, &changed_paths).map(Some)
}

fn changed_library_paths(conn: &Connection, root: &Path) -> Result<Vec<String>, String> {
    let mut indexed = BTreeMap::<String, (String, u64, i64)>::new();
    let mut stmt = conn
        .prepare("SELECT path, size, modified FROM files WHERE missing = 0")
        .map_err(to_string)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(to_string)?;
    for row in rows {
        let (path, size, modified) = row.map_err(to_string)?;
        indexed.insert(
            normalize_path_for_id(Path::new(&path)),
            (path, size, modified),
        );
    }
    drop(stmt);

    let mut changed = BTreeSet::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !is_portable_cache_path(entry.path())
                && !is_reference_library_path(root, entry.path())
                && !is_preferences_library_path(root, entry.path())
        })
    {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if !is_supported_extension(&extension_for(path)) {
            continue;
        }
        let previous = indexed.remove(&normalize_path_for_id(path));
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(system_time_to_i64)
            .unwrap_or(0);
        if previous.as_ref().is_none_or(|(_, size, stored_modified)| {
            *size != metadata.len() || *stored_modified != modified
        }) {
            changed.insert(path_to_string(path));
        }
    }

    for (_, (path, _, _)) in indexed {
        changed.insert(path);
    }
    Ok(changed.into_iter().collect())
}

fn load_library_from_db(conn: &Connection, root_path: &str) -> Result<LibraryResponse, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, directory, group_type, preview_path, preview_cache_path,
                    thumbnail_path, total_files, updated_at, auto_category,
                    favorite, status, category, category_user_set
             FROM designs
             WHERE missing = 0
             ORDER BY name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let mut designs = stmt
        .query_map([], |row| {
            Ok(Design {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                directory: row.get(3)?,
                group_type: row.get(4)?,
                preview_path: row.get(5)?,
                preview_cache_path: row.get(6)?,
                thumbnail_path: row.get(7)?,
                total_files: row.get::<_, i64>(8)? as usize,
                updated_at: row.get(9)?,
                counts: SupportCounts::default(),
                files: Vec::new(),
                classification: Classification {
                    favorite: row.get::<_, i64>(11)? != 0,
                    status: row.get(12)?,
                    category: row.get(13)?,
                    tags: Vec::new(),
                    category_user_set: row.get::<_, i64>(14)? != 0,
                },
                auto_category: row.get(10)?,
                auto_tags: Vec::new(),
            })
        })
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    drop(stmt);

    let design_indexes = designs
        .iter()
        .enumerate()
        .map(|(index, design)| (design.id.clone(), index))
        .collect::<BTreeMap<_, _>>();

    let mut counts_stmt = conn
        .prepare(
            "SELECT files.design_id, files.extension, COUNT(*)
             FROM files
             INNER JOIN designs ON designs.id = files.design_id
             WHERE files.missing = 0 AND designs.missing = 0
             GROUP BY files.design_id, files.extension",
        )
        .map_err(to_string)?;
    let count_rows = counts_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? as usize,
            ))
        })
        .map_err(to_string)?;
    for row in count_rows {
        let (design_id, extension, count) = row.map_err(to_string)?;
        let Some(index) = design_indexes.get(&design_id) else {
            continue;
        };
        let counts = &mut designs[*index].counts;
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
    drop(counts_stmt);

    let mut tags_stmt = conn
        .prepare(
            "SELECT design_tags.design_id, tags.name, design_tags.source
             FROM design_tags
             INNER JOIN tags ON tags.id = design_tags.tag_id
             INNER JOIN designs ON designs.id = design_tags.design_id
             WHERE designs.missing = 0
             ORDER BY tags.name COLLATE NOCASE",
        )
        .map_err(to_string)?;
    let tag_rows = tags_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(to_string)?;
    for row in tag_rows {
        let (design_id, tag, source) = row.map_err(to_string)?;
        let Some(index) = design_indexes.get(&design_id) else {
            continue;
        };
        designs[*index].classification.tags.push(tag.clone());
        if source == "auto" {
            designs[*index].auto_tags.push(tag);
        }
    }
    drop(tags_stmt);

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
        root_issue: None,
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
        || first_name.eq_ignore_ascii_case(MISC_DIR_NAME)
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


/// Devuelve las familias tipograficas instaladas en Windows leyendo la tabla
/// `name` de cada archivo de fuente. WebView2 resuelve `font-family` contra
/// estos mismos nombres, asi que lo que aparece en la lista es exactamente lo
/// que la interfaz puede dibujar.
fn list_system_fonts_impl() -> Result<Vec<String>, String> {
    let mut families: BTreeMap<String, String> = BTreeMap::new();

    for directory in system_font_directories() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_font_file(&path) {
                continue;
            }
            for family in read_font_families(&path) {
                families
                    .entry(family.to_lowercase())
                    .or_insert(family);
            }
        }
    }

    if families.is_empty() {
        return Err("No se pudo leer ninguna fuente instalada en el equipo".to_string());
    }

    Ok(families.into_values().collect())
}

fn system_font_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    match std::env::var("WINDIR") {
        Ok(windows) if !windows.trim().is_empty() => {
            directories.push(PathBuf::from(windows).join("Fonts"))
        }
        _ => directories.push(PathBuf::from(r"C:\Windows\Fonts")),
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            directories.push(PathBuf::from(local).join(r"Microsoft\Windows\Fonts"));
        }
    }
    directories
}

fn is_font_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "ttf" | "otf" | "ttc" | "otc"
            )
        })
        .unwrap_or(false)
}

/// Un `.ttc` guarda varias fuentes en el mismo archivo, por eso devolvemos una
/// lista y no un unico nombre.
fn read_font_families(path: &Path) -> Vec<String> {
    use std::io::Read;

    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };

    let mut header = [0u8; 12];
    if file.read_exact(&mut header).is_err() {
        return Vec::new();
    }

    if &header[0..4] == b"ttcf" {
        let count = read_u32(&header[8..12]) as usize;
        if count == 0 || count > 128 {
            return Vec::new();
        }
        let mut offsets = vec![0u8; count * 4];
        if file.read_exact(&mut offsets).is_err() {
            return Vec::new();
        }
        return offsets
            .chunks_exact(4)
            .filter_map(|chunk| read_font_family_at(&mut file, u64::from(read_u32(chunk))))
            .collect();
    }

    read_font_family_at(&mut file, 0)
        .map(|family| vec![family])
        .unwrap_or_default()
}

fn read_font_family_at(file: &mut fs::File, sfnt_offset: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    file.seek(SeekFrom::Start(sfnt_offset)).ok()?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header).ok()?;

    let table_count = usize::from(read_u16(&header[4..6]));
    if table_count == 0 || table_count > 512 {
        return None;
    }

    let mut directory = vec![0u8; table_count * 16];
    file.read_exact(&mut directory).ok()?;

    let record = directory
        .chunks_exact(16)
        .find(|record| &record[0..4] == b"name")?;
    let table_offset = u64::from(read_u32(&record[8..12]));
    let table_length = read_u32(&record[12..16]) as usize;
    if table_length < 6 || table_length > 8 * 1024 * 1024 {
        return None;
    }

    file.seek(SeekFrom::Start(table_offset)).ok()?;
    let mut table = vec![0u8; table_length];
    file.read_exact(&mut table).ok()?;

    parse_font_family_name(&table)
}

/// De la tabla `name` nos quedamos con el nombre de familia, prefiriendo la
/// familia tipografica (id 16) en ingles, que es la que usa CSS cuando la
/// fuente tiene mas de cuatro estilos.
fn parse_font_family_name(table: &[u8]) -> Option<String> {
    if table.len() < 6 {
        return None;
    }
    let record_count = usize::from(read_u16(&table[2..4]));
    let strings_offset = usize::from(read_u16(&table[4..6]));

    let mut best: Option<(u8, String)> = None;
    for index in 0..record_count {
        let start = 6 + index * 12;
        let end = start + 12;
        if end > table.len() {
            break;
        }
        let record = &table[start..end];
        let platform = read_u16(&record[0..2]);
        let language = read_u16(&record[4..6]);
        let name_id = read_u16(&record[6..8]);
        if name_id != 1 && name_id != 16 {
            continue;
        }

        let length = usize::from(read_u16(&record[8..10]));
        let offset = usize::from(read_u16(&record[10..12]));
        let text_start = strings_offset.checked_add(offset)?;
        let text_end = text_start.checked_add(length)?;
        if length == 0 || text_end > table.len() {
            continue;
        }

        let raw = &table[text_start..text_end];
        let text = if platform == 3 || platform == 0 {
            decode_utf16_be(raw)
        } else {
            raw.iter().map(|byte| char::from(*byte)).collect()
        };
        let Some(text) = sanitize_font_family(&text) else {
            continue;
        };

        let rank = match (name_id, language) {
            (16, 0x0409) => 0,
            (16, _) => 1,
            (1, 0x0409) => 2,
            _ => 3,
        };
        let replace = match &best {
            Some((current, _)) => rank < *current,
            None => true,
        };
        if replace {
            best = Some((rank, text));
        }
    }

    best.map(|(_, family)| family)
}

/// Descarta nombres inutilizables: vacios, demasiado largos, con caracteres de
/// control, o los alias verticales de Windows que empiezan con `@`.
fn sanitize_font_family(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('\u{0}').trim();
    if trimmed.is_empty() || trimmed.starts_with('@') || trimmed.chars().count() > 80 {
        return None;
    }
    if trimmed.chars().any(|character| character.is_control()) {
        return None;
    }
    Some(trimmed.to_string())
}

fn decode_utf16_be(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
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
static PORTABLE_PREFERENCES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn portable_preferences_path(root: &Path) -> PathBuf {
    root.join(PREFERENCES_DIR_NAME)
        .join(PORTABLE_PREFERENCES_FILE_NAME)
}

fn portable_preferences_paths(root: &Path) -> [PathBuf; 3] {
    let directory = root.join(PREFERENCES_DIR_NAME);
    [
        directory.join(PORTABLE_PREFERENCES_FILE_NAME),
        directory.join(PORTABLE_PREFERENCES_PREVIOUS_FILE_NAME),
        directory.join(PORTABLE_PREFERENCES_OLDER_FILE_NAME),
    ]
}

#[cfg(test)]
fn preferences_revision(conn: &Connection) -> Result<i64, String> {
    Ok(get_setting(conn, PORTABLE_PREFERENCES_REVISION_SETTING)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0))
}

fn apply_portable_preferences_authority(app: &AppHandle, root: &Path) -> Result<bool, String> {
    let sources = portable_preferences_paths(root);
    let _guard = PORTABLE_PREFERENCES_LOCK
        .lock()
        .map_err(|_| "No se pudo bloquear la copia portable de preferencias".to_string())?;
    replace_local_database_from_authority(&sources, &database_path(app)?)
        .map(|source| source.is_some())
}

/// Copia de rescate de la base local antes de reemplazarla o borrarla. Si el
/// usuario elige por error una carpeta equivocada, o si `Preferences` viaja
/// incompleta en un disco externo, su clasificacion no desaparece sin red.
/// Es best-effort a proposito: nunca puede impedir que la aplicacion abra.
fn keep_local_database_rescue_copy(db_path: &Path) {
    if !db_path.is_file() {
        return;
    }
    let Some(parent) = db_path.parent() else {
        return;
    };
    let rescue_dir = parent.join("copias-de-seguridad");
    if fs::create_dir_all(&rescue_dir).is_err() {
        return;
    }
    let target = rescue_dir.join(LOCAL_DATABASE_RESCUE_FILE_NAME);
    let _ = fs::remove_file(&target);
    // `VACUUM INTO` copia tambien lo que quedo en el WAL; copiar el archivo
    // suelto perderia los ultimos cambios del usuario.
    let Ok(conn) = Connection::open(db_path) else {
        return;
    };
    let _ = conn.execute("VACUUM INTO ?1", params![path_to_string(&target)]);
}

fn replace_local_database_from_authority(
    sources: &[PathBuf],
    db_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let mut invalid_sources = Vec::new();
    for source in sources {
        if !source.is_file() {
            continue;
        }
        if let Err(error) = validate_backup_database(source) {
            invalid_sources.push(format!("{} ({error})", source.display()));
            continue;
        }

        keep_local_database_rescue_copy(db_path);
        remove_database_files(db_path)?;
        fs::copy(source, db_path).map_err(|error| {
            format!("No se pudieron cargar las preferencias portables: {error}")
        })?;
        return Ok(Some(source.clone()));
    }

    if !invalid_sources.is_empty() {
        return Err(format!(
            "Las tres copias de Preferences estan danadas o no son validas: {}",
            invalid_sources.join("; ")
        ));
    }

    // Preferences es la fuente de verdad. Solo cuando no queda ninguna de las
    // tres versiones se descarta la configuracion local y se vuelve al inicio.
    // Antes de descartarla queda una copia de rescate en copias-de-seguridad.
    keep_local_database_rescue_copy(db_path);
    remove_database_files(db_path)?;
    let conn = Connection::open(db_path).map_err(to_string)?;
    ensure_database(&conn)?;
    drop(conn);
    Ok(None)
}

fn copy_valid_preference_snapshot(source: &Path, target: &Path) -> Result<bool, String> {
    if !source.is_file() || validate_backup_database(source).is_err() {
        return Ok(false);
    }

    let temporary = target.with_extension("sqlite.rotate.tmp");
    remove_file_if_exists(&temporary)?;
    fs::copy(source, &temporary)
        .map_err(|error| format!("No se pudo rotar el historial de Preferences: {error}"))?;
    validate_backup_database(&temporary)?;
    remove_file_if_exists(target)?;
    fs::rename(&temporary, target)
        .map_err(|error| format!("No se pudo completar el historial de Preferences: {error}"))?;
    Ok(true)
}

fn rotate_portable_preferences(paths: &[PathBuf; 3]) -> Result<(), String> {
    let [current, previous, older] = paths;
    copy_valid_preference_snapshot(previous, older)?;
    copy_valid_preference_snapshot(current, previous)?;
    Ok(())
}

fn ensure_portable_history_seeded(paths: &[PathBuf; 3]) -> Result<(), String> {
    let [current, previous, older] = paths;
    if !previous.is_file() || validate_backup_database(previous).is_err() {
        copy_valid_preference_snapshot(current, previous)?;
    }
    if !older.is_file() || validate_backup_database(older).is_err() {
        copy_valid_preference_snapshot(previous, older)?;
    }
    Ok(())
}

fn write_portable_preferences_for_root(
    app: &AppHandle,
    root: &Path,
    rotate_history: bool,
) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!(
            "No existe la carpeta de la biblioteca: {}",
            root.display()
        ));
    }

    let _guard = PORTABLE_PREFERENCES_LOCK
        .lock()
        .map_err(|_| "No se pudo bloquear la copia portable de preferencias".to_string())?;
    let paths = portable_preferences_paths(root);
    let target = &paths[0];
    let directory = target
        .parent()
        .ok_or_else(|| "La copia portable no tiene carpeta padre".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("No se pudo crear Preferences: {error}"))?;

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    save_setting(
        &conn,
        PORTABLE_PREFERENCES_REVISION_SETTING,
        &now_i64().to_string(),
    )?;
    drop(conn);
    if rotate_history {
        rotate_portable_preferences(&paths)?;
    }
    export_database_backup(app, target)?;
    ensure_portable_history_seeded(&paths)?;
    Ok(target.clone())
}

fn sync_portable_preferences_for_root(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    write_portable_preferences_for_root(app, root, true)
}

fn refresh_portable_preferences_for_root(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    write_portable_preferences_for_root(app, root, false)
}

fn sync_portable_preferences(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    write_portable_preferences(app, true)
}

fn refresh_portable_preferences(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    write_portable_preferences(app, false)
}

fn write_portable_preferences(
    app: &AppHandle,
    rotate_history: bool,
) -> Result<Option<PathBuf>, String> {
    let conn = open_database(app)?;
    ensure_database(&conn)?;
    let root = get_setting(&conn, "library_root")?;
    drop(conn);
    let Some(root) = root else {
        return Ok(None);
    };
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Ok(None);
    }
    write_portable_preferences_for_root(app, &root, rotate_history).map(Some)
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
                    && !is_preferences_library_path(&root, entry.path())
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
    name.eq_ignore_ascii_case(FREEPIK_DIR_NAME)
        || name.eq_ignore_ascii_case(LOOSE_DIR_NAME)
        || name.eq_ignore_ascii_case(MISC_DIR_NAME)
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

fn is_preferences_library_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative.components().next().is_some_and(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(PREFERENCES_DIR_NAME))
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
            // Las rutas portables son el caso normal. Reconocerlas por el texto
            // antes de tocar el disco evita miles de comprobaciones al iniciar.
            if is_portable_cache_path(&legacy) || !legacy.exists() {
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
        // Dos copias abiertas escribirian a la vez la misma base y las mismas
        // copias de Preferences, y podrian dejarlas a medio escribir. Si el
        // usuario vuelve a hacer doble clic en el icono, se trae al frente la
        // ventana que ya estaba abierta. Va primero: el resto de los plugins
        // solo tiene sentido en la unica instancia que sobrevive.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_initial_state,
            get_brand_logo,
            save_brand_logo,
            remove_brand_logo,
            list_system_fonts,
            get_references,
            scan_references,
            rescan_reference_paths,
            detect_reference_changes,
            create_reference_category,
            update_reference_favorite,
            update_reference_status,
            send_reference_to_work,
            get_library_from_db,
            get_design_detail,
            check_library_folder,
            scan_library,
            reload_preferences_if_unusable,
            rescan_paths,
            detect_library_changes,
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
    fn distributable_config_has_no_preselected_library_scope() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let fs_scope = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|permission| permission["identifier"] == "fs:scope")
            .unwrap();
        let fs_paths = fs_scope["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(fs_paths, ["$APPCACHE/**/*", "$APPLOCALDATA/**/*"]);

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let asset_paths = config["app"]["security"]["assetProtocol"]["scope"]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(asset_paths, ["$APPCACHE/**/*", "$APPLOCALDATA/**/*"]);
    }

    /// Arma una tabla `name` minima con los registros indicados
    /// (`platform`, `language`, `name_id`, texto) para probar el parseo.
    fn build_name_table(records: &[(u16, u16, u16, &str)]) -> Vec<u8> {
        let mut strings: Vec<u8> = Vec::new();
        let mut entries: Vec<u8> = Vec::new();
        for (platform, language, name_id, text) in records {
            let encoded: Vec<u8> = if *platform == 3 || *platform == 0 {
                text.encode_utf16().flat_map(|unit| unit.to_be_bytes()).collect()
            } else {
                text.bytes().collect()
            };
            entries.extend_from_slice(&platform.to_be_bytes());
            entries.extend_from_slice(&1u16.to_be_bytes());
            entries.extend_from_slice(&language.to_be_bytes());
            entries.extend_from_slice(&name_id.to_be_bytes());
            entries.extend_from_slice(&(encoded.len() as u16).to_be_bytes());
            entries.extend_from_slice(&(strings.len() as u16).to_be_bytes());
            strings.extend_from_slice(&encoded);
        }

        let strings_offset = (6 + entries.len()) as u16;
        let mut table = Vec::new();
        table.extend_from_slice(&0u16.to_be_bytes());
        table.extend_from_slice(&(records.len() as u16).to_be_bytes());
        table.extend_from_slice(&strings_offset.to_be_bytes());
        table.extend_from_slice(&entries);
        table.extend_from_slice(&strings);
        table
    }

    #[test]
    fn reads_the_english_family_name_from_a_font_name_table() {
        let table = build_name_table(&[
            (1, 0, 1, "Legacy Mac Name"),
            (3, 0x0409, 1, "Roxwana Display"),
        ]);
        assert_eq!(
            parse_font_family_name(&table).as_deref(),
            Some("Roxwana Display")
        );
    }

    #[test]
    fn prefers_the_typographic_family_over_the_basic_family() {
        let table = build_name_table(&[
            (3, 0x0409, 1, "Roxwana Display Semibold"),
            (3, 0x0409, 16, "Roxwana Display"),
        ]);
        assert_eq!(
            parse_font_family_name(&table).as_deref(),
            Some("Roxwana Display")
        );
    }

    /// Comprobacion contra las fuentes reales del equipo: si el lector se
    /// rompe, la lista queda vacia o pierde las fuentes que Windows siempre
    /// trae instaladas.
    #[cfg(windows)]
    #[test]
    /// En otra PC Windows puede estar en otra unidad y el perfil del usuario en
    /// otra carpeta. Las dos rutas se arman desde el entorno de la maquina, no
    /// desde rutas fijas, y hay que mirar las dos: las fuentes instaladas "solo
    /// para mi" viven en el perfil, no en la carpeta de Windows.
    #[test]
    fn looks_for_fonts_where_this_machine_keeps_them() {
        let directories = system_font_directories();
        assert!(!directories.is_empty());

        let windows_fonts = env_directory("WINDIR")
            .or_else(|| env_directory("SystemRoot"))
            .map(|windows| windows.join("Fonts"));
        if let Some(windows_fonts) = windows_fonts {
            assert!(
                directories
                    .iter()
                    .any(|directory| comparable_path(directory) == comparable_path(&windows_fonts)),
                "falta la carpeta de fuentes de Windows: {directories:?}"
            );
        }

        if let Some(local) = env_directory("LOCALAPPDATA") {
            let user_fonts = local.join("Microsoft").join("Windows").join("Fonts");
            assert!(
                directories
                    .iter()
                    .any(|directory| comparable_path(directory) == comparable_path(&user_fonts)),
                "falta la carpeta de fuentes del usuario: {directories:?}"
            );
        }
    }

    #[test]
    fn reads_the_fonts_actually_installed_on_this_machine() {
        let families = list_system_fonts_impl().expect("Windows deberia tener fuentes instaladas");
        assert!(families.len() > 20, "se leyeron muy pocas fuentes: {families:?}");
        for expected in ["Arial", "Segoe UI", "Times New Roman"] {
            assert!(
                families.iter().any(|family| family == expected),
                "falta la fuente {expected} en la lista leida"
            );
        }
        assert!(families.iter().all(|family| !family.starts_with('@')));
    }

    #[test]
    fn discards_vertical_aliases_and_empty_family_names() {
        assert_eq!(sanitize_font_family("@MS Gothic"), None);
        assert_eq!(sanitize_font_family("   "), None);
        assert_eq!(sanitize_font_family("Bad\u{7}Name"), None);
        assert_eq!(
            sanitize_font_family("  Segoe UI \u{0}").as_deref(),
            Some("Segoe UI")
        );
    }

    #[test]
    fn creates_the_starter_directories_in_an_empty_library() {
        let dir = tempdir().unwrap();
        validate_library_root_usable(dir.path()).unwrap();
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
        ensure_starter_directories(dir.path()).unwrap();
        for esperada in ["Categorías", "Trabajos", "Referencias", "Varios"] {
            assert!(
                dir.path().join(esperada).is_dir(),
                "falta la carpeta {esperada}"
            );
        }
        // Freepik es propia de la biblioteca original: no se crea de cero.
        assert!(!dir.path().join("Freepik").exists());
    }

    /// Prueba real contra Windows: se le quita el permiso de escritura a una
    /// carpeta con `icacls` y se comprueba que la aplicacion la rechaza con la
    /// explicacion correcta en vez de adoptarla y fallar despues.
    #[test]
    fn refuses_a_folder_where_windows_actually_denies_writing() {
        let dir = tempdir().unwrap();
        let blocked = dir.path().join("bloqueada");
        fs::create_dir(&blocked).unwrap();
        let blocked_text = path_to_string(&blocked);

        let Ok(user) = std::env::var("USERNAME") else {
            return;
        };
        if user.is_empty() {
            return;
        }

        let denied = Command::new("icacls")
            .args([&blocked_text, "/deny", &format!("{user}:(W)")])
            .output();
        let Ok(denied) = denied else {
            return; // Sin icacls disponible no se puede montar el escenario.
        };
        if !denied.status.success() {
            return;
        }

        let outcome = validate_library_root_usable(&blocked);

        // Devolver el permiso antes de comprobar nada: si el assert falla, la
        // carpeta temporal tiene que poder borrarse igual.
        let _ = Command::new("icacls")
            .args([&blocked_text, "/remove:d", &user])
            .output();

        let error = outcome.expect_err("una carpeta sin permiso de escritura no puede aceptarse");
        assert!(
            error.contains("Acceso controlado a carpetas"),
            "el mensaje tiene que explicar como desbloquearla, pero dijo: {error}"
        );
        assert!(error.contains(&blocked_text));
    }

    #[test]
    fn explains_each_windows_permission_failure_in_plain_language() {
        let root = Path::new("D:\\ROXWANA");
        let cases = [
            (WIN_ERROR_ACCESS_DENIED, "Acceso controlado a carpetas"),
            (WIN_ERROR_WRITE_PROTECT, "protegida contra escritura"),
            (WIN_ERROR_NOT_READY, "Conectá el disco externo"),
            (WIN_ERROR_DISK_FULL, "espacio libre"),
            (WIN_ERROR_PATH_TOO_LONG, "demasiado larga"),
            (WIN_ERROR_SHARING_VIOLATION, "Otro programa está usando"),
        ];
        for (code, expected) in cases {
            let error = std::io::Error::from_raw_os_error(code);
            let message = describe_root_failure(root, "crear la carpeta Trabajos", &error);
            assert!(
                message.contains(expected),
                "el error {code} deberia explicar \"{expected}\", pero dijo: {message}"
            );
            // Siempre tiene que decir que se estaba intentando y donde.
            assert!(message.contains("crear la carpeta Trabajos"));
            assert!(message.contains("D:\\ROXWANA"));
        }
    }

    #[test]
    fn compares_paths_like_windows_including_drive_roots() {
        assert!(path_is_inside(
            Path::new("C:\\Users\\ana\\Documentos"),
            Path::new("C:\\")
        ));
        assert!(path_is_inside(
            Path::new("D:/Biblioteca/Trabajos"),
            Path::new("D:\\biblioteca")
        ));
        assert!(path_is_inside(
            Path::new("D:\\Biblioteca\\"),
            Path::new("D:\\Biblioteca")
        ));
        // Un nombre que empieza igual no es una subcarpeta.
        assert!(!path_is_inside(
            Path::new("D:\\Biblioteca2"),
            Path::new("D:\\Biblioteca")
        ));
        assert!(!path_is_inside(
            Path::new("D:\\Biblioteca"),
            Path::new("D:\\Biblioteca\\Trabajos")
        ));
    }

    #[test]
    fn refuses_windows_folders_as_library() {
        for variable in ["SystemRoot", "ProgramFiles", "ProgramData"] {
            let Some(directory) = env_directory(variable) else {
                continue;
            };
            assert!(
                protected_root_reason(&directory).is_some(),
                "{variable} deberia rechazarse"
            );
            assert!(
                protected_root_reason(&directory.join("ROXWANA")).is_some(),
                "una subcarpeta de {variable} deberia rechazarse"
            );
        }

        if let Some(system_drive) = env_directory("SystemDrive") {
            assert!(protected_root_reason(&system_drive).is_some());
        }
        if let Some(profile) = env_directory("USERPROFILE") {
            assert!(protected_root_reason(&profile).is_some());
            if let Some(users) = profile.parent() {
                assert!(protected_root_reason(users).is_some());
            }
            // Documentos y Escritorio son ubicaciones normales y validas.
            assert!(protected_root_reason(&profile.join("Documents\\ROXWANA")).is_none());
            assert!(protected_root_reason(&profile.join("Desktop\\ROXWANA")).is_none());
        }

        assert!(protected_root_reason(Path::new("D:\\ROXWANA")).is_none());
    }

    #[test]
    fn accepts_a_normal_folder_and_warns_about_risky_locations() {
        let dir = tempdir().unwrap();
        validate_library_root_usable(dir.path()).unwrap();
        assert!(library_root_warnings(dir.path()).is_empty());
        // La comprobacion no deja ningun archivo suelto en la carpeta.
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none());

        let network = library_root_warnings(Path::new("\\\\NAS\\estampas"));
        assert!(network.iter().any(|aviso| aviso.contains("red")));

        let onedrive =
            library_root_warnings(Path::new("C:\\Users\\ana\\OneDrive\\Documentos\\ROXWANA"));
        assert!(onedrive.iter().any(|aviso| aviso.contains("OneDrive")));

        let deep = PathBuf::from(format!("D:\\{}", "carpeta-larga\\".repeat(12)));
        assert!(library_root_warnings(&deep)
            .iter()
            .any(|aviso| aviso.contains("muy larga")));

        assert!(library_root_warnings(Path::new("E:\\"))
            .iter()
            .any(|aviso| aviso.contains("unidad entera")));
    }

    #[test]
    fn keeps_a_rescue_copy_before_discarding_the_local_database() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("roxwana-biblioteca.sqlite");
        let conn = Connection::open(&db_path).unwrap();
        ensure_database(&conn).unwrap();
        save_setting(&conn, "library_root", "D:\\Biblioteca").unwrap();
        drop(conn);

        // Sin ninguna copia de Preferences la base local se descarta; el rescate
        // es lo unico que separa al usuario de perder su clasificacion.
        let applied = replace_local_database_from_authority(&[], &db_path).unwrap();
        assert!(applied.is_none());

        let rescue = dir
            .path()
            .join("copias-de-seguridad")
            .join(LOCAL_DATABASE_RESCUE_FILE_NAME);
        assert!(rescue.is_file(), "falta la copia de rescate");
        validate_backup_database(&rescue).unwrap();
        let rescued = Connection::open(&rescue).unwrap();
        assert_eq!(
            get_setting(&rescued, "library_root").unwrap().as_deref(),
            Some("D:\\Biblioteca")
        );
    }

    #[test]
    fn rejects_a_file_as_library_without_touching_it() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("not-a-library.txt");
        fs::write(&file, b"keep").unwrap();

        let error = validate_library_root_access(&file).unwrap_err();

        assert!(error.contains("no existe o ya no está disponible"));
        assert_eq!(fs::read(&file).unwrap(), b"keep");
    }

    #[test]
    fn starter_directories_never_touch_existing_content() {
        let dir = tempdir().unwrap();
        let trabajos = dir.path().join("Trabajos").join("Che Guevara");
        fs::create_dir_all(&trabajos).unwrap();
        fs::write(trabajos.join("imagen.png"), b"image").unwrap();
        let suelto = dir.path().join("estampa-suelta.png");
        fs::write(&suelto, b"image").unwrap();

        ensure_starter_directories(dir.path()).unwrap();

        assert!(trabajos.join("imagen.png").is_file());
        assert!(suelto.is_file());
        assert!(dir.path().join("Varios").is_dir());
    }

    /// Una carpeta recien elegida puede tener imagenes sueltas sin ninguna
    /// estructura: tienen que aparecer igual.
    #[test]
    fn reads_loose_images_from_a_freshly_chosen_folder() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("estampa-1.png"), b"image").unwrap();
        let subcarpeta = dir.path().join("lo que sea");
        fs::create_dir_all(&subcarpeta).unwrap();
        fs::write(subcarpeta.join("estampa-2.jpg"), b"image").unwrap();
        ensure_starter_directories(dir.path()).unwrap();

        let designs = collect_designs(dir.path()).unwrap();
        assert_eq!(designs.len(), 2, "se perdieron estampas: {designs:?}");
    }

    #[test]
    fn recognizes_varios_like_suelta() {
        assert!(is_loose_container_name("Varios"));
        assert!(is_loose_container_name("varios"));
        assert!(is_loose_container_name("Suelta"));
        assert!(is_loose_container_name("Freepik"));
        assert!(!is_loose_container_name("Trabajos"));
    }

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
    fn ignores_the_portable_preferences_directory_during_library_scan() {
        let dir = tempdir().unwrap();
        let preferences = dir.path().join(PREFERENCES_DIR_NAME);
        fs::create_dir_all(&preferences).unwrap();
        fs::write(preferences.join("no-mostrar.png"), b"preferences").unwrap();
        fs::write(dir.path().join("visible.png"), b"library").unwrap();

        let designs = collect_designs(dir.path()).unwrap();

        assert_eq!(designs.len(), 1);
        assert_eq!(designs[0].name, "Visible");
        assert!(designs.iter().all(|design| {
            !design
                .files
                .iter()
                .any(|file| file.path.contains(PREFERENCES_DIR_NAME))
        }));
    }

    #[test]
    fn detects_only_new_modified_or_deleted_library_files() {
        let dir = tempdir().unwrap();
        let design_dir = dir.path().join(FREEPIK_DIR_NAME).join("Coleccion");
        fs::create_dir_all(&design_dir).unwrap();
        let existing = design_dir.join("existente.jpg");
        fs::write(&existing, b"original").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        for design in collect_designs(dir.path()).unwrap() {
            persist_design(&conn, &design).unwrap();
        }
        assert!(changed_library_paths(&conn, dir.path()).unwrap().is_empty());

        fs::write(&existing, b"contenido modificado y mas largo").unwrap();
        let added = design_dir.join("nuevo.psd");
        fs::write(&added, b"editable").unwrap();
        let preferences_file = dir.path().join(PREFERENCES_DIR_NAME).join("ignorar.jpg");
        fs::create_dir_all(preferences_file.parent().unwrap()).unwrap();
        fs::write(&preferences_file, b"preferencia").unwrap();

        let changed = changed_library_paths(&conn, dir.path()).unwrap();
        assert_eq!(changed.len(), 2);
        assert!(changed.contains(&path_to_string(&existing)));
        assert!(changed.contains(&path_to_string(&added)));
        assert!(!changed.contains(&path_to_string(&preferences_file)));

        fs::remove_file(&existing).unwrap();
        let changed_after_delete = changed_library_paths(&conn, dir.path()).unwrap();
        assert_eq!(changed_after_delete.len(), 2);
        assert!(changed_after_delete.contains(&path_to_string(&existing)));
        assert!(changed_after_delete.contains(&path_to_string(&added)));
    }

    #[test]
    fn bulk_library_loading_matches_individual_design_loading() {
        let dir = tempdir().unwrap();
        let design_dir = dir.path().join(FREEPIK_DIR_NAME).join("Coleccion");
        fs::create_dir_all(&design_dir).unwrap();
        fs::write(design_dir.join("vista.jpg"), b"imagen").unwrap();
        fs::write(design_dir.join("editable.psd"), b"photoshop").unwrap();
        fs::write(design_dir.join("vector.ai"), b"illustrator").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        let collected = collect_designs(dir.path()).unwrap();
        assert_eq!(collected.len(), 1);
        persist_design(&conn, &collected[0]).unwrap();
        sync_auto_tags(&conn, &collected[0].id, &collected[0].auto_tags).unwrap();
        conn.execute(
            "UPDATE designs SET favorite = 1, status = 'working' WHERE id = ?1",
            params![collected[0].id],
        )
        .unwrap();
        let manual_tag = upsert_tag(&conn, "favorita").unwrap();
        conn.execute(
            "INSERT INTO design_tags (design_id, tag_id, source) VALUES (?1, ?2, 'manual')",
            params![collected[0].id, manual_tag],
        )
        .unwrap();

        let bulk = load_library_from_db(&conn, &path_to_string(dir.path())).unwrap();
        let individual = load_design_from_db(&conn, &collected[0].id, false)
            .unwrap()
            .unwrap();

        assert_eq!(bulk.designs.len(), 1);
        assert_eq!(
            serde_json::to_value(&bulk.designs[0]).unwrap(),
            serde_json::to_value(individual).unwrap()
        );
    }

    #[test]
    fn uses_a_versioned_portable_preferences_file_and_revision() {
        let dir = tempdir().unwrap();
        let paths = portable_preferences_paths(dir.path());
        assert_eq!(
            portable_preferences_path(dir.path()),
            dir.path()
                .join(PREFERENCES_DIR_NAME)
                .join("roxwana-preferences-v1.0.0.sqlite")
        );
        assert_eq!(
            paths[1],
            dir.path()
                .join(PREFERENCES_DIR_NAME)
                .join("roxwana-preferences-v1.0.0-anterior-1.sqlite")
        );
        assert_eq!(
            paths[2],
            dir.path()
                .join(PREFERENCES_DIR_NAME)
                .join("roxwana-preferences-v1.0.0-anterior-2.sqlite")
        );

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
             VALUES ('group-test', 'Mi grupo', 'mi grupo', 0, 0)",
            [],
        )
        .unwrap();
        save_setting(&conn, PORTABLE_PREFERENCES_REVISION_SETTING, "123").unwrap();

        assert_eq!(preferences_revision(&conn).unwrap(), 123);
    }

    #[test]
    fn portable_preferences_are_authoritative_when_present_or_missing() {
        let dir = tempdir().unwrap();
        let local = dir.path().join("local.sqlite");
        let portable = dir.path().join("portable.sqlite");
        let previous = dir.path().join("previous.sqlite");
        let older = dir.path().join("older.sqlite");
        let sources = [portable.clone(), previous.clone(), older];

        let local_conn = Connection::open(&local).unwrap();
        ensure_database(&local_conn).unwrap();
        local_conn
            .execute(
                "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
                 VALUES ('local-group', 'Solo local', 'solo local', 0, 0)",
                [],
            )
            .unwrap();
        drop(local_conn);

        assert!(replace_local_database_from_authority(&sources, &local)
            .unwrap()
            .is_none());
        let reset_conn = Connection::open(&local).unwrap();
        let reset_groups: i64 = reset_conn
            .query_row("SELECT COUNT(*) FROM category_groups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(reset_groups, 0);
        drop(reset_conn);

        let portable_conn = Connection::open(&portable).unwrap();
        ensure_database(&portable_conn).unwrap();
        portable_conn
            .execute(
                "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
                 VALUES ('portable-group', 'Desde Preferences', 'desde preferences', 0, 0)",
                [],
            )
            .unwrap();
        drop(portable_conn);

        assert_eq!(
            replace_local_database_from_authority(&sources, &local).unwrap(),
            Some(portable.clone())
        );
        let restored_conn = Connection::open(&local).unwrap();
        let restored_group: String = restored_conn
            .query_row("SELECT name FROM category_groups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(restored_group, "Desde Preferences");
        drop(restored_conn);

        fs::write(&portable, b"archivo danado").unwrap();
        let previous_conn = Connection::open(&previous).unwrap();
        ensure_database(&previous_conn).unwrap();
        previous_conn
            .execute(
                "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
                 VALUES ('previous-group', 'Desde anterior', 'desde anterior', 0, 0)",
                [],
            )
            .unwrap();
        drop(previous_conn);

        assert_eq!(
            replace_local_database_from_authority(&sources, &local).unwrap(),
            Some(previous)
        );
        let fallback_conn = Connection::open(&local).unwrap();
        let fallback_group: String = fallback_conn
            .query_row("SELECT name FROM category_groups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fallback_group, "Desde anterior");
    }

    #[test]
    fn rotates_two_valid_portable_preference_snapshots() {
        let dir = tempdir().unwrap();
        let paths = portable_preferences_paths(dir.path());
        fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
        let create_snapshot = |path: &Path, group_id: &str, group_name: &str| {
            let conn = Connection::open(path).unwrap();
            ensure_database(&conn).unwrap();
            conn.execute(
                "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
                 VALUES (?1, ?2, lower(?2), 0, 0)",
                params![group_id, group_name],
            )
            .unwrap();
        };
        create_snapshot(&paths[0], "current", "Actual");
        create_snapshot(&paths[1], "previous", "Anterior");

        rotate_portable_preferences(&paths).unwrap();

        let previous_conn = Connection::open(&paths[1]).unwrap();
        let previous_name: String = previous_conn
            .query_row("SELECT name FROM category_groups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(previous_name, "Actual");
        let older_conn = Connection::open(&paths[2]).unwrap();
        let older_name: String = older_conn
            .query_row("SELECT name FROM category_groups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(older_name, "Anterior");
    }

    #[test]
    fn seeds_missing_portable_history_without_consuming_updates() {
        let dir = tempdir().unwrap();
        let paths = portable_preferences_paths(dir.path());
        fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
        let conn = Connection::open(&paths[0]).unwrap();
        ensure_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO category_groups (id, name, lower_name, sort_order, collapsed)
             VALUES ('baseline', 'Configuracion base', 'configuracion base', 0, 0)",
            [],
        )
        .unwrap();
        drop(conn);

        ensure_portable_history_seeded(&paths).unwrap();

        for path in &paths[1..] {
            validate_backup_database(path).unwrap();
            let copy_conn = Connection::open(path).unwrap();
            let group_name: String = copy_conn
                .query_row("SELECT name FROM category_groups", [], |row| row.get(0))
                .unwrap();
            assert_eq!(group_name, "Configuracion base");
        }
    }

    #[test]
    fn keeps_direct_work_files_separate_and_includes_editables() {
        let dir = tempdir().unwrap();
        let work = dir.path().join(WORKS_DIR_NAME).join("Che Guevara");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("imagen-1.png"), b"image-one").unwrap();
        fs::write(work.join("imagen-2.png"), b"image-two").unwrap();
        fs::write(work.join("archivo.psd"), b"editable").unwrap();

        let designs = collect_designs(dir.path()).unwrap();

        assert_eq!(designs.len(), 3);
        assert!(designs.iter().all(|design| {
            design.group_type == "loose_file"
                && design.files.len() == 1
                && design.auto_category.as_deref() == Some("Che Guevara")
        }));
        assert!(designs.iter().any(|design| {
            design.name == "Archivo"
                && design.preview_path.is_none()
                && design.counts.psd == 1
                && design.files[0].file_name == "archivo.psd"
        }));
        assert!(work.join("imagen-1.png").is_file());
        assert!(work.join("imagen-2.png").is_file());
        assert!(work.join("archivo.psd").is_file());
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
        let cache = category.join(PORTABLE_CACHE_DIR_NAME).join("thumbnails");
        let nested_cache = cache.join(PORTABLE_CACHE_DIR_NAME).join("thumbnails");
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

        assert_eq!(
            purge_reference_cache_rows(&conn, "D:\\Biblioteca").unwrap(),
            1
        );
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
    fn loads_the_saved_reference_index_without_scanning_new_files() {
        let dir = tempdir().unwrap();
        let references = dir.path().join(REFERENCES_DIR_NAME);
        let category = references.join("Marvel");
        fs::create_dir_all(&category).unwrap();
        let indexed = category.join("indexada.jpg");
        let not_indexed = category.join("nueva.jpg");
        fs::write(&indexed, b"indexed").unwrap();
        fs::write(&not_indexed, b"new").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO reference_images (
                id, root_path, name, file_name, path, folder_path, category,
                size, modified, first_seen, last_seen, missing
             ) VALUES (?1, ?2, 'Indexada', 'indexada.jpg', ?3, ?4, 'Marvel', 7, 1, 1, 1, 0)",
            params![
                "ref-indexed",
                path_to_string(dir.path()),
                path_to_string(&indexed),
                path_to_string(&category),
            ],
        )
        .unwrap();

        let response =
            load_references_response_from_db(&conn, &path_to_string(dir.path())).unwrap();

        assert_eq!(response.references.len(), 1);
        assert_eq!(response.references[0].file_name, "indexada.jpg");
        assert_eq!(response.categories, vec!["Marvel".to_string()]);
    }

    #[test]
    fn detects_only_new_modified_or_deleted_reference_files() {
        let dir = tempdir().unwrap();
        let references = dir.path().join(REFERENCES_DIR_NAME);
        let category = references.join("Personajes");
        let cache = category.join(PORTABLE_CACHE_DIR_NAME).join("thumbnails");
        fs::create_dir_all(&cache).unwrap();
        let unchanged = category.join("quieta.jpg");
        let modified = category.join("cambiada.png");
        let added = category.join("nueva.webp");
        let deleted = category.join("borrada.jpg");
        fs::write(&unchanged, b"quiet").unwrap();
        fs::write(&modified, b"changed-now").unwrap();
        fs::write(&added, b"new").unwrap();
        fs::write(cache.join("ignorar.jpg"), b"cache").unwrap();

        let unchanged_metadata = fs::metadata(&unchanged).unwrap();
        let unchanged_modified = unchanged_metadata
            .modified()
            .ok()
            .and_then(system_time_to_i64)
            .unwrap_or(0);
        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        for (id, path, size, modified_at) in [
            (
                "quieta",
                &unchanged,
                unchanged_metadata.len() as i64,
                unchanged_modified,
            ),
            ("cambiada", &modified, 1, 1),
            ("borrada", &deleted, 1, 1),
        ] {
            conn.execute(
                "INSERT INTO reference_images (
                    id, root_path, name, file_name, path, folder_path, category,
                    size, modified, first_seen, last_seen, missing
                 ) VALUES (?1, ?2, ?1, ?1, ?3, ?4, 'Personajes', ?5, ?6, 1, 1, 0)",
                params![
                    id,
                    path_to_string(dir.path()),
                    path_to_string(path),
                    path_to_string(&category),
                    size,
                    modified_at,
                ],
            )
            .unwrap();
        }

        let changed =
            changed_reference_paths(&conn, &path_to_string(dir.path()), &references).unwrap();

        assert_eq!(
            changed.into_iter().collect::<BTreeSet<_>>(),
            [
                path_to_string(&added),
                path_to_string(&deleted),
                path_to_string(&modified),
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn marks_only_the_affected_reference_scope_as_missing() {
        let dir = tempdir().unwrap();
        let references = dir.path().join(REFERENCES_DIR_NAME);
        let marvel = references.join("Marvel");
        let retratos = references.join("Retratos");
        let conn = Connection::open_in_memory().unwrap();
        ensure_database(&conn).unwrap();
        for (id, path, category) in [
            ("marvel", marvel.join("uno.jpg"), "Marvel"),
            ("retrato", retratos.join("dos.jpg"), "Retratos"),
        ] {
            conn.execute(
                "INSERT INTO reference_images (
                    id, root_path, name, file_name, path, folder_path, category,
                    size, modified, first_seen, last_seen, missing
                 ) VALUES (?1, ?2, ?1, ?1, ?3, ?4, ?5, 1, 1, 1, 1, 0)",
                params![
                    id,
                    path_to_string(dir.path()),
                    path_to_string(&path),
                    path_to_string(path.parent().unwrap()),
                    category,
                ],
            )
            .unwrap();
        }

        assert_eq!(
            mark_reference_scopes_missing(
                &conn,
                &path_to_string(dir.path()),
                std::iter::once(&marvel),
            )
            .unwrap(),
            1
        );
        let states = conn
            .prepare("SELECT id, missing FROM reference_images ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            states,
            vec![("marvel".to_string(), 1), ("retrato".to_string(), 0)]
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
