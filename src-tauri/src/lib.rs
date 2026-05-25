use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

mod capture;
mod drag;
mod hotkey;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Pre-create hidden overlay window so first show is instant
            window::create_overlay(app.handle())?;
            window::create_preview_transition(app.handle())?;
            window::create_drag_cancel(app.handle())?;
            window::create_thumbnail_pool(app.handle())?;

            // System tray
            let quit = MenuItem::with_id(app, "quit", "Quit Liem Shot", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Settings", true, None::<&str>)?;
            let capture = MenuItem::with_id(
                app,
                "capture",
                "Capture  (Ctrl+Shift+2)",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&capture, &show, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Liem Shot. Capture. Drag. Done.")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "capture" => {
                        if let Err(e) = window::show_overlay(app) {
                            eprintln!("[tray] show_overlay error: {e}");
                        }
                    }
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
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
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            hotkey::register_shortcuts(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::take_screenshot,
            capture::take_fullscreen,
            capture::copy_to_clipboard,
            capture::get_thumbnail_data,
            capture::get_image_data,
            capture::save_edited_thumbnail,
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
