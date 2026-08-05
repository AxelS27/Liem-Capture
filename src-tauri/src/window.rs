use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const THUMBNAIL_DISMISS_MS: u64 = 8_000;

/// Toggle WDA_EXCLUDEFROMCAPTURE on every visible overlay/thumbnail/preview
/// window so they remain visible to the user but are skipped by the system
/// capture pipeline (BitBlt, PrintWindow, Windows.Graphics.Capture). Returns
/// the labels that were excluded so the caller can restore them afterward.
///
/// Setting the affinity only for the duration of a capture — instead of
/// permanently at window creation — avoids the DWM compositing artifacts that
/// appear when a transparent webview is permanently marked excluded.
pub fn hide_chrome_for_capture(app: &AppHandle) -> Vec<String> {
    let mut toggled = Vec::new();
    let mut candidates: Vec<String> = (0..5).map(|index| format!("thumbnail-{index}")).collect();
    candidates.push("preview-transition".to_string());

    for label in candidates {
        if let Some(win) = app.get_webview_window(&label) {
            if win.is_visible().unwrap_or(false) {
                if set_capture_affinity(&win, true) {
                    toggled.push(label);
                }
            }
        }
    }

    toggled
}

/// Restore WDA_NONE on every window previously excluded via
/// `hide_chrome_for_capture`.
pub fn restore_chrome_after_capture(app: &AppHandle, labels: Vec<String>) {
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            set_capture_affinity(&win, false);
        }
    }
}

#[cfg(target_os = "windows")]
fn set_capture_affinity(win: &tauri::WebviewWindow, exclude: bool) -> bool {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE},
    };

    let Ok(hwnd) = win.hwnd() else { return false };
    let hwnd = HWND(hwnd.0 as _);
    let affinity = if exclude {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    unsafe { SetWindowDisplayAffinity(hwnd, affinity).is_ok() }
}

#[cfg(not(target_os = "windows"))]
fn set_capture_affinity(_win: &tauri::WebviewWindow, _exclude: bool) -> bool {
    false
}
const THUMBNAIL_W: f64 = 300.0;
const THUMBNAIL_H: f64 = 200.0;
const PREVIEW_MAX_W: f64 = 920.0;
const PREVIEW_MAX_H: f64 = 620.0;
const PREVIEW_TRANSITION_MS: u32 = 360;

/// Signals the Escape-polling thread to stop.
static ESC_POLL: AtomicBool = AtomicBool::new(false);
static THUMBNAIL_HIDE_TOKENS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static THUMBNAIL_ACTIVE_ORDER: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static THUMBNAIL_PINNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static THUMBNAIL_POSITIONS: OnceLock<Mutex<HashMap<String, (f64, f64)>>> = OnceLock::new();
static THUMBNAIL_TIMERS: OnceLock<Mutex<HashMap<String, ThumbnailTimer>>> = OnceLock::new();
static THUMBNAIL_REFLOW_TOKEN: AtomicU64 = AtomicU64::new(0);
static THUMBNAIL_PREVIEWING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Copy)]
struct ThumbnailTimer {
    token: u64,
    deadline: Instant,
    remaining: Duration,
    paused: bool,
}

#[derive(Clone, serde::Serialize)]
struct TransitionRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, serde::Serialize)]
struct PreviewTransitionPayload {
    image: String,
    source: TransitionRect,
    target: TransitionRect,
    #[serde(rename = "durationMs")]
    duration_ms: u32,
}

#[derive(serde::Serialize)]
pub struct PreviewTransitionStart {
    #[serde(rename = "durationMs")]
    duration_ms: u32,
}

fn thumbnail_hide_tokens() -> &'static Mutex<HashMap<String, u64>> {
    THUMBNAIL_HIDE_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thumbnail_active_order() -> &'static Mutex<Vec<String>> {
    THUMBNAIL_ACTIVE_ORDER.get_or_init(|| Mutex::new(Vec::new()))
}

fn thumbnail_pinned() -> &'static Mutex<HashSet<String>> {
    THUMBNAIL_PINNED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn thumbnail_positions() -> &'static Mutex<HashMap<String, (f64, f64)>> {
    THUMBNAIL_POSITIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thumbnail_timers() -> &'static Mutex<HashMap<String, ThumbnailTimer>> {
    THUMBNAIL_TIMERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thumbnail_previewing() -> &'static Mutex<HashSet<String>> {
    THUMBNAIL_PREVIEWING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn has_previewing_thumbnail() -> bool {
    thumbnail_previewing()
        .lock()
        .map(|previewing| !previewing.is_empty())
        .unwrap_or(false)
}

