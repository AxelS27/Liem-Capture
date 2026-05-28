use std::sync::{Mutex, OnceLock};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Wry,
};
use tauri_plugin_autostart::MacosLauncher;

mod ai;
mod autostart;
mod capture;
mod drag;
mod hotkey;
mod window;

/// The "Open Liem Capture" tray entry. Stored globally so `hotkey.rs` can
/// re-label it when the user changes the capture shortcut.
static CAPTURE_MENU_ITEM: OnceLock<Mutex<Option<MenuItem<Wry>>>> = OnceLock::new();

fn capture_menu_item_slot() -> &'static Mutex<Option<MenuItem<Wry>>> {
    CAPTURE_MENU_ITEM.get_or_init(|| Mutex::new(None))
}

fn capture_menu_label(spec: &str) -> String {
    format!("Open  ({spec})")
}

/// Called by `hotkey::set_capture_hotkey_inner` after the shortcut is saved
/// so the tray menu's first entry always shows the active combo.
pub fn refresh_capture_menu_label(spec: &str) {
    let Ok(guard) = capture_menu_item_slot().lock() else {
        return;
    };
    if let Some(item) = guard.as_ref() {
        let _ = item.set_text(capture_menu_label(spec));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance plugin: if the user double-clicks the .exe a second
        // time (or the OS auto-starts it again), the new process exits and
        // re-shows the overlay on the existing instance instead of producing
        // a duplicate tray icon and a duplicate keyboard hook.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Err(e) = window::show_overlay(app) {
                eprintln!("[single-instance] show_overlay error: {e}");
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Pre-create hidden overlay window so first show is instant
            window::create_overlay(app.handle())?;
            window::create_preview_transition(app.handle())?;
            window::create_drag_cancel(app.handle())?;
            window::create_thumbnail_pool(app.handle())?;

            // System tray — two entries only: open overlay (label syncs with
            // the active hotkey) and quit.
            let initial_spec = hotkey::get_capture_hotkey().unwrap_or_else(|_| "Ctrl+Shift+2".into());
            let capture = MenuItem::with_id(
                app,
                "capture",
                capture_menu_label(&initial_spec),
                true,
                None::<&str>,
            )?;
            if let Ok(mut slot) = capture_menu_item_slot().lock() {
                *slot = Some(capture.clone());
            }
            let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&capture, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Liem Capture")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "capture" => {
                        if let Err(e) = window::show_overlay(app) {
                            eprintln!("[tray] show_overlay error: {e}");
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Err(e) = window::show_overlay(app) {
                            eprintln!("[tray-click] show_overlay error: {e}");
                        }
                    }
                })
                .build(app)?;

            hotkey::register_shortcuts(app.handle())?;

            // First-launch policy: enable autostart by default. Subsequent
            // launches respect whatever the user toggled in settings (the
            // marker file makes this a one-shot).
            autostart::ensure_default_enabled(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::take_screenshot,
            capture::take_fullscreen,
            capture::copy_to_clipboard,
            capture::copy_image_dataurl_to_clipboard,
            capture::get_thumbnail_data,
            capture::get_image_data,
            capture::save_edited_thumbnail,
            capture::discard_unsaved_capture,
            capture::export_png_to_path,
            capture::list_gallery_items,
            capture::list_gallery_tree,
            capture::get_gallery_preview,
            capture::get_gallery_metadata,
            capture::delete_gallery_item,
            capture::open_gallery_item,
            capture::view_gallery_item,
            capture::create_gallery_folder,
            capture::rename_gallery_folder,
            capture::delete_gallery_folder,
            capture::move_gallery_item,
            capture::rename_gallery_item,
            ai::ai_upscale_image,
            ai::ai_remove_background,
            ai::ai_ocr_image,
            ai::ai_ocr_layout,
            hotkey::get_capture_hotkey,
            hotkey::set_capture_hotkey,
            hotkey::suspend_capture_hotkey,
            hotkey::resume_capture_hotkey,
            hotkey::start_hotkey_recording,
            hotkey::stop_hotkey_recording,
            hotkey::reset_capture_hotkey,
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled,
            drag::start_drag,
            window::hide_overlay,
            window::hide_overlay_for_capture,
            window::hide_thumbnail,
            window::set_thumbnail_preview_mode,
            window::start_window_drag,
            window::move_thumbnail_window_by,
            window::start_thumbnail_preview_transition,
            window::hide_preview_transition,
            window::expand_thumbnail_preview,
            window::collapse_thumbnail_preview,
            window::pin_thumbnail,
            window::unpin_thumbnail,
            window::pause_thumbnail_lifetime,
            window::restart_thumbnail_lifetime,
            window::show_drag_cancel_target,
            window::hide_drag_cancel_target,
            window::show_overlay_again,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
