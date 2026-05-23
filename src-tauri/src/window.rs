use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{command, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const THUMBNAIL_DISMISS_MS: u64 = 16_000;

/// Signals the Escape-polling thread to stop.
static ESC_POLL: AtomicBool = AtomicBool::new(false);
static THUMBNAIL_HIDE_TOKENS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static THUMBNAIL_ACTIVE_ORDER: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static THUMBNAIL_PINNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static THUMBNAIL_POSITIONS: OnceLock<Mutex<HashMap<String, (f64, f64)>>> = OnceLock::new();
static THUMBNAIL_TIMERS: OnceLock<Mutex<HashMap<String, ThumbnailTimer>>> = OnceLock::new();
static THUMBNAIL_REFLOW_TOKEN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct ThumbnailTimer {
    token: u64,
    deadline: Instant,
    remaining: Duration,
    paused: bool,
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
    if let Ok(mut pinned) = thumbnail_pinned().lock() {
        pinned.remove(label);
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

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
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

    let token = THUMBNAIL_REFLOW_TOKEN.fetch_add(1, Ordering::Relaxed) + 1;

    if !animate {
        for (label, _, (x, y)) in targets {
            set_thumbnail_position(app, &label, x, y);
        }
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let frames = 12;

        for frame in 1..=frames {
            if THUMBNAIL_REFLOW_TOKEN.load(Ordering::Relaxed) != token {
                return;
            }

            let t = ease_out_cubic(frame as f64 / frames as f64);

            for (label, (sx, sy), (tx, ty)) in &targets {
                let x = sx + ((tx - sx) * t);
                let y = sy + ((ty - sy) * t);
                set_thumbnail_position(&app, label, x, y);
            }

            std::thread::sleep(Duration::from_millis(12));
        }

        for (label, _, (x, y)) in targets {
            set_thumbnail_position(&app, &label, x, y);
        }
    });
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
    let labels = active_thumbnail_labels();
    let now = Instant::now();

    if let Ok(mut timers) = thumbnail_timers().lock() {
        for label in &labels {
            if let Some(timer) = timers.get_mut(label) {
                if timer.paused {
                    timer.deadline = now + timer.remaining;
                    timer.paused = false;
                }
            }
        }
    }

    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.emit("liem-thumbnail-resume", ());
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

    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("/#/overlay".into()))
        .title("Liem Shot — Overlay")
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
    pause_thumbnail_timers(app);

    // Spawn a lightweight polling thread to detect Escape without needing a
    // global hotkey registration (bare Escape can't be registered on Windows).
    ESC_POLL.store(true, Ordering::Relaxed);
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

    Ok(())
}

fn hide_overlay_impl(app: &AppHandle) {
    ESC_POLL.store(false, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    resume_thumbnail_timers(app);
}

/// Called from JS after crop selection or mode cancel.
#[command]
pub fn hide_overlay(app: AppHandle) {
    hide_overlay_impl(&app);
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
            let thumb_w = 300.0;
            let thumb_h = 200.0;
            let stack_offset = (index as f64) * (thumb_h + 8.0);
            (
                sw - thumb_w - margin,
                sh - thumb_h - margin - taskbar_clearance - stack_offset,
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

    let url = "thumbnail.html";
    let (x, y) = thumbnail_position(app, index)?;
    record_thumbnail_position(&label, x, y);

    let _win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("")
        .inner_size(300.0, 200.0)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .disable_drag_drop_handler()
        .build()?;

    // Open DevTools in debug builds to see console errors
    #[cfg(debug_assertions)]
    _win.open_devtools();

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
    set_thumbnail_position(app, &label, x, y);
    let _ = win.emit("liem-thumbnail-data", payload);
    if let Ok(payload_json) = serde_json::to_string(payload) {
        let script =
            format!("window.__LIEM_SET_THUMBNAIL && window.__LIEM_SET_THUMBNAIL({payload_json});");
        let _ = win.eval(&script);
    }
    win.show()?;
    if !is_thumbnail_pinned(&label) {
        let token = next_thumbnail_hide_token(&label);
        start_thumbnail_timer(&label, token);
        schedule_thumbnail_hide(app, &label, token);
    }
    reflow_thumbnails(app, true);

    Ok(())
}