pub fn has_visible_preview_thumbnail(app: &AppHandle) -> bool {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let max_thumbnail_w = (THUMBNAIL_W + 24.0) * scale;
    let max_thumbnail_h = (THUMBNAIL_H + 24.0) * scale;

    (0..5).any(|index| {
        let label = format!("thumbnail-{index}");
        let Some(win) = app.get_webview_window(&label) else {
            return false;
        };
        if !win.is_visible().unwrap_or(false) {
            return false;
        }
        let Ok(size) = win.outer_size() else {
            return false;
        };
        size.width as f64 > max_thumbnail_w || size.height as f64 > max_thumbnail_h
    })
}

fn thumbnail_index_from_label(label: &str) -> Option<u32> {
    label.strip_prefix("thumbnail-")?.parse().ok()
}

pub fn reserve_thumbnail_index() -> u32 {
    let Ok(mut active_order) = thumbnail_active_order().lock() else {
        return 0;
    };
    let pinned = thumbnail_pinned()
        .lock()
        .map(|pinned| pinned.clone())
        .unwrap_or_default();

    for index in 0..5 {
        let label = format!("thumbnail-{index}");
        if !pinned.contains(&label) && !active_order.iter().any(|active| active == &label) {
            active_order.push(label);
            return index;
        }
    }

    if let Some(position) = active_order
        .iter()
        .position(|label| !pinned.contains(label))
    {
        let label = active_order.remove(position);
        let index = thumbnail_index_from_label(&label).unwrap_or(0);
        active_order.push(label);
        return index;
    }

    0
}

pub fn release_thumbnail_index(index: u32) {
    let label = format!("thumbnail-{index}");
    mark_thumbnail_inactive(&label);
}

fn mark_thumbnail_active(label: &str) {
    if let Ok(mut active_order) = thumbnail_active_order().lock() {
        if !active_order.iter().any(|active| active == label) {
            active_order.push(label.to_string());
        }
    }
}

fn mark_thumbnail_inactive(label: &str) -> bool {
    crate::capture::remove_thumbnail_payload(label);
    if let Ok(mut pinned) = thumbnail_pinned().lock() {
        pinned.remove(label);
    }
    if let Ok(mut previewing) = thumbnail_previewing().lock() {
        previewing.remove(label);
    }

    if let Ok(mut active_order) = thumbnail_active_order().lock() {
        if let Some(index) = active_order.iter().position(|active| active == label) {
            active_order.remove(index);
            return true;
        }
    }

    false
}

fn thumbnail_stack_index(label: &str) -> Option<u32> {
    thumbnail_active_order()
        .lock()
        .ok()
        .and_then(|active_order| active_order.iter().position(|active| active == label))
        .map(|index| index as u32)
}

fn active_thumbnail_labels() -> Vec<String> {
    thumbnail_active_order()
        .lock()
        .map(|active_order| active_order.clone())
        .unwrap_or_default()
}

fn record_thumbnail_position(label: &str, x: f64, y: f64) {
    if let Ok(mut positions) = thumbnail_positions().lock() {
        positions.insert(label.to_string(), (x, y));
    }
}

fn remembered_thumbnail_position(label: &str) -> Option<(f64, f64)> {
    thumbnail_positions()
        .lock()
        .ok()
        .and_then(|positions| positions.get(label).copied())
}

fn set_thumbnail_position(app: &AppHandle, label: &str, x: f64, y: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    }
    record_thumbnail_position(label, x, y);
}

fn set_thumbnail_frame(app: &AppHandle, label: &str, x: f64, y: f64, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: w,
            height: h,
        }));
    }
    record_thumbnail_position(label, x, y);
}

fn ease_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn animate_thumbnail_frame(
    app: AppHandle,
    label: String,
    start: (f64, f64, f64, f64),
    target: (f64, f64, f64, f64),
) {
    std::thread::spawn(move || {
        let duration = Duration::from_millis(280);
        let started = Instant::now();

        loop {
            let elapsed = started.elapsed();
            let t = ease_out_cubic(elapsed.as_secs_f64() / duration.as_secs_f64());
            let x = start.0 + ((target.0 - start.0) * t);
            let y = start.1 + ((target.1 - start.1) * t);
            let w = start.2 + ((target.2 - start.2) * t);
            let h = start.3 + ((target.3 - start.3) * t);
            set_thumbnail_frame(&app, &label, x, y, w, h);

            if elapsed >= duration {
                break;
            }

            std::thread::sleep(Duration::from_millis(8));
        }

        set_thumbnail_frame(&app, &label, target.0, target.1, target.2, target.3);
    });
}

