use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
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
const PREVIEW_EXTENSIONS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp"];
const SUPPORT_EXTENSIONS: &[&str] = &[".ai", ".psd", ".svg", ".pdf", ".eps", ".zip", ".txt"];
const STATUSES: &[&str] = &["pending", "working", "ready", "discarded"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryResponse {
    root_path: String,
    designs: Vec<Design>,
    stats: LibraryStats,
    categories: Vec<String>,
    tags: Vec<String>,
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
    files: Vec<DesignFile>,
}

#[tauri::command]
fn get_initial_state(app: AppHandle) -> Result<LibraryResponse, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let root = get_setting(&conn, "library_root")?.unwrap_or_else(|| DEFAULT_LIBRARY_PATH.to_string());
    load_library_from_db(&conn, &root)
}

#[tauri::command]
fn get_library_from_db(app: AppHandle) -> Result<LibraryResponse, String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let root = get_setting(&conn, "library_root")?.unwrap_or_else(|| DEFAULT_LIBRARY_PATH.to_string());
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
fn rescan_paths(app: AppHandle, root_path: String, paths: Vec<String>) -> Result<LibraryResponse, String> {
    if paths.is_empty() || paths.len() > 80 {
        return scan_library_impl(&app, &root_path);
    }

    rescan_paths_impl(&app, &root_path, &paths)
}

#[tauri::command]
async fn generate_thumbnail(app: AppHandle, preview_path: String, updated_at: i64) -> Result<Option<String>, String> {
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

#[tauri::command]
async fn generate_preview(app: AppHandle, preview_path: String, updated_at: i64) -> Result<Option<String>, String> {
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
fn update_design_category(app: AppHandle, design_id: String, category: Option<String>) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_database(&conn)?;
    let normalized = category.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(title_caseish(&trimmed))
        }
    });

    if let Some(category_name) = &normalized {
        upsert_category(&conn, category_name, true)?;
    }

    conn.execute(
        "UPDATE designs SET category = ?1, category_user_set = 1 WHERE id = ?2",
        params![normalized, design_id],
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

fn scan_library_impl(app: &AppHandle, root_path: &str) -> Result<LibraryResponse, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("La carpeta no existe: {root_path}"));
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    save_setting(&conn, "library_root", root_path)?;
    conn.execute("UPDATE designs SET missing = 1", []).map_err(to_string)?;
    conn.execute("UPDATE files SET missing = 1", []).map_err(to_string)?;

    let mut collected = collect_designs(&root)?;
    for design in &mut collected {
        design.thumbnail_path = cached_thumbnail(app, design.preview_path.as_deref(), design.updated_at)?;
        design.preview_cache_path = cached_preview(app, design.preview_path.as_deref(), design.updated_at)?;
        persist_design(&conn, design)?;
        sync_auto_tags(&conn, &design.id, &design.auto_tags)?;
    }

    load_library_from_db(&conn, root_path)
}

fn rescan_paths_impl(app: &AppHandle, root_path: &str, paths: &[String]) -> Result<LibraryResponse, String> {
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
            path.parent().map(Path::to_path_buf).unwrap_or_else(|| root.clone())
        };

        if same_path(&target, &root) {
            needs_full_scan = true;
            break;
        }

        if target.starts_with(&root) {
            affected_dirs.insert(target);
        }
    }

    if needs_full_scan || affected_dirs.is_empty() {
        return scan_library_impl(app, root_path);
    }

    let conn = open_database(app)?;
    ensure_database(&conn)?;
    save_setting(&conn, "library_root", root_path)?;

    for dir in &affected_dirs {
        let dir_string = path_to_string(dir);
        conn.execute("UPDATE designs SET missing = 1 WHERE directory = ?1", params![dir_string])
            .map_err(to_string)?;
        conn.execute(
            "UPDATE files SET missing = 1 WHERE design_id IN (SELECT id FROM designs WHERE directory = ?1)",
            params![path_to_string(dir)],
        )
        .map_err(to_string)?;
    }

    let walk_roots = affected_dirs.into_iter().collect::<Vec<_>>();
    let mut collected = collect_designs_from_walk_roots(&root, &walk_roots)?;
    for design in &mut collected {
        design.thumbnail_path = cached_thumbnail(app, design.preview_path.as_deref(), design.updated_at)?;
        design.preview_cache_path = cached_preview(app, design.preview_path.as_deref(), design.updated_at)?;
        persist_design(&conn, design)?;
        sync_auto_tags(&conn, &design.id, &design.auto_tags)?;
    }

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
    let categories = load_categories(conn)?;
    let tags = load_tags(conn)?;

    Ok(LibraryResponse {
        root_path: root_path.to_string(),
        designs,
        stats,
        categories,
        tags,
    })
}

