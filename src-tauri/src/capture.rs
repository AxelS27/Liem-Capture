use std::{
    collections::HashMap,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{command, AppHandle, Emitter, Manager};
use xcap::Monitor;

use crate::window;

#[derive(Clone, serde::Serialize)]
pub struct ThumbnailPayload {
    pub path: String,
    pub image: String, // base64-encoded PNG
}

static THUMBNAIL_PAYLOADS: OnceLock<Mutex<HashMap<String, ThumbnailPayload>>> = OnceLock::new();

struct ThumbnailTimerPause {
    app: AppHandle,
}

impl ThumbnailTimerPause {
    fn new(app: &AppHandle) -> Self {
        window::pause_thumbnail_timers(app);
        Self { app: app.clone() }
    }
}

impl Drop for ThumbnailTimerPause {
    fn drop(&mut self) {
        window::resume_thumbnail_timers(&self.app);
    }
}

/// Hide overlay/thumbnail chrome for the duration of a single capture call so
/// they do not appear in the resulting PNG. Restores them when dropped.
struct ChromeCaptureGuard {
    app: AppHandle,
    hidden: Vec<String>,
}

impl ChromeCaptureGuard {
    fn new(app: &AppHandle) -> Self {
        let hidden = window::hide_chrome_for_capture(app);
        Self {
            app: app.clone(),
            hidden,
        }
    }
}

impl Drop for ChromeCaptureGuard {
    fn drop(&mut self) {
        window::restore_chrome_after_capture(&self.app, std::mem::take(&mut self.hidden));
    }
}

fn thumbnail_payloads() -> &'static Mutex<HashMap<String, ThumbnailPayload>> {
    THUMBNAIL_PAYLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Permanent gallery folder under the user's Documents directory. All shots
/// land here so the in-overlay gallery has a single, persistent source. Falls
/// back to the system temp dir if the Documents path is unresolvable (e.g.
/// portable / unusual user profile).
fn gallery_dir(app: &AppHandle) -> PathBuf {
    let mut p = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    p.push("Liem Capture");
    std::fs::create_dir_all(&p).ok();
    p
}

fn temp_capture_dir(app: &AppHandle) -> PathBuf {
    let mut p = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Liem Capture"));
    p.push("unsaved-captures");
    std::fs::create_dir_all(&p).ok();
    p
}

fn is_temp_capture_path(app: &AppHandle, path: &Path) -> bool {
    let root = temp_capture_dir(app);
    let canonical_root = std::fs::canonicalize(&root).unwrap_or(root);
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical_path.starts_with(canonical_root)
}

#[derive(Clone, serde::Serialize)]
pub struct GalleryItem {
    pub path: String,
    pub name: String,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct FolderNode {
    /// Display name. Empty string for the root.
    pub name: String,
    /// Absolute filesystem path.
    pub path: String,
    pub children: Vec<FolderNode>,
}

/// Resolve a user-supplied path to one that we are willing to act on.
/// All gallery operations are sandboxed under the gallery root — this guards
/// against the frontend (or a hostile caller) handing us something outside
/// Documents/Liem Capture like "C:\Windows\System32".
fn resolve_gallery_path(app: &AppHandle, raw: Option<String>) -> Result<PathBuf, String> {
    let root = gallery_dir(app);
    let candidate = match raw {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => return Ok(root),
    };
    let canonical_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let canonical_candidate =
        std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err("Path is outside the gallery root".into());
    }
    Ok(canonical_candidate)
}

fn build_folder_tree(path: &Path) -> FolderNode {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mut children = Vec::new();
    if let Ok(read) = std::fs::read_dir(path) {
        for entry in read.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                children.push(build_folder_tree(&entry_path));
            }
        }
    }
    children.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    FolderNode {
        name,
        path: path.to_string_lossy().to_string(),
        children,
    }
}

/// Returns the full folder tree under the gallery root. The root node's
/// `name` is "Liem Capture" (or whatever the user's locale calls Documents),
/// `path` is the canonical absolute path, and `children` is the recursive
/// folder structure. Folders sorted alphabetically, case-insensitive.
#[command]
pub fn list_gallery_tree(app: AppHandle) -> FolderNode {
    let root = gallery_dir(&app);
    let mut tree = build_folder_tree(&root);
    // Force the root display name so the frontend has a stable label.
    tree.name = "Liem Capture".into();
    tree
}