fn reflow_thumbnails(app: &AppHandle, animate: bool) {
    let labels = active_thumbnail_labels();
    let targets = labels
        .iter()
        .enumerate()
        .filter_map(|(stack_index, label)| {
            let target = thumbnail_position(app, stack_index as u32).ok()?;
            let start = remembered_thumbnail_position(label).unwrap_or(target);
            Some((label.clone(), start, target))
        })
        .collect::<Vec<_>>();

    // Tell every active thumbnail: "you are about to be moved, ignore the
    // next synthetic mouseenter/mouseleave for a short window." Without this
    // the browser fires a fake hover event whenever a thumbnail's window
    // slides under (or out from under) a stationary cursor, which freezes
    // the timer on a thumbnail the user never actually interacted with.
    if let Some(first) = labels.first() {
        if let Some(win) = app.get_webview_window(first) {
            let _ = win.emit("liem-thumbnail-reflow", ());
        }
    }

    let token = THUMBNAIL_REFLOW_TOKEN.fetch_add(1, Ordering::Relaxed) + 1;

    if !animate {
        for (label, _, (x, y)) in targets {
            set_thumbnail_position(app, &label, x, y);
        }
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let duration = Duration::from_millis(240);
        let started = Instant::now();

        loop {
            if THUMBNAIL_REFLOW_TOKEN.load(Ordering::Relaxed) != token {
                return;
            }

            let elapsed = started.elapsed();
            let t = ease_out_cubic(elapsed.as_secs_f64() / duration.as_secs_f64());

            for (label, (sx, sy), (tx, ty)) in &targets {
                let x = sx + ((tx - sx) * t);
                let y = sy + ((ty - sy) * t);
                set_thumbnail_position(&app, label, x, y);
            }

            if elapsed >= duration {
                break;
            }

            std::thread::sleep(Duration::from_millis(8));
        }

        for (label, _, (x, y)) in targets {
            set_thumbnail_position(&app, &label, x, y);
        }
    });
}

fn raise_active_thumbnails(app: &AppHandle) {
    for label in active_thumbnail_labels() {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_always_on_top(true);
            let _ = win.show();
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::{
                    Foundation::HWND,
                    UI::WindowsAndMessaging::{
                        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
                        SWP_SHOWWINDOW,
                    },
                };

                if let Ok(hwnd) = win.hwnd() {
                    let hwnd = HWND(hwnd.0 as _);
                    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW;
                    let _ = unsafe { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) };
                }
            }
        }
    }
}

fn start_thumbnail_timer(label: &str, token: u64) {
    start_thumbnail_timer_for(label, token, Duration::from_millis(THUMBNAIL_DISMISS_MS));
}

fn start_thumbnail_timer_for(label: &str, token: u64, duration: Duration) {
    if let Ok(mut timers) = thumbnail_timers().lock() {
        timers.insert(
            label.to_string(),
            ThumbnailTimer {
                token,
                deadline: Instant::now() + duration,
                remaining: duration,
                paused: false,
            },
        );
    }
}

fn cancel_thumbnail_timer(label: &str) {
    if let Ok(mut timers) = thumbnail_timers().lock() {
        timers.remove(label);
    }
}

fn mark_thumbnail_pinned(label: &str) {
    if let Ok(mut pinned) = thumbnail_pinned().lock() {
        pinned.insert(label.to_string());
    }
}

fn mark_thumbnail_unpinned(label: &str) {
    if let Ok(mut pinned) = thumbnail_pinned().lock() {
        pinned.remove(label);
    }
}

fn is_thumbnail_pinned(label: &str) -> bool {
    thumbnail_pinned()
        .lock()
        .map(|pinned| pinned.contains(label))
        .unwrap_or(false)
}

pub fn pause_thumbnail_timers(app: &AppHandle) {
    let labels = active_thumbnail_labels();
    let now = Instant::now();

    if let Ok(mut timers) = thumbnail_timers().lock() {
        for label in &labels {
            if let Some(timer) = timers.get_mut(label) {
                if !timer.paused {
                    timer.remaining = timer.deadline.saturating_duration_since(now);
                    timer.paused = true;
                }
            }
        }
    }

    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.emit("liem-thumbnail-pause", ());
        }
    }
}

