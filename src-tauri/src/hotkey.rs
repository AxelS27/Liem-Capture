use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::window;

pub fn register_shortcuts(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Digit2);

    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, _event| {
            if window::has_visible_preview_thumbnail(&app_handle) {
                return;
            }
            if let Err(e) = window::show_overlay(&app_handle) {
                eprintln!("Failed to show overlay: {e}");
            }
        })?;

    Ok(())
}
