use std::{fs, path::PathBuf};

use tauri::{command, AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

/// Marker file in the app's config dir whose presence means "we have already
/// applied the first-launch autostart default". Lets us flip autostart on for
/// brand-new installs without ever stomping on a user who has explicitly
/// disabled it later.
fn first_launch_marker(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("autostart-initialized"))
}

pub fn ensure_default_enabled(app: &AppHandle) {
    let Some(marker) = first_launch_marker(app) else {
        return;
    };
    if marker.exists() {
        return;
    }

    let manager = app.autolaunch();
    if let Err(err) = manager.enable() {
        eprintln!("[autostart] initial enable failed: {err}");
        // Even on failure we still write the marker so we don't pester the
        // user's registry on every cold start — the toggle in settings is
        // the recovery path.
    }
    if let Err(err) = fs::write(&marker, "1") {
        eprintln!("[autostart] marker write failed: {err}");
    }
}

#[command]
pub fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    // Mark first-launch as resolved so the next cold boot doesn't reapply
    // the default and undo the user's choice.
    if let Some(marker) = first_launch_marker(&app) {
        let _ = fs::write(marker, "1");
    }
    manager.is_enabled().map_err(|e| e.to_string())
}