pub fn resume_thumbnail_timers(app: &AppHandle) {
    if has_previewing_thumbnail() {
        return;
    }

    let labels = active_thumbnail_labels();
    let now = Instant::now();
    // Collect each label's authoritative remaining ms so we can ship it as
    // the event payload — JS uses this instead of guessing from its own clock,
    // which avoids drift if the IPC event lands later than the new thumbnail's
    // eval (the cause of "B finishes before A" when both are in flight).
    let mut payloads: HashMap<String, u64> = HashMap::new();

    if let Ok(mut timers) = thumbnail_timers().lock() {
        for label in &labels {
            if let Some(timer) = timers.get_mut(label) {
                if timer.paused {
                    timer.deadline = now + timer.remaining;
                    timer.paused = false;
                }
                payloads.insert(
                    label.clone(),
                    timer.deadline.saturating_duration_since(now).as_millis() as u64,
                );
            }
        }
    }

    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let remaining = payloads.get(&label).copied();
            let _ = win.emit("liem-thumbnail-resume", remaining);
        }
    }
}

fn next_thumbnail_hide_token(label: &str) -> u64 {
    let Ok(mut tokens) = thumbnail_hide_tokens().lock() else {
        return 0;
    };

    let token = tokens.entry(label.to_string()).or_insert(0);
    *token = token.saturating_add(1);
    *token
}

fn thumbnail_hide_token_matches(label: &str, token: u64) -> bool {
    thumbnail_hide_tokens()
        .lock()
        .ok()
        .and_then(|tokens| tokens.get(label).copied())
        .is_some_and(|current| current == token)
}

pub fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("overlay").is_some() {
        return Ok(());
    }

    let (w, h, mx, my) = match app.primary_monitor()? {
        Some(m) => {
            let scale = m.scale_factor();
            (
                m.size().width as f64 / scale,
                m.size().height as f64 / scale,
                m.position().x as f64 / scale,
                m.position().y as f64 / scale,
            )
        }
        None => (1920.0, 1080.0, 0.0, 0.0),
    };

    let overlay = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("/#/overlay".into()))
        .title("Liem Capture Overlay")
        .inner_size(w, h)
        .position(mx, my)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .disable_drag_drop_handler()
        .build()?;

    #[cfg(debug_assertions)]
    overlay.open_devtools();

    Ok(())
}

const DRAG_CANCEL_W: f64 = 380.0;
const DRAG_CANCEL_H: f64 = 110.0;
const DRAG_CANCEL_BOTTOM_MARGIN: f64 = 56.0;

fn drag_cancel_position(app: &AppHandle) -> tauri::Result<(f64, f64)> {
    let (sw, sh, mx, my) = overlay_bounds(app)?;
    let x = mx + ((sw - DRAG_CANCEL_W) / 2.0);
    let y = my + sh - DRAG_CANCEL_H - DRAG_CANCEL_BOTTOM_MARGIN;
    Ok((x, y))
}

pub fn create_drag_cancel(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("drag-cancel").is_some() {
        return Ok(());
    }

    // A small always-on-top click-through window centered at the bottom of
    // the primary monitor. Shows a "Drop here to cancel" pill while a
    // gallery drag is active. It is intentionally pointer-events: none so
    // it never accepts the drop itself — dropping on it (or anywhere not
    // handled by a real app) is treated as a cancel by the OS, and we then
    // re-show the selector overlay.
    let (x, y) = drag_cancel_position(app)?;
    WebviewWindowBuilder::new(
        app,
        "drag-cancel",
        WebviewUrl::App("windows/drag-cancel.html".into()),
    )
    .title("")
    .inner_size(DRAG_CANCEL_W, DRAG_CANCEL_H)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .disable_drag_drop_handler()
    .build()?;

    Ok(())
}

#[command]
pub fn show_drag_cancel_target(app: AppHandle) -> Result<(), String> {
    create_drag_cancel(&app).map_err(|e| e.to_string())?;
    if let Some(win) = app.get_webview_window("drag-cancel") {
        // Re-anchor at center-bottom of the primary monitor in case the
        // monitor layout changed since the window was created.
        if let Ok((x, y)) = drag_cancel_position(&app) {
            let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: DRAG_CANCEL_W,
                height: DRAG_CANCEL_H,
            }));
            let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        win.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub fn hide_drag_cancel_target(app: AppHandle) {
    if let Some(win) = app.get_webview_window("drag-cancel") {
        let _ = win.hide();
    }
}

