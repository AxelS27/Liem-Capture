use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use tauri::{command, AppHandle, Manager};

const DEFAULT_CAPTURE_HOTKEY: &str = "Ctrl+Shift+2";

static ACTIVE_CAPTURE_SPEC: OnceLock<Mutex<String>> = OnceLock::new();
static HOTKEY_RECORDING_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
static ACTIVE_HOTKEY_TOKENS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static ACTIVE_HOTKEY_ENABLED: OnceLock<Mutex<bool>> = OnceLock::new();
static ACTIVE_HOTKEY_APP: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

fn active_spec() -> &'static Mutex<String> {
    ACTIVE_CAPTURE_SPEC.get_or_init(|| Mutex::new(DEFAULT_CAPTURE_HOTKEY.to_string()))
}

fn recording_app() -> &'static Mutex<Option<AppHandle>> {
    HOTKEY_RECORDING_APP.get_or_init(|| Mutex::new(None))
}

fn active_hotkey_tokens() -> &'static Mutex<Vec<String>> {
    ACTIVE_HOTKEY_TOKENS.get_or_init(|| Mutex::new(Vec::new()))
}

fn active_hotkey_enabled() -> &'static Mutex<bool> {
    ACTIVE_HOTKEY_ENABLED.get_or_init(|| Mutex::new(true))
}

fn active_hotkey_app() -> &'static Mutex<Option<AppHandle>> {
    ACTIVE_HOTKEY_APP.get_or_init(|| Mutex::new(None))
}

fn hotkey_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
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

fn shortcut_tokens(shortcut: &str) -> Result<Vec<String>, String> {
    let tokens: Vec<String> = shortcut
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "control" => "Ctrl".to_string(),
            "cmd" | "command" | "win" | "windows" | "meta" => "Super".to_string(),
            "ctrl" => "Ctrl".to_string(),
            "shift" => "Shift".to_string(),
            "alt" | "option" => "Alt".to_string(),
            "super" => "Super".to_string(),
            _ => part.to_string(),
        })
        .collect();
    if tokens.len() != 3 {
        return Err("Shortcut must use exactly 3 keys".into());
    }
    let unique: HashSet<&str> = tokens.iter().map(String::as_str).collect();
    if unique.len() != tokens.len() {
        return Err("Shortcut contains duplicate keys".into());
    }
    Ok(tokens)
}