/// List PNGs in a specific folder under the gallery root. Pass `None` (or
/// omit `folder`) to list the root. Returned items are newest-first.
#[command]
pub fn list_gallery_items(
    app: AppHandle,
    folder: Option<String>,
) -> Result<Vec<GalleryItem>, String> {
    let dir = resolve_gallery_path(&app, folder)?;
    let mut items: Vec<GalleryItem> = Vec::new();

    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(items),
    };

    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            != Some("png".to_string())
        {
            continue;
        }
        let modified_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        items.push(GalleryItem {
            path: path.to_string_lossy().to_string(),
            name,
            modified_ms,
        });
    }

    items.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(items)
}

fn sanitize_folder_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    if trimmed.len() > 80 {
        return Err("Folder name too long".into());
    }
    // Reject path separators and Windows-illegal characters outright.
    const BANNED: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if trimmed
        .chars()
        .any(|c| BANNED.contains(&c) || c.is_control())
    {
        return Err("Folder name contains illegal characters".into());
    }
    Ok(trimmed.to_string())
}

#[command]
pub fn create_gallery_folder(
    app: AppHandle,
    parent: Option<String>,
    name: String,
) -> Result<String, String> {
    let parent_path = resolve_gallery_path(&app, parent)?;
    let safe_name = sanitize_folder_name(&name)?;
    let new_path = parent_path.join(&safe_name);
    if new_path.exists() {
        return Err("A folder with that name already exists".into());
    }
    std::fs::create_dir(&new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[command]
pub fn rename_gallery_folder(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let folder = resolve_gallery_path(&app, Some(path))?;
    if folder == gallery_dir(&app) {
        return Err("Cannot rename the gallery root".into());
    }
    let safe_name = sanitize_folder_name(&new_name)?;
    let parent = folder
        .parent()
        .ok_or_else(|| "Folder has no parent".to_string())?;
    let new_path = parent.join(&safe_name);
    if new_path.exists() {
        return Err("A folder with that name already exists".into());
    }
    std::fs::rename(&folder, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[command]
pub fn delete_gallery_folder(app: AppHandle, path: String) -> Result<(), String> {
    let folder = resolve_gallery_path(&app, Some(path))?;
    if folder == gallery_dir(&app) {
        return Err("Cannot delete the gallery root".into());
    }
    std::fs::remove_dir_all(&folder).map_err(|e| e.to_string())
}

/// Rename a gallery file. The new name should not include an extension —
/// we preserve whatever extension the file already has so the user can't
/// accidentally turn a .png into something else. Returns the new absolute
/// path so the frontend can re-anchor its selection.
#[command]
pub fn rename_gallery_item(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let src = resolve_gallery_path(&app, Some(path))?;
    if !src.is_file() {
        return Err("Source is not a file".into());
    }
    let safe = sanitize_folder_name(&new_name)?; // same rules: no path sep, no Windows-illegal chars
    let parent = src
        .parent()
        .ok_or_else(|| "File has no parent folder".to_string())?;
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let candidate_name = if safe.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        safe
    } else {
        format!("{safe}.{ext}")
    };
    let dest = parent.join(&candidate_name);
    if dest == src {
        return Ok(src.to_string_lossy().to_string());
    }
    if dest.exists() {
        return Err("A file with that name already exists".into());
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[command]
pub fn move_gallery_item(
    app: AppHandle,
    path: String,
    dest_folder: Option<String>,
) -> Result<String, String> {
    let src = resolve_gallery_path(&app, Some(path))?;
    if !src.is_file() {
        return Err("Source is not a file".into());
    }
    let dest_dir = resolve_gallery_path(&app, dest_folder)?;
    let file_name = src
        .file_name()
        .ok_or_else(|| "Source has no file name".to_string())?;
    let mut dest = dest_dir.join(file_name);

    // If a file with the same name already exists in the destination,
    // append a numeric suffix so we never overwrite.
    if dest.exists() && dest != src {
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("shot")
            .to_string();
        let ext = src
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png")
            .to_string();
        let mut idx = 1u32;
        loop {
            let candidate = dest_dir.join(format!("{stem}_{idx}.{ext}"));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            idx += 1;
        }
    }

    if src == dest {
        return Ok(src.to_string_lossy().to_string());
    }
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

/// Returns a small base64-encoded preview PNG for a gallery file. Sized to
/// roughly fit a grid tile so the overlay doesn't load multi-MB originals
/// just to render thumbnails.
#[command]
pub fn get_gallery_preview(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    let bytes = encode_preview_png(&img)?;
    Ok(STANDARD.encode(bytes))
}

#[derive(Clone, serde::Serialize)]
pub struct GalleryMetadata {
    pub name: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: u64,
}

/// Returns lightweight metadata for a single gallery file: pixel
/// dimensions (read from the PNG header only — no full decode), file
/// size, and mtime. Used by the gallery info panel after a click.
#[command]
pub fn get_gallery_metadata(path: String) -> Result<GalleryMetadata, String> {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let size_bytes = metadata.len();
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let (width, height) = image::image_dimensions(p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Ok(GalleryMetadata {
        name,
        path: path.clone(),
        width,
        height,
        size_bytes,
        modified_ms,
    })
}

/// Delete a gallery file. Frontend calls this from the gallery's per-item
/// delete action.
#[command]
pub fn delete_gallery_item(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Re-open a saved gallery item as a floating thumbnail and signal the
/// thumbnail window to immediately expand into preview/editor mode. Used
/// when the user clicks a tile in the overlay gallery — same flow as a
/// fresh capture, but the source PNG already exists on disk.
#[command]
pub fn open_gallery_item(app: AppHandle, path: String) -> Result<(), String> {
    open_gallery_item_inner(app, path, "liem-thumbnail-auto-preview")
}

/// View-only counterpart of `open_gallery_item`. Spawns the thumbnail and
/// expands it to the preview size, but signals the JS side to skip the
/// editor canvas / toolbar — the user just sees the image larger. Used by
/// the gallery's double-click action.
#[command]
pub fn view_gallery_item(app: AppHandle, path: String) -> Result<(), String> {
    open_gallery_item_inner(app, path, "liem-thumbnail-auto-view")
}

fn open_gallery_item_inner(
    app: AppHandle,
    path: String,
    event: &'static str,
) -> Result<(), String> {
    // Close the overlay first so the spawned thumbnail is the only thing
    // on screen.
    window::hide_overlay(app.clone());

    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    let idx = window::reserve_thumbnail_index();
    push_thumbnail(&app, path, &img, idx);

    // Give the thumbnail window a beat to receive its payload and run
    // applyThumbnail before we ask it to enter preview / view mode.
    let label = format!("thumbnail-{idx}");
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(180));
        if let Some(win) = app_clone.get_webview_window(&label) {
            let _ = win.emit(event, &label);
        }
    });

    Ok(())
}

fn save_png_compressed(path: &Path, img: &image::RgbaImage) -> Result<(), String> {
    use image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ColorType, ImageEncoder,
    };

    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let writer = BufWriter::new(file);
    PngEncoder::new_with_quality(writer, CompressionType::Fast, FilterType::Adaptive)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| e.to_string())
}

fn encode_preview_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    use image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        imageops, ColorType, ImageEncoder,
    };

    let preview = imageops::thumbnail(img, 600, 400);
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::NoFilter)
        .write_image(
            preview.as_raw(),
            preview.width(),
            preview.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn push_thumbnail(app: &AppHandle, path_str: String, img: &image::RgbaImage, idx: u32) {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let b64 = match encode_preview_png(img) {
        Ok(bytes) => STANDARD.encode(bytes),
        Err(e) => {
            window::release_thumbnail_index(idx);
            eprintln!("Thumbnail preview encode error: {e}");
            return;
        }
    };
    let label = format!("thumbnail-{idx}");
    let payload = ThumbnailPayload {
        path: path_str,
        image: b64,
    };

    if let Ok(mut payloads) = thumbnail_payloads().lock() {
        payloads.insert(label, payload.clone());
    }

    if let Err(e) = window::show_thumbnail(app, idx, &payload) {
        window::release_thumbnail_index(idx);
        eprintln!("Thumbnail window error: {e}");
    }
}

#[command]
pub fn get_thumbnail_data(label: String) -> Result<ThumbnailPayload, String> {
    thumbnail_payloads()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| format!("No thumbnail payload found for {label}"))
}

#[command]
pub fn get_image_data(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

/// Decode a base64 data URL and write the resulting PNG bytes to the
/// user-chosen destination. Used by the "Save as…" flow when the user
/// wants to export an edited screenshot outside the gallery (Desktop,
/// Downloads, anywhere on disk).
#[command]
pub fn export_png_to_path(path: String, data_url: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url.as_str());
    let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    save_png_compressed(Path::new(&path), &img)
}

#[command]
pub fn save_edited_thumbnail(
    app: AppHandle,
    label: String,
    path: String,
    data_url: String,
    dest_folder: Option<String>,
    dest_name: Option<String>,
    has_edits: bool,
) -> Result<ThumbnailPayload, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url.as_str());
    let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();

    let src = PathBuf::from(&path);
    // Resolve the final write location.
    //
    //   • dest_folder = None / ""        → overwrite the original file in place
    //   • dest_folder names a sub-folder → write into that folder, using the
    //                                      source's filename
    //
    // Then apply the save guard:
    //
    //   final == src           saving in place
    //                          • no edits   → block. Nothing has actually
    //                                         changed; spamming save would
    //                                         just keep re-encoding the same
    //                                         bytes.
    //                          • has edits  → overwrite. Standard "bake my
    //                                         edits into the original" flow.
    //
    //   final != src           saving to a different folder
    //                          • destination clean              → save.
    //                          • destination has duplicate name
    //                              · no edits  → block (nothing to copy and
    //                                            we won't silently clobber
    //                                            an unrelated screenshot).
    //                              · has edits → auto-suffix and save as a
    //                                            new file (foo.png →
    //                                            foo_1.png). The edits make
    //                                            it a genuinely new artifact.
    // Resolve target folder: explicit dest_folder, else the file's
    // current folder. Fresh captures live in the temp capture directory,
    // so a named save with no explicit folder means "gallery root".
    let named_gallery_save = dest_name
        .as_ref()
        .is_some_and(|name| !name.trim().is_empty());
    let target_folder: PathBuf = if let Some(folder) = dest_folder.filter(|f| !f.trim().is_empty())
    {
        resolve_gallery_path(&app, Some(folder))?
    } else if named_gallery_save {
        gallery_dir(&app)
    } else {
        src.parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| gallery_dir(&app))
    };

    // Resolve target filename. dest_name is the user's chosen name from
    // the picker's filename input. We sanitize it (no path separators or
    // Windows-illegal chars), strip any trailing ".png" the user typed,
    // then force ".png" back on so the file always has the right
    // extension. Falling back to the source filename when nothing was
    // passed keeps existing callers (auto-save on minimize) working
    // unchanged.
    let target_filename: std::ffi::OsString =
        if let Some(name) = dest_name.filter(|n| !n.trim().is_empty()) {
            let safe = sanitize_folder_name(&name)?;
            let lower = safe.to_ascii_lowercase();
            let stem = if lower.ends_with(".png") {
                safe[..safe.len() - 4].trim().to_string()
            } else {
                safe
            };
            if stem.is_empty() {
                return Err("File name cannot be empty".into());
            }
            format!("{stem}.png").into()
        } else {
            src.file_name()
                .ok_or_else(|| "Source has no filename".to_string())?
                .to_os_string()
        };

    let candidate = target_folder.join(&target_filename);

    let final_path = if candidate == src {
        // Same destination — UI gating already prevents redundant saves
        // for files the user has explicitly saved before; for fresh
        // screenshots a no-op rewrite is harmless and lets the first
        // save "just work".
        candidate
    } else if candidate.exists() {
        if !has_edits {
            return Err("A file with that name already exists in the destination".into());
        }
        // Has edits + name conflict → save alongside as a new file.
        let target_path = Path::new(&target_filename);
        let stem = target_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("shot")
            .to_string();
        let ext = target_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png")
            .to_string();
        let mut idx = 1u32;
        loop {
            let attempt = target_folder.join(format!("{stem}_{idx}.{ext}"));
            if !attempt.exists() {
                break attempt;
            }
            idx += 1;
        }
    } else {
        candidate
    };

    save_png_compressed(&final_path, &img)?;
    // If the user picked a different folder, the original file in the
    // old location is now stale — remove it so we don't leave duplicates
    // scattered around the gallery.
    if final_path != src && src.exists() {
        let _ = std::fs::remove_file(&src);
    }

    let preview = STANDARD.encode(encode_preview_png(&img)?);
    let payload = ThumbnailPayload {
        path: final_path.to_string_lossy().to_string(),
        image: preview,
    };

    thumbnail_payloads()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label, payload.clone());

    let _ = copy_rgba_to_clipboard(&img);
    Ok(payload)
}