/// Command wrapper around `show_overlay`. Used by the gallery drag flow to
/// bring the selector back when a drag is cancelled.
#[command]
pub fn show_overlay_again(app: AppHandle) -> Result<(), String> {
    show_overlay(&app).map_err(|e| e.to_string())
}

pub fn create_preview_transition(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("preview-transition").is_some() {
        return Ok(());
    }

    let (w, h, mx, my) = overlay_bounds(app)?;
    WebviewWindowBuilder::new(
        app,
        "preview-transition",
        WebviewUrl::App("windows/preview-transition.html".into()),
    )
    .title("")
    .inner_size(w, h)
    .position(mx, my)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .disable_drag_drop_handler()
    .build()?;

    Ok(())
}

fn overlay_bounds(app: &AppHandle) -> tauri::Result<(f64, f64, f64, f64)> {
    let bounds = match app.primary_monitor()? {
        Some(m) => {
            let scale = m.scale_factor();
            (
                m.size().width as f64 / scale,
                m.size().height as f64 / scale,
                m.position().x as f64 / scale,
                m.position().y as f64 / scale,
            )
        }
        None => (1920.0, 1080.0, 0.0, 0.0),
    };

    Ok(bounds)
}

pub fn show_overlay(app: &AppHandle) -> tauri::Result<()> {
    use tauri::Emitter;

    let previewing_busy = thumbnail_previewing()
        .lock()
        .map(|previewing| !previewing.is_empty())
        .unwrap_or(false);
    let preview_visible = has_visible_preview_thumbnail(app);
    if previewing_busy || preview_visible {
        eprintln!(
            "[show_overlay] suppressed: previewing_busy={previewing_busy} preview_visible={preview_visible}"
        );
        return Ok(());
    }

    let win = match app.get_webview_window("overlay") {
        Some(w) => w,
        None => {
            create_overlay(app)?;
            app.get_webview_window("overlay")
                .ok_or(tauri::Error::WindowNotFound)?
        }
    };

    let (w, h, mx, my) = overlay_bounds(app)?;
    win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
        x: mx,
        y: my,
    }))?;
    win.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: w,
        height: h,
    }))?;
    win.set_resizable(false)?;
    win.show()?;
    win.set_focus()?;
    let _ = win.emit("reset-overlay", ());
    raise_active_thumbnails(app);
    pause_thumbnail_timers(app);

    // Spawn a lightweight polling thread to detect Escape without needing a
    // global hotkey registration (bare Escape can't be registered on Windows).
    // Use an atomic swap guard to prevent spawning duplicate polling threads.
    if !ESC_POLL.swap(true, Ordering::SeqCst) {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            #[cfg(target_os = "windows")]
            unsafe {
                use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
                const VK_ESCAPE: i32 = 0x1B;

                while ESC_POLL.load(Ordering::Relaxed) {
                    // High bit set = key is currently held down
                    if GetAsyncKeyState(VK_ESCAPE) < 0 {
                        ESC_POLL.store(false, Ordering::Relaxed);
                        if let Some(win) = app_clone.get_webview_window("overlay") {
                            let _ = win.emit("close-overlay", ());
                        }
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(16));
                }
            }
        });
    }

    Ok(())
}

fn hide_overlay_impl(app: &AppHandle, resume_timers: bool, resync_hotkey: bool) {
    ESC_POLL.store(false, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    // Flush the global hotkey hook's combo state. Without this, a latched
    // main key (held while the user pressed Escape) or a stuck `triggered`
    // flag would silently swallow the next combo press — the symptom being
    // "I had to press Ctrl+C+F twice after Esc before the overlay came back."
    //
    // On the capture path we pass resync=true so the hook re-reads which
    // combo modifiers are still physically held. Otherwise, finishing a
    // capture while still holding (say) Ctrl would leave the hook blind to
    // that Ctrl, and the next combo attempt would need a full re-press —
    // the "have to press Ctrl+Shift+2 twice after a screenshot" bug.
    crate::hotkey::clear_combo_state(resync_hotkey);
    if resume_timers {
        resume_thumbnail_timers(app);
    }
}

/// Called from JS after crop selection or mode cancel.
#[command]
pub fn hide_overlay(app: AppHandle) {
    hide_overlay_impl(&app, true, false);
}

#[command]
pub fn hide_overlay_for_capture(app: AppHandle) {
    hide_overlay_impl(&app, false, true);
}

fn hide_thumbnail_impl(app: &AppHandle, label: &str) {
    let was_active = mark_thumbnail_inactive(label);
    cancel_thumbnail_timer(label);
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.hide();
    }
    if was_active {
        reflow_thumbnails(app, true);
    }
}

