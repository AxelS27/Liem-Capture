use std::{
    collections::HashMap,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{command, AppHandle};
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

fn thumbnail_payloads() -> &'static Mutex<HashMap<String, ThumbnailPayload>> {
    THUMBNAIL_PAYLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn temp_dir() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push("liem-shot");
    std::fs::create_dir_all(&p).ok();
    p
}

fn save_png_fast(path: &Path, img: &image::RgbaImage) -> Result<(), String> {
    use image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ColorType, ImageEncoder,
    };

    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let writer = BufWriter::new(file);
    PngEncoder::new_with_quality(writer, CompressionType::Fast, FilterType::NoFilter)
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
pub fn take_screenshot(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let _timer_pause = ThumbnailTimerPause::new(&app);
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
    let path = temp_dir().join(format!("shot_{ts}.png"));
    save_png_fast(&path, &cropped)?;

    let path_str = path.to_string_lossy().to_string();
    let idx = window::reserve_thumbnail_index();
    push_thumbnail(&app, path_str.clone(), &cropped, idx);
    let _ = copy_rgba_to_clipboard(&cropped);

    Ok(path_str)
}

#[command]
pub fn take_fullscreen(app: AppHandle) -> Result<String, String> {
    let _timer_pause = ThumbnailTimerPause::new(&app);
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors.first().ok_or("No monitor found")?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = temp_dir().join(format!("shot_{ts}.png"));
    save_png_fast(&path, &image)?;

    let path_str = path.to_string_lossy().to_string();
    let idx = window::reserve_thumbnail_index();
    push_thumbnail(&app, path_str.clone(), &image, idx);
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