#[command]
pub fn discard_unsaved_capture(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if is_temp_capture_path(&app, &path) && path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub fn take_screenshot(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let _timer_pause = ThumbnailTimerPause::new(&app);
    let _chrome_guard = ChromeCaptureGuard::new(&app);
    // Give DWM one frame to compose without the hidden windows before we grab
    // pixels via BitBlt. ~32ms covers a 30Hz worst case.
    std::thread::sleep(std::time::Duration::from_millis(32));
    let monitors = Monitor::all().map_err(|e| e.to_string())?;

    let monitor = monitors
        .iter()
        .find(|m| {
            let (mx, my) = (m.x(), m.y());
            let (mw, mh) = (m.width() as i32, m.height() as i32);
            x >= mx && y >= my && x < mx + mw && y < my + mh
        })
        .or_else(|| monitors.first())
        .ok_or("No monitor found")?;

    let full = monitor.capture_image().map_err(|e| e.to_string())?;

    let rel_x = (x - monitor.x()).max(0) as u32;
    let rel_y = (y - monitor.y()).max(0) as u32;
    let crop_w = width.min(monitor.width().saturating_sub(rel_x));
    let crop_h = height.min(monitor.height().saturating_sub(rel_y));

    let cropped = image::imageops::crop_imm(&full, rel_x, rel_y, crop_w, crop_h).to_image();

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = temp_capture_dir(&app).join(format!("shot_{ts}.png"));
    let path_str = path.to_string_lossy().to_string();
    let idx = window::reserve_thumbnail_index();
    push_thumbnail(&app, path_str.clone(), &cropped, idx);
    save_png_compressed(&path, &cropped)?;
    let _ = copy_rgba_to_clipboard(&cropped);

    Ok(path_str)
}

#[command]
pub fn take_fullscreen(app: AppHandle) -> Result<String, String> {
    let _timer_pause = ThumbnailTimerPause::new(&app);
    let _chrome_guard = ChromeCaptureGuard::new(&app);
    std::thread::sleep(std::time::Duration::from_millis(32));
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors.first().ok_or("No monitor found")?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = temp_capture_dir(&app).join(format!("shot_{ts}.png"));
    let path_str = path.to_string_lossy().to_string();
    let idx = window::reserve_thumbnail_index();
    push_thumbnail(&app, path_str.clone(), &image, idx);
    save_png_compressed(&path, &image)?;
    let _ = copy_rgba_to_clipboard(&image);

    Ok(path_str)
}

#[command]
pub fn copy_to_clipboard(path: String) -> Result<(), String> {
    let img = image::open(&path).map_err(|e| e.to_string())?.to_rgba8();
    copy_rgba_to_clipboard(&img)
}

fn copy_rgba_to_clipboard(img: &image::RgbaImage) -> Result<(), String> {
    use arboard::{Clipboard, ImageData};
    use std::borrow::Cow;
    let (w, h) = img.dimensions();
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(ImageData {
        width: w as usize,
        height: h as usize,
        bytes: Cow::Borrowed(img.as_raw()),
    })
    .map_err(|e| e.to_string())
}