#[command]
pub fn hide_thumbnail(app: AppHandle, label: String) {
    let _ = next_thumbnail_hide_token(&label);
    hide_thumbnail_impl(&app, &label);
}

#[command]
pub fn set_thumbnail_preview_mode(app: AppHandle, label: String, active: bool) {
    let should_resume = thumbnail_previewing()
        .lock()
        .map(|mut previewing| {
            if active {
                previewing.insert(label);
                false
            } else {
                previewing.remove(&label);
                previewing.is_empty()
            }
        })
        .unwrap_or(!active);

    if active {
        pause_thumbnail_timers(&app);
    } else if should_resume {
        resume_thumbnail_timers(&app);
    }
}

#[command]
pub fn start_window_drag(app: AppHandle, label: String) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window not found: {label}"))?;
    win.start_dragging().map_err(|e| e.to_string())
}

#[command]
pub fn move_thumbnail_window_by(
    app: AppHandle,
    label: String,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    let (x, y) = remembered_thumbnail_position(&label).unwrap_or((40.0, 40.0));
    set_thumbnail_position(&app, &label, x + delta_x, y + delta_y);
    Ok(())
}

#[command]
pub fn start_thumbnail_preview_transition(
    app: AppHandle,
    label: String,
    image: String,
) -> Result<PreviewTransitionStart, String> {
    create_preview_transition(&app).map_err(|e| e.to_string())?;

    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No primary monitor found".to_string())?;
    let scale = monitor.scale_factor();
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;
    let mx = monitor.position().x as f64 / scale;
    let my = monitor.position().y as f64 / scale;
    let w = PREVIEW_MAX_W.min(sw - 96.0).max(THUMBNAIL_W);
    let h = PREVIEW_MAX_H.min(sh - 96.0).max(THUMBNAIL_H);
    let tx = mx + ((sw - w) / 2.0);
    let ty = my + ((sh - h) / 2.0);

    let (sx, sy, source_w, source_h) = app
        .get_webview_window(&label)
        .and_then(|win| {
            let pos = win.outer_position().ok()?;
            let size = win.outer_size().ok()?;
            Some((
                pos.x as f64 / scale,
                pos.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale,
            ))
        })
        .unwrap_or_else(|| {
            let (x, y) = remembered_thumbnail_position(&label).unwrap_or((mx + sw, my + sh));
            (x, y, THUMBNAIL_W, THUMBNAIL_H)
        });

    let transition = app
        .get_webview_window("preview-transition")
        .ok_or_else(|| "Preview transition window unavailable".to_string())?;

    let _ = transition.set_position(tauri::Position::Logical(tauri::LogicalPosition {
        x: mx,
        y: my,
    }));
    let _ = transition.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: sw,
        height: sh,
    }));
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.eval("window.__LIEM_CONCEAL_THUMBNAIL && window.__LIEM_CONCEAL_THUMBNAIL();");
    }
    transition.show().map_err(|e| e.to_string())?;
    let _ = transition.emit(
        "liem-preview-transition",
        PreviewTransitionPayload {
            image,
            source: TransitionRect {
                x: sx - mx,
                y: sy - my,
                w: source_w,
                h: source_h,
            },
            target: TransitionRect {
                x: tx - mx,
                y: ty - my,
                w,
                h,
            },
            duration_ms: PREVIEW_TRANSITION_MS,
        },
    );

    Ok(PreviewTransitionStart {
        duration_ms: PREVIEW_TRANSITION_MS,
    })
}

#[command]
pub fn hide_preview_transition(app: AppHandle) {
    if let Some(win) = app.get_webview_window("preview-transition") {
        let _ = win.emit("liem-preview-transition-hide", ());
        let win = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let _ = win.hide();
        });
    }
}

#[command]
pub fn expand_thumbnail_preview(app: AppHandle, label: String) -> Result<(), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No primary monitor found".to_string())?;
    let scale = monitor.scale_factor();
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;
    let mx = monitor.position().x as f64 / scale;
    let my = monitor.position().y as f64 / scale;
    let w = PREVIEW_MAX_W.min(sw - 96.0).max(THUMBNAIL_W);
    let h = PREVIEW_MAX_H.min(sh - 96.0).max(THUMBNAIL_H);
    let tx = mx + ((sw - w) / 2.0);
    let ty = my + ((sh - h) / 2.0);

    cancel_thumbnail_timer(&label);
    set_thumbnail_frame(&app, &label, tx, ty, w, h);
    Ok(())
}

