use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use tauri::{command, AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::window;

const DEFAULT_CAPTURE_HOTKEY: &str = "Ctrl+Shift+2";

static ACTIVE_CAPTURE_SHORTCUT: OnceLock<Mutex<Option<Shortcut>>> = OnceLock::new();
static ACTIVE_CAPTURE_SPEC: OnceLock<Mutex<String>> = OnceLock::new();

fn active_shortcut() -> &'static Mutex<Option<Shortcut>> {
    ACTIVE_CAPTURE_SHORTCUT.get_or_init(|| Mutex::new(None))
}

fn active_spec() -> &'static Mutex<String> {
    ACTIVE_CAPTURE_SPEC.get_or_init(|| Mutex::new(DEFAULT_CAPTURE_HOTKEY.to_string()))
}

fn hotkey_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("capture-hotkey.txt"))
}

fn read_saved_hotkey(app: &AppHandle) -> String {
    hotkey_config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CAPTURE_HOTKEY.to_string())
}

fn save_hotkey(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let path = hotkey_config_path(app)?;
    fs::write(path, shortcut).map_err(|e| e.to_string())
}

fn parse_shortcut(shortcut: &str) -> Result<Shortcut, String> {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return Err("Shortcut cannot be empty".into());
    }
    trimmed.parse::<Shortcut>().map_err(|e| e.to_string())
}

fn register_capture_shortcut(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, _event| {
            if window::has_visible_preview_thumbnail(&app_handle) {
                return;
            }
            if let Err(e) = window::show_overlay(&app_handle) {
                eprintln!("Failed to show overlay: {e}");
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn set_capture_hotkey_inner(app: &AppHandle, shortcut: &str, persist: bool) -> Result<String, String> {
    let parsed = parse_shortcut(shortcut)?;

    if let Some(previous) = active_shortcut().lock().map_err(|e| e.to_string())?.take() {
        let _ = app.global_shortcut().unregister(previous);
    }

    register_capture_shortcut(app, parsed)?;
    *active_shortcut().lock().map_err(|e| e.to_string())? = Some(parsed);

    let normalized = shortcut.trim().to_string();
    *active_spec().lock().map_err(|e| e.to_string())? = normalized.clone();
    if persist {
        save_hotkey(app, &normalized)?;
    }
    Ok(normalized)
}

pub fn register_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let saved = read_saved_hotkey(app);
    set_capture_hotkey_inner(app, &saved, false)
        .or_else(|_| set_capture_hotkey_inner(app, DEFAULT_CAPTURE_HOTKEY, false))?;
    Ok(())
}

#[command]
pub fn get_capture_hotkey() -> Result<String, String> {
    Ok(active_spec().lock().map_err(|e| e.to_string())?.clone())
}

#[command]
pub fn set_capture_hotkey(app: AppHandle, shortcut: String) -> Result<String, String> {
    set_capture_hotkey_inner(&app, &shortcut, true)
}

#[command]
pub fn reset_capture_hotkey(app: AppHandle) -> Result<String, String> {
    set_capture_hotkey_inner(&app, DEFAULT_CAPTURE_HOTKEY, true)
}