fn load_design_from_db(conn: &Connection, design_id: &str, include_files: bool) -> Result<Option<Design>, String> {
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

    let Some((id, name, path, directory, group_type, preview_path, preview_cache_path, thumbnail_path, total_files, updated_at, auto_category)) = row else {
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
    let files = stmt.query_map(params![design_id], |row| {
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
        .query_map(params![design_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
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
    let tags = stmt.query_map(params![design_id], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(tags)
}

fn build_stats_from_db(conn: &Connection) -> Result<LibraryStats, String> {
    let designs = conn
        .query_row("SELECT COUNT(*) FROM designs WHERE missing = 0", [], |row| row.get::<_, i64>(0))
        .map_err(to_string)? as usize;
    let missing = conn
        .query_row("SELECT COUNT(*) FROM designs WHERE missing = 1", [], |row| row.get::<_, i64>(0))
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
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
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

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("No se pudo resolver APPLOCALDATA: {error}"))?;
    fs::create_dir_all(&dir).map_err(to_string)?;
    let db_path = dir.join("roxwana-biblioteca.sqlite");
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

    seed_categories(conn)?;
    Ok(())
}

fn seed_categories(conn: &Connection) -> Result<(), String> {
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

    Ok(())
}

fn collect_designs(root: &Path) -> Result<Vec<CollectedDesign>, String> {
    collect_designs_from_walk_roots(root, &[root.to_path_buf()])
}

fn collect_designs_from_walk_roots(root: &Path, walk_roots: &[PathBuf]) -> Result<Vec<CollectedDesign>, String> {
    let mut groups: BTreeMap<String, GroupBuilder> = BTreeMap::new();
    let root = root.to_path_buf();

    for walk_root in walk_roots {
        if !walk_root.exists() {
            continue;
        }

        for entry in WalkDir::new(walk_root).follow_links(false).into_iter() {
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
            let (key, key_path, directory, group_type, name) = if same_path(&parent, &root) {
                let key_path = root.join(&file_stem);
                (
                    format!("root:{}", file_stem.to_lowercase()),
                    key_path,
                    root.clone(),
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
                    files: Vec::new(),
                })
                .files
                .push(file);
        }
    }

    let mut designs = Vec::with_capacity(groups.len());
    for (_, mut group) in groups {
        group.files.sort_by(|left, right| left.file_name.cmp(&right.file_name));
        let design_id = stable_id(&normalize_path_for_id(&group.key_path));
        for file in &mut group.files {
            file.design_id = design_id.clone();
        }

        let preview_path = choose_preview(&group.files).map(PathBuf::from);
        let counts = build_counts(&group.files);
        let updated_at = group.files.iter().map(|file| file.modified).max().unwrap_or(0);
        let (auto_category, auto_tags) = classify_design(&group.name, &group.files);

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
    let preview_path = design.preview_path.as_ref().map(|path| path_to_string(path));
    let preview_cache_path = design.preview_cache_path.as_ref().map(|path| path_to_string(path));
    let thumbnail_path = design.thumbnail_path.as_ref().map(|path| path_to_string(path));

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
                ELSE excluded.auto_category
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
            design.auto_category,
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
        upsert_category(conn, category, false)?;
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

fn cached_thumbnail(app: &AppHandle, preview_path: Option<&Path>, updated_at: i64) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };
    let target = image_cache_path(app, "thumbnails", preview_path, updated_at, "webp")?;
    if target.exists() {
        return Ok(Some(target));
    }

    let legacy_target = image_cache_path(app, "thumbnails", preview_path, updated_at, "jpg")?;
    if legacy_target.exists() {
        Ok(Some(legacy_target))
    } else {
        Ok(None)
    }
}

fn cached_preview(app: &AppHandle, preview_path: Option<&Path>, updated_at: i64) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };
    let target = image_cache_path(app, "previews", preview_path, updated_at, "jpg")?;
    if target.exists() {
        Ok(Some(target))
    } else {
        Ok(None)
    }
}

fn ensure_thumbnail(app: &AppHandle, preview_path: Option<&Path>, updated_at: i64) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };

    ensure_cached_image(app, "thumbnails", preview_path, updated_at, 320, image::ImageFormat::WebP, "webp")
}

fn ensure_preview_cache(app: &AppHandle, preview_path: Option<&Path>, updated_at: i64) -> Result<Option<PathBuf>, String> {
    let Some(preview_path) = preview_path else {
        return Ok(None);
    };

    ensure_cached_image(app, "previews", preview_path, updated_at, 1600, image::ImageFormat::Jpeg, "jpg")
}

fn ensure_cached_image(
    app: &AppHandle,
    cache_name: &str,
    preview_path: &Path,
    updated_at: i64,
    max_side: u32,
    format: image::ImageFormat,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    let target = image_cache_path(app, cache_name, preview_path, updated_at, extension)?;
    if target.exists() {
        return Ok(Some(target));
    }

    match image::open(preview_path) {
        Ok(image) => {
            let cached = image.thumbnail(max_side, max_side);
            cached
                .save_with_format(&target, format)
                .map_err(to_string)?;
            Ok(Some(target))
        }
        Err(_) => Ok(None),
    }
}

fn image_cache_path(app: &AppHandle, cache_name: &str, preview_path: &Path, updated_at: i64, extension: &str) -> Result<PathBuf, String> {
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
    fs::create_dir_all(&cache_dir).map_err(to_string)?;
    Ok(cache_dir.join(format!("{cache_key}.{extension}")))
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

    rule(&["skate", "skater", "skateboard", "longboard"], "Skater", &["skate", "skater", "urbano"]);
    rule(&["skull", "calavera", "dead", "death", "skeleton", "muertos"], "Calaveras", &["calavera"]);
    rule(&["surf", "surfer", "wave", "beach", "summer", "tropical", "palms"], "Surf y playa", &["surf", "playa"]);
    rule(&["dog", "cat", "tiger", "lion", "bear", "wolf", "panther", "shark", "crocodile", "frog", "eagle", "raven", "moth", "butterfly", "animal", "axolotl", "whale", "vulture", "turtle"], "Animales", &["animales"]);
    rule(&["man", "men", "male", "boy", "father", "cowboy", "professor", "rider", "biker"], "Hombre", &["hombre"]);
    rule(&["woman", "women", "female", "girl", "mother", "mujer"], "Mujer", &["mujer"]);
    rule(&["motorcycle", "bike", "biker", "cafe-racer", "ride"], "Motos", &["motos"]);
    rule(&["rock", "punk", "metal", "guitar"], "Rock", &["rock", "musica"]);
    rule(&["music", "musician", "trumpet", "reggae", "cumbia", "reggaeton", "bachata", "album"], "Musica", &["musica"]);
    rule(&["quote", "motivational", "lettering", "typography", "slogan", "frase"], "Frases", &["frases", "tipografia"]);
    rule(&["gothic", "occult", "raven", "dark", "graveyard"], "Gotico", &["gotico"]);
    rule(&["retro", "vintage", "80s", "y2k", "neon", "pop-art"], "Retro", &["retro", "vintage"]);
    rule(&["flower", "nature", "sun", "moon", "desert", "cactus", "climate"], "Naturaleza", &["naturaleza"]);
    rule(&["love", "heart", "valentine", "mother"], "Amor", &["amor"]);
    rule(&["halloween", "hocus", "ghost"], "Halloween", &["halloween"]);
    rule(&["dia-de-los-muertos", "muertos"], "Dia de los muertos", &["dia de los muertos"]);
    rule(&["football", "basket", "skiing", "hunting", "sport"], "Deportes", &["deportes"]);
    rule(&["cowboy", "western", "wild-west", "arizona"], "Oeste", &["oeste"]);
    rule(&["streetwear", "street-wear", "urban", "bronx", "los-angeles", "brutalism"], "Urbano", &["urbano", "streetwear"]);
    rule(&["text-effect", "logo", "badge", "template", "poster", "emblem"], "Textos y efectos", &["editable"]);
    rule(&["abstract", "grunge", "gradient", "pattern"], "Abstracto", &["abstracto"]);
    rule(&["cute", "dinosaur", "bunny", "unicorn", "happy"], "Infantil", &["infantil"]);

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
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0))
        .optional()
        .map_err(to_string)
}