#[command]
pub fn collapse_thumbnail_preview(app: AppHandle, label: String, remaining_ms: u64) {
    let stack_index = thumbnail_stack_index(&label)
        .unwrap_or_else(|| thumbnail_index_from_label(&label).unwrap_or(0));
    let target = thumbnail_position(&app, stack_index).unwrap_or((40.0, 40.0));

    if let Some(win) = app.get_webview_window(&label) {
        let Ok(pos) = win.outer_position() else {
            set_thumbnail_frame(&app, &label, target.0, target.1, THUMBNAIL_W, THUMBNAIL_H);
            return;
        };
        let Ok(size) = win.outer_size() else {
            set_thumbnail_frame(&app, &label, target.0, target.1, THUMBNAIL_W, THUMBNAIL_H);
            return;
        };

        let scale = app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        let sx = pos.x as f64 / scale;
        let sy = pos.y as f64 / scale;
        let sw = size.width as f64 / scale;
        let sh = size.height as f64 / scale;
        animate_thumbnail_frame(
            app.clone(),
            label.clone(),
            (sx, sy, sw, sh),
            (target.0, target.1, THUMBNAIL_W, THUMBNAIL_H),
        );
    }

    record_thumbnail_position(&label, target.0, target.1);
    if !is_thumbnail_pinned(&label) {
        let token = next_thumbnail_hide_token(&label);
        start_thumbnail_timer_for(
            &label,
            token,
            Duration::from_millis(remaining_ms.clamp(1, THUMBNAIL_DISMISS_MS)),
        );
        schedule_thumbnail_hide(&app, &label, token);
    }
}

#[command]
pub fn pin_thumbnail(label: String) {
    let _ = next_thumbnail_hide_token(&label);
    mark_thumbnail_pinned(&label);
    cancel_thumbnail_timer(&label);
}

#[command]
pub fn unpin_thumbnail(app: AppHandle, label: String, remaining_ms: u64) {
    mark_thumbnail_unpinned(&label);
    let token = next_thumbnail_hide_token(&label);
    start_thumbnail_timer_for(
        &label,
        token,
        Duration::from_millis(remaining_ms.clamp(1, THUMBNAIL_DISMISS_MS)),
    );
    schedule_thumbnail_hide(&app, &label, token);
}

fn schedule_thumbnail_hide(app: &AppHandle, label: &str, token: u64) {
    let app = app.clone();
    let label = label.to_string();

    std::thread::spawn(move || loop {
        let sleep_for = {
            let Ok(timers) = thumbnail_timers().lock() else {
                return;
            };
            let Some(timer) = timers.get(&label) else {
                return;
            };

            if timer.token != token || !thumbnail_hide_token_matches(&label, token) {
                return;
            }

            if timer.paused {
                Duration::from_millis(80)
            } else {
                let remaining = timer.deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    drop(timers);
                    // Delegate to JS so the dismiss animation plays. JS then
                    // invokes `hide_thumbnail`, which performs the native
                    // window.hide() and final cleanup. We cancel the timer
                    // here so this thread does not loop again before JS
                    // responds. If the window is missing (JS dead/unloaded)
                    // we still fall back to a direct hide.
                    cancel_thumbnail_timer(&label);
                    if let Some(win) = app.get_webview_window(&label) {
                        // emit() in Tauri v2 broadcasts to every webview, so
                        // include the label in the payload and let each
                        // thumbnail's JS filter by `currentWindow.label`.
                        // Otherwise every thumbnail dismisses together when
                        // any one of them times out.
                        if win.emit("liem-thumbnail-auto-dismiss", &label).is_ok() {
                            return;
                        }
                    }
                    hide_thumbnail_impl(&app, &label);
                    return;
                }
                remaining.min(Duration::from_millis(80))
            }
        };

        std::thread::sleep(sleep_for);
    });
}

pub fn create_thumbnail_pool(app: &AppHandle) -> tauri::Result<()> {
    for index in 0..5 {
        ensure_thumbnail(app, index)?;
    }
    Ok(())
}