fn set_capture_hotkey_inner(
    app: &AppHandle,
    shortcut: &str,
    persist: bool,
) -> Result<String, String> {
    let tokens = shortcut_tokens(shortcut)?;

    *active_hotkey_app().lock().map_err(|e| e.to_string())? = Some(app.clone());
    *active_hotkey_tokens().lock().map_err(|e| e.to_string())? = tokens;
    *active_hotkey_enabled().lock().map_err(|e| e.to_string())? = true;
    global_hotkey_hook::start()?;

    let normalized = shortcut.trim().to_string();
    *active_spec().lock().map_err(|e| e.to_string())? = normalized.clone();
    if persist {
        save_hotkey(app, &normalized)?;
    }
    // Keep the tray menu's "Open Liem Capture" entry in sync with the
    // active combo. No-op until the tray has finished building (the menu
    // item slot is populated during the setup hook).
    crate::refresh_capture_menu_label(&normalized);
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
pub fn suspend_capture_hotkey(_app: AppHandle) -> Result<(), String> {
    *active_hotkey_enabled().lock().map_err(|e| e.to_string())? = false;
    Ok(())
}

#[command]
pub fn resume_capture_hotkey(app: AppHandle) -> Result<String, String> {
    let spec = active_spec().lock().map_err(|e| e.to_string())?.clone();
    *active_hotkey_app().lock().map_err(|e| e.to_string())? = Some(app);
    *active_hotkey_tokens().lock().map_err(|e| e.to_string())? = shortcut_tokens(&spec)?;
    *active_hotkey_enabled().lock().map_err(|e| e.to_string())? = true;
    global_hotkey_hook::start()?;
    Ok(spec)
}

#[derive(Clone, serde::Serialize)]
struct SuperKeyEvent {
    down: bool,
}

#[cfg(target_os = "windows")]
mod global_hotkey_hook {
    use super::{active_hotkey_app, active_hotkey_enabled, active_hotkey_tokens};
    use crate::window;
    use std::{
        collections::HashSet,
        ffi::c_void,
        sync::{Mutex, OnceLock},
    };
    use windows::Win32::{
        Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LWIN, VK_RWIN},
            WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
            },
        },
    };

    /// Map a stored combo token (e.g. "Ctrl", "Shift", "F2", "Numpad5",
    /// "A", "7") back to a Windows VK code. Used by `clear_state(true)` to
    /// poll physical key state via `GetAsyncKeyState` so we don't lose
    /// track of modifiers the user is still holding after a capture.
    fn vk_from_token(token: &str) -> Option<u32> {
        match token {
            "Ctrl" => Some(0x11),
            "Shift" => Some(0x10),
            "Alt" => Some(0x12),
            "Super" => Some(0x5B),
            s if s.len() == 1 => {
                let c = s.chars().next()?;
                if c.is_ascii_alphabetic() {
                    Some(c.to_ascii_uppercase() as u32)
                } else if c.is_ascii_digit() {
                    Some(c as u32)
                } else {
                    None
                }
            }
            s if s.starts_with("Numpad") => s[6..]
                .parse::<u32>()
                .ok()
                .and_then(|n| if n <= 9 { Some(0x60 + n) } else { None }),
            s if s.starts_with('F') && s.len() >= 2 => s[1..]
                .parse::<u32>()
                .ok()
                .and_then(|n| if (1..=24).contains(&n) { Some(0x6F + n) } else { None }),
            _ => None,
        }
    }

    static HOOK: OnceLock<Mutex<Option<isize>>> = OnceLock::new();
    static PRESSED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    static TRIGGERED: OnceLock<Mutex<bool>> = OnceLock::new();

    fn hook_slot() -> &'static Mutex<Option<isize>> {
        HOOK.get_or_init(|| Mutex::new(None))
    }

    fn pressed() -> &'static Mutex<HashSet<String>> {
        PRESSED.get_or_init(|| Mutex::new(HashSet::new()))
    }

    fn triggered() -> &'static Mutex<bool> {
        TRIGGERED.get_or_init(|| Mutex::new(false))
    }

    fn vk_token(vk: u32) -> Option<String> {
        match vk {
            0x10 | 0xA0 | 0xA1 => Some("Shift".into()),
            0x11 | 0xA2 | 0xA3 => Some("Ctrl".into()),
            0x12 | 0xA4 | 0xA5 => Some("Alt".into()),
            0x5B | 0x5C => Some("Super".into()),
            0x30..=0x39 => char::from_u32(vk).map(|c| c.to_string()),
            0x41..=0x5A => char::from_u32(vk).map(|c| c.to_string()),
            0x60..=0x69 => Some(format!("Numpad{}", vk - 0x60)),
            0x70..=0x87 => Some(format!("F{}", vk - 0x6F)),
            _ => None,
        }
    }

    fn is_modifier(token: &str) -> bool {
        matches!(token, "Ctrl" | "Shift" | "Alt" | "Super")
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = *(lparam.0 as *const KBDLLHOOKSTRUCT);
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if down || up {
                if let Some(token) = vk_token(info.vkCode) {
                    if let Ok(mut pressed) = pressed().lock() {
                        let enabled = active_hotkey_enabled().lock().map(|v| *v).unwrap_or(false);
                        let combo = active_hotkey_tokens()
                            .lock()
                            .map(|v| v.clone())
                            .unwrap_or_default();
                        let has_pressed_combo_modifier = combo
                            .iter()
                            .any(|item| is_modifier(item) && pressed.contains(item));

                        if down {
                            pressed.insert(token.clone());
                        } else {
                            let latch_main_key = enabled
                                && !is_modifier(&token)
                                && combo.contains(&token)
                                && has_pressed_combo_modifier;
                            if !latch_main_key {
                                pressed.remove(&token);
                            }
                            if is_modifier(&token) {
                                pressed.retain(|item| is_modifier(item));
                            }
                            if pressed.is_empty() {
                                if let Ok(mut triggered) = triggered().lock() {
                                    *triggered = false;
                                }
                            }
                        }

                        if down
                            && enabled
                            && !combo.is_empty()
                            && combo.iter().all(|item| pressed.contains(item))
                        {
                            let mut should_fire = false;
                            if let Ok(mut triggered) = triggered().lock() {
                                if !*triggered {
                                    *triggered = true;
                                    should_fire = true;
                                }
                            }
                            if should_fire {
                                let app_to_show = active_hotkey_app()
                                    .lock()
                                    .ok()
                                    .and_then(|guard| guard.clone());
                                if let Some(app) = app_to_show {
                                    std::thread::spawn(move || {
                                        let app_for_ui = app.clone();
                                        let _ = app.run_on_main_thread(move || {
                                            if !window::has_visible_preview_thumbnail(&app_for_ui) {
                                                let _ = window::show_overlay(&app_for_ui);
                                            }
                                        });
                                    });
                                }
                            }
                            return LRESULT(1);
                        }

                        // Swallow only NON-modifier combo keys (e.g. "C", "F",
                        // "2") while a combo modifier is held. Without the
                        // `!is_modifier` guard the block would also eat plain
                        // Ctrl / Shift / Alt presses (because a modifier is
                        // trivially in its own combo + in `pressed`), which
                        // broke every Ctrl-shortcut in every other app and
                        // even prevented typing capital letters with Shift.
                        if enabled
                            && !is_modifier(&token)
                            && combo.iter().any(|item| is_modifier(item))
                            && combo
                                .iter()
                                .any(|item| is_modifier(item) && pressed.contains(item))
                            && combo.iter().any(|item| item == &token)
                        {
                            return LRESULT(1);
                        }

                        if enabled
                            && combo.iter().any(|item| item == "Super")
                            && (info.vkCode == VK_LWIN.0 as u32 || info.vkCode == VK_RWIN.0 as u32)
                        {
                            return LRESULT(1);
                        }
                    }
                }
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    pub fn start() -> Result<(), String> {
        let mut slot = hook_slot().lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        let hook = unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE::default(), 0)
        }
        .map_err(|e| e.to_string())?;
        *slot = Some(hook.0 as isize);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn stop() {
        if let Ok(mut slot) = hook_slot().lock() {
            if let Some(hook) = slot.take() {
                let _ = unsafe { UnhookWindowsHookEx(HHOOK(hook as *mut c_void)) };
            }
        }
    }

    /// Clear the combo latch and any latched main-key state. Called when the
    /// overlay closes so the next combo press always re-fires, regardless of
    /// what release order or missed key-up event may have left behind.
    ///
    /// `resync`: when true, after clearing we poll `GetAsyncKeyState` for the
    /// combo's MODIFIERS and re-add any that are still physically held. This
    /// fixes "have to press the hotkey twice after a capture": the capture
    /// flow clears state while the user may still be holding Ctrl/Shift, and
    /// without re-syncing the hook would no longer know that modifier is down
    /// — so the next combo attempt (just tapping the main key) silently fails
    /// the all-keys-pressed check. We deliberately do NOT re-add held *main*
    /// keys, so a user who keeps the whole combo pressed doesn't get the
    /// overlay auto-re-firing on key-repeat.
    pub fn clear_state(resync: bool) {
        let combo: Vec<String> = active_hotkey_tokens()
            .lock()
            .map(|tokens| tokens.clone())
            .unwrap_or_default();

        if let Ok(mut pressed) = pressed().lock() {
            pressed.clear();
            if resync {
                for token in &combo {
                    if !is_modifier(token) {
                        continue;
                    }
                    if let Some(vk) = vk_from_token(token) {
                        let held = unsafe { GetAsyncKeyState(vk as i32) as u32 & 0x8000 != 0 };
                        if held {
                            pressed.insert(token.clone());
                        }
                    }
                }
            }
        }
        if let Ok(mut triggered) = triggered().lock() {
            *triggered = false;
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod global_hotkey_hook {
    pub fn start() -> Result<(), String> {
        Ok(())
    }
    pub fn clear_state(_resync: bool) {}
}

/// Reset the combo state machine. Called from `hide_overlay_impl` so the
/// next hotkey press always re-fires after the overlay closes — defends
/// against the "have to press twice after Escape" symptom where a latched
/// main key or stuck `triggered` flag would silently swallow the next combo.
///
/// `resync` re-reads physical modifier state (see `clear_state`); pass it on
/// the capture path where the user is likely still holding the combo.
pub fn clear_combo_state(resync: bool) {
    global_hotkey_hook::clear_state(resync);
}

#[cfg(target_os = "windows")]
mod recording_hook {
    use super::{recording_app, SuperKeyEvent};
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};
    use tauri::Emitter;
    use windows::Win32::{
        Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM},
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN, VK_RWIN,
            },
            WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT,
                WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
            },
        },
    };

    static HOOK: OnceLock<Mutex<Option<isize>>> = OnceLock::new();

    fn hook_slot() -> &'static Mutex<Option<isize>> {
        HOOK.get_or_init(|| Mutex::new(None))
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = *(lparam.0 as *const KBDLLHOOKSTRUCT);
            let is_win = info.vkCode == VK_LWIN.0 as u32 || info.vkCode == VK_RWIN.0 as u32;
            if is_win {
                let msg = wparam.0 as u32;
                let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                if down || up {
                    let app_to_emit = recording_app().lock().ok().and_then(|guard| guard.clone());
                    if let Some(app) = app_to_emit {
                        std::thread::spawn(move || {
                            let app_for_emit = app.clone();
                            let _ = app.run_on_main_thread(move || {
                                let _ =
                                    app_for_emit.emit("liem-hotkey-super", SuperKeyEvent { down });
                            });
                        });
                    }
                }
                return LRESULT(1);
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    /// Synthesize a key-up for both Win keys via SendInput. Used when the
    /// recording hook starts / stops to guarantee Windows' own key-state
    /// machine matches reality, even if the user pressed Win+Shift+R (which
    /// Win11 captures for Snipping Tool *before* our LL hook can swallow it,
    /// leaving Win "stuck down" in OS state until the next physical press).
    fn release_win_keys() {
        unsafe {
            for vk in [VK_LWIN, VK_RWIN] {
                // Only inject the release if the OS currently believes the
                // key is held — otherwise we'd be sending phantom Win-ups
                // that could trip other shortcut layers.
                if GetAsyncKeyState(vk.0 as i32) as u32 & 0x8000 == 0 {
                    continue;
                }
                let input = INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk.0),
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
            }
        }
    }

    pub fn start() -> Result<(), String> {
        let mut slot = hook_slot().lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        let hook = unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE::default(), 0)
        }
        .map_err(|e| e.to_string())?;
        *slot = Some(hook.0 as isize);
        drop(slot);
        // Clear any leftover Win-down OS state before the user starts
        // pressing keys, so e.g. an OS-shortcut leak from a previous attempt
        // doesn't poison this recording session.
        release_win_keys();
        Ok(())
    }

    pub fn stop() {
        if let Ok(mut slot) = hook_slot().lock() {
            if let Some(hook) = slot.take() {
                let _ = unsafe { UnhookWindowsHookEx(HHOOK(hook as *mut c_void)) };
            }
        }
        // Clean up the OS Win-down state once the hook is gone. This fixes
        // "Windows menu opens in background after recording" — when the user
        // tried Win+Shift+R (Snipping Tool), Windows captured Win-down before
        // our hook, then our hook swallowed the Win-up, leaving Win stuck.
        release_win_keys();
    }
}

#[cfg(not(target_os = "windows"))]
mod recording_hook {
    pub fn start() -> Result<(), String> {
        Ok(())
    }
    pub fn stop() {}
}

#[command]
pub fn start_hotkey_recording(app: AppHandle) -> Result<(), String> {
    *recording_app().lock().map_err(|e| e.to_string())? = Some(app);
    recording_hook::start()
}

#[command]
pub fn stop_hotkey_recording() -> Result<(), String> {
    recording_hook::stop();
    *recording_app().lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[command]
pub fn reset_capture_hotkey(app: AppHandle) -> Result<String, String> {
    set_capture_hotkey_inner(&app, DEFAULT_CAPTURE_HOTKEY, true)
}