fn upsert_category(conn: &Connection, name: &str, user_created: bool) -> Result<(), String> {
    let normalized = title_caseish(name);
    conn.execute(
        "INSERT INTO categories (id, name, lower_name, sort_order, user_created)
         VALUES (?1, ?2, ?3, 999, ?4)
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

fn load_categories(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM categories ORDER BY sort_order, name COLLATE NOCASE")
        .map_err(to_string)?;
    let categories = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(to_string)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(to_string)?;
    Ok(categories)
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

fn normalize_path_for_id(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn stable_id(input: &str) -> String {
    let hash = Sha256::digest(input.as_bytes());
    hash.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

fn system_time_to_i64(value: SystemTime) -> Option<i64> {
    value.duration_since(UNIX_EPOCH).ok().map(|duration| duration.as_secs() as i64)
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_initial_state,
            get_library_from_db,
            get_design_detail,
            scan_library,
            rescan_paths,
            generate_thumbnail,
            generate_preview,
            update_design_favorite,
            update_design_status,
            update_design_category,
            add_design_tag,
            remove_design_tag,
            open_design_folder,
            reveal_design_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
        assert!(designs.iter().any(|design| design.group_type == "loose_file" && design.files.len() == 2));
        assert!(designs.iter().any(|design| design.name == "Skateboard Skull" && design.counts.psd == 1));
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
}