fn thumbnail_position(app: &AppHandle, index: u32) -> tauri::Result<(f64, f64)> {
    let pos = match app.primary_monitor()? {
        Some(monitor) => {
            let scale = monitor.scale_factor();
            let sw = monitor.size().width as f64 / scale;
            let sh = monitor.size().height as f64 / scale;
            let margin = 20.0;
            let taskbar_clearance = 28.0;
            let stack_offset = (index as f64) * (THUMBNAIL_H + 8.0);
            (
                sw - THUMBNAIL_W - margin,
                sh - THUMBNAIL_H - margin - taskbar_clearance - stack_offset,
            )
        }
        None => (40.0, 40.0),
    };

    Ok(pos)
}

fn ensure_thumbnail(app: &AppHandle, index: u32) -> tauri::Result<()> {
    let label = format!("thumbnail-{index}");

    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }

    let url = "windows/thumbnail.html";
    let (x, y) = thumbnail_position(app, index)?;
    record_thumbnail_position(&label, x, y);

    let _win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("")
        .inner_size(THUMBNAIL_W, THUMBNAIL_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .disable_drag_drop_handler()
        .build()?;

    // Intentionally NOT auto-opening DevTools here. WebView2 + open
    // DevTools paints a viewport-size badge in the top-right corner on
    // every resize — and the thumbnail window resizes a lot (preview
    // morph in/out, animated reflows). That badge briefly covers our
    // Close / Minimize buttons and is the main UX gripe in dev. Use
    // right-click → Inspect (or Rust-side dbg!) when you need to peek.

    Ok(())
}

pub fn show_thumbnail(
    app: &AppHandle,
    index: u32,
    payload: &impl serde::Serialize,
) -> tauri::Result<()> {
    ensure_thumbnail(app, index)?;

    let label = format!("thumbnail-{index}");
    let win = app
        .get_webview_window(&label)
        .ok_or(tauri::Error::WindowNotFound)?;
    let stack_index = thumbnail_stack_index(&label).unwrap_or(index);
    let (x, y) = thumbnail_position(app, stack_index)?;

    mark_thumbnail_active(&label);
    let _ = win.eval("window.__LIEM_PREPARE_THUMBNAIL && window.__LIEM_PREPARE_THUMBNAIL();");
    set_thumbnail_frame(app, &label, x, y, THUMBNAIL_W, THUMBNAIL_H);
    let _ = win.emit("liem-thumbnail-data", payload);
    if let Ok(payload_json) = serde_json::to_string(payload) {
        let script =
            format!("window.__LIEM_SET_THUMBNAIL && window.__LIEM_SET_THUMBNAIL({payload_json});");
        let _ = win.eval(&script);
    }
    reflow_thumbnails(app, false);
    win.show()?;
    set_thumbnail_frame(app, &label, x, y, THUMBNAIL_W, THUMBNAIL_H);
    let _ = win.eval("window.__LIEM_REVEAL_THUMBNAIL && window.__LIEM_REVEAL_THUMBNAIL();");
    if !is_thumbnail_pinned(&label) {
        let token = next_thumbnail_hide_token(&label);
        start_thumbnail_timer(&label, token);
        schedule_thumbnail_hide(app, &label, token);
    }

    // Immediately resume any sibling thumbnails that were paused while the
    // overlay was open. Doing this here (instead of waiting for the
    // ThumbnailTimerPause Drop or for JS to round-trip via
    // set_thumbnail_preview_mode) puts the resume emit on the same code path
    // as the new thumbnail's eval, so the events land at the receiving JS
    // contexts within microseconds of each other and their bars stay in sync.
    resume_thumbnail_timers(app);

    Ok(())
}

/// Hover-pause: stop a single thumbnail's auto-dismiss countdown without
/// touching any other thumbnails. Called when the user mouses over the
/// thumbnail. The JS caller already updated its local progress bar, so we
/// must NOT emit a pause event back — that would cause a double-update and
/// desync the bar from the actual hide moment.
#[command]
pub fn pause_thumbnail_lifetime(label: String) {
    if is_thumbnail_pinned(&label) {
        return;
    }
    let _ = next_thumbnail_hide_token(&label);
    cancel_thumbnail_timer(&label);
}

/// Hover-leave: restart a single thumbnail's auto-dismiss countdown at the
/// full lifetime. As with `pause_thumbnail_lifetime`, the JS caller already
/// reset its local bar; emitting a restart event here would re-zero the bar
/// a few ms later and produce a visible jitter / desync.
#[command]
pub fn restart_thumbnail_lifetime(app: AppHandle, label: String) {
    if is_thumbnail_pinned(&label) {
        return;
    }
    let token = next_thumbnail_hide_token(&label);
    start_thumbnail_timer(&label, token);
    schedule_thumbnail_hide(&app, &label, token);
}
