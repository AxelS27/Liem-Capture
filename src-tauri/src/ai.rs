use std::{
    collections::VecDeque,
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::png::PngEncoder,
    imageops::{self, FilterType},
    ColorType, ImageEncoder, RgbaImage,
};
use tauri::{command, AppHandle, Manager};
use tract_onnx::prelude::*;

// Sub-pixel CNN super-resolution model from the ONNX model zoo. It upscales
// the luminance (Y) channel of a fixed 224×224 input by 3×; chroma is
// upscaled separately by interpolation. We tile the input into 224×224
// blocks so arbitrary image sizes work. Small (~240KB) and CPU-friendly.
const SR_MODEL_URL: &str =
    "https://github.com/onnx/models/raw/main/validated/vision/super_resolution/sub_pixel_cnn_2016/model/super-resolution-10.onnx";
const SR_TILE: u32 = 224;
const SR_SCALE: u32 = 3;

#[derive(Clone, serde::Serialize)]
pub struct OcrWordPayload {
    pub text: String,
    pub line_index: u32,
    pub word_index: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url);
    STANDARD.decode(encoded).map_err(|e| e.to_string())
}

fn decode_rgba(data_url: &str) -> Result<RgbaImage, String> {
    let bytes = decode_data_url(data_url)?;
    image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())
        .map(|img| img.to_rgba8())
}

fn encode_png_data_url(img: &RgbaImage) -> Result<String, String> {
    let mut bytes = Vec::new();
    PngEncoder::new(Cursor::new(&mut bytes))
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[derive(Clone, serde::Serialize)]
pub struct UpscaleResult {
    #[serde(rename = "dataUrl")]
    pub data_url: String,
    /// true → the learned SR model ran; false → we fell back to a plain
    /// Lanczos resize (model unavailable / failed / input too large).
    #[serde(rename = "usedAi")]
    pub used_ai: bool,
}

#[command]
pub fn ai_upscale_image(
    app: AppHandle,
    data_url: String,
    scale: Option<u32>,
) -> Result<UpscaleResult, String> {
    let img = decode_rgba(&data_url)?;
    // Cap at 3×: that's the model's native output scale (best quality, no
    // resampling). 4× pushed the output past ~5600px and OOM-crashed the
    // webview when it tried to build a canvas that big.
    let scale = scale.unwrap_or(2).clamp(2, 3);
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Ok(UpscaleResult {
            data_url: encode_png_data_url(&img)?,
            used_ai: false,
        });
    }

    // Hard output cap. Upscaling a full-resolution screenshot (e.g. a 4K
    // shot at 3× → 11520×6480 ≈ 75 MP) builds a canvas large enough to
    // OOM-crash the webview renderer — which is exactly what happened. Refuse
    // up front with a clear message instead of crashing. Both the AI and the
    // Lanczos fallback paths are gated by this, since either produces the
    // same oversized output.
    const MAX_OUTPUT_DIM: u32 = 6000;
    let out_w = w.saturating_mul(scale);
    let out_h = h.saturating_mul(scale);
    if out_w.max(out_h) > MAX_OUTPUT_DIM {
        return Err(format!(
            "Too large to upscale {scale}× (would be {out_w}×{out_h}). Crop a smaller area first."
        ));
    }

    // CPU super-resolution gets impractically slow on big inputs (the model
    // runs per 224px tile) and the 3× output balloons memory. Above this cap
    // we just resize. Upscale inputs are usually small regions, so this
    // rarely bites. 1200 → at most a 3600px output, which the webview canvas
    // handles comfortably.
    const MAX_INPUT_DIM: u32 = 1200;
    if w.max(h) <= MAX_INPUT_DIM {
        match run_sr_model(&app, &img) {
            Ok(sr) => {
                // The model outputs a fixed 3× image; resample to the user's
                // requested total scale (2× / 3× / 4×).
                let target_w = w.saturating_mul(scale).max(1);
                let target_h = h.saturating_mul(scale).max(1);
                let final_img = if sr.width() == target_w && sr.height() == target_h {
                    sr
                } else {
                    image::imageops::resize(&sr, target_w, target_h, FilterType::Lanczos3)
                };
                return Ok(UpscaleResult {
                    data_url: encode_png_data_url(&final_img)?,
                    used_ai: true,
                });
            }
            Err(e) => eprintln!("[upscale] AI model failed, falling back to resize: {e}"),
        }
    } else {
        eprintln!("[upscale] input {w}x{h} exceeds AI cap, using resize");
    }

    let width = w.saturating_mul(scale).max(1);
    let height = h.saturating_mul(scale).max(1);
    let upscaled = image::imageops::resize(&img, width, height, FilterType::Lanczos3);
    Ok(UpscaleResult {
        data_url: encode_png_data_url(&upscaled)?,
        used_ai: false,
    })
}

static SR_MODEL_PLAN: OnceLock<Mutex<TypedSimplePlan<TypedModel>>> = OnceLock::new();

fn get_sr_model_plan(app: &AppHandle) -> Result<&'static Mutex<TypedSimplePlan<TypedModel>>, String> {
    if let Some(plan) = SR_MODEL_PLAN.get() {
        return Ok(plan);
    }
    let model_path = ensure_sr_model(app)?;
    let model = tract_onnx::onnx()
        .model_for_path(&model_path)
        .map_err(|e| e.to_string())?
        .with_input_fact(
            0,
            f32::fact([1, 1, SR_TILE as usize, SR_TILE as usize]).into(),
        )
        .map_err(|e| e.to_string())?
        .into_optimized()
        .map_err(|e| e.to_string())?
        .into_runnable()
        .map_err(|e| e.to_string())?;

    let _ = SR_MODEL_PLAN.set(Mutex::new(model));
    SR_MODEL_PLAN
        .get()
        .ok_or_else(|| "Failed to access cached model plan".to_string())
}

fn ensure_sr_model(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = ai_model_dir(app)?;
    path.push("super-resolution-10.onnx");
    if path.exists() && path.metadata().map(|m| m.len()).unwrap_or(0) > 50_000 {
        return Ok(path);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(SR_MODEL_URL).send().map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Could not download upscale model: {}", response.status()));
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("onnx.download");
    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

// Tiled super-resolution. The model only accepts a fixed 224×224 luminance
// input, so we walk the image in 224px tiles (replicating edge pixels to pad
// partial tiles), run each through the model to get a 3× Y plane, and stitch
// the results. Chroma + alpha are upscaled with a cheap triangle filter.
fn run_sr_model(app: &AppHandle, img: &RgbaImage) -> Result<RgbaImage, String> {
    let model_mutex = get_sr_model_plan(app)?;
    let model = model_mutex.lock().map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    let ow = w * SR_SCALE;
    let oh = h * SR_SCALE;

    let mut y_out = vec![0u8; (ow as usize) * (oh as usize)];
    let tiles_x = (w + SR_TILE - 1) / SR_TILE;
    let tiles_y = (h + SR_TILE - 1) / SR_TILE;

    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let x0 = tx * SR_TILE;
            let y0 = ty * SR_TILE;
            let tw = (w - x0).min(SR_TILE);
            let th = (h - y0).min(SR_TILE);

            let mut input = tract_ndarray::Array4::<f32>::zeros((
                1,
                1,
                SR_TILE as usize,
                SR_TILE as usize,
            ));
            for yy in 0..SR_TILE {
                let src_y = y0 + yy.min(th - 1);
                for xx in 0..SR_TILE {
                    let src_x = x0 + xx.min(tw - 1);
                    let p = img.get_pixel(src_x, src_y).0;
                    let luma =
                        0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
                    input[[0, 0, yy as usize, xx as usize]] = luma / 255.0;
                }
            }

            let outputs = model
                .run(tvec!(input.into_tensor().into()))
                .map_err(|e| e.to_string())?;
            let y_sr = outputs[0].to_array_view::<f32>().map_err(|e| e.to_string())?;

            for yy in 0..(th * SR_SCALE) {
                for xx in 0..(tw * SR_SCALE) {
                    let v = (y_sr[[0, 0, yy as usize, xx as usize]].clamp(0.0, 1.0) * 255.0) as u8;
                    let ox = x0 * SR_SCALE + xx;
                    let oy = y0 * SR_SCALE + yy;
                    y_out[(oy * ow + ox) as usize] = v;
                }
            }
        }
    }

    // Chroma + alpha planes, upscaled by interpolation to the 3× size.
    let mut cb_plane = image::GrayImage::new(w, h);
    let mut cr_plane = image::GrayImage::new(w, h);
    let mut a_plane = image::GrayImage::new(w, h);
    for yy in 0..h {
        for xx in 0..w {
            let p = img.get_pixel(xx, yy).0;
            let r = p[0] as f32;
            let g = p[1] as f32;
            let b = p[2] as f32;
            let cb = -0.168_736 * r - 0.331_264 * g + 0.5 * b + 128.0;
            let cr = 0.5 * r - 0.418_688 * g - 0.081_312 * b + 128.0;
            cb_plane.put_pixel(xx, yy, image::Luma([cb.clamp(0.0, 255.0) as u8]));
            cr_plane.put_pixel(xx, yy, image::Luma([cr.clamp(0.0, 255.0) as u8]));
            a_plane.put_pixel(xx, yy, image::Luma([p[3]]));
        }
    }
    let cb_up = imageops::resize(&cb_plane, ow, oh, FilterType::Triangle);
    let cr_up = imageops::resize(&cr_plane, ow, oh, FilterType::Triangle);
    let a_up = imageops::resize(&a_plane, ow, oh, FilterType::Triangle);

    let mut out = RgbaImage::new(ow, oh);
    for yy in 0..oh {
        for xx in 0..ow {
            let y = y_out[(yy * ow + xx) as usize] as f32;
            let cb = cb_up.get_pixel(xx, yy).0[0] as f32 - 128.0;
            let cr = cr_up.get_pixel(xx, yy).0[0] as f32 - 128.0;
            let r = (y + 1.402 * cr).clamp(0.0, 255.0) as u8;
            let g = (y - 0.344_136 * cb - 0.714_136 * cr).clamp(0.0, 255.0) as u8;
            let b = (y + 1.772 * cb).clamp(0.0, 255.0) as u8;
            let a = a_up.get_pixel(xx, yy).0[0];
            out.put_pixel(xx, yy, image::Rgba([r, g, b, a]));
        }
    }
    Ok(out)
}

#[command]
pub fn ai_remove_background(data_url: String) -> Result<String, String> {
    let img = decode_rgba(&data_url)?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return encode_png_data_url(&img);
    }
    // NOTE: this used to run the u2netp ONNX matting model, but tract 0.21
    // cannot execute that model's Resize ops ("Building node Resize_N
    // (Resize)" — fails when building the runnable plan). Instead we flood-
    // fill the backdrop inward from the image border: only pixels CONNECTED
    // to the edge and close in color to the backdrop are removed. Enclosed
    // regions that happen to match the backdrop color — white teeth on a
    // white background, say — are sealed off by the subject's outline and
    // survive. Great for sprites / illustrations / solid backdrops; not a
    // general matting model for busy photographic backgrounds.
    let out = remove_background_floodfill(&img);
    encode_png_data_url(&out)
}

/// Flood-fill background removal. Samples the border to estimate the backdrop
/// color, then BFS-floods inward from every edge pixel, knocking out alpha on
/// pixels reachable through a connected run of backdrop-colored pixels. Edge
/// pixels are feathered by color distance for a soft cutout, and a saturated
/// backdrop (green/blue screen) gets its dominant channel despilled.
fn remove_background_floodfill(img: &RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return img.clone();
    }
    let wn = w as usize;

    let mut sum = [0u64; 3];
    let mut count = 0u64;
    for x in 0..w {
        for y in [0, h - 1] {
            let p = img.get_pixel(x, y).0;
            sum[0] += p[0] as u64;
            sum[1] += p[1] as u64;
            sum[2] += p[2] as u64;
            count += 1;
        }
    }
    for y in 0..h {
        for x in [0, w - 1] {
            let p = img.get_pixel(x, y).0;
            sum[0] += p[0] as u64;
            sum[1] += p[1] as u64;
            sum[2] += p[2] as u64;
            count += 1;
        }
    }
    let count = count.max(1);
    let bg = [
        (sum[0] / count) as f32,
        (sum[1] / count) as f32,
        (sum[2] / count) as f32,
    ];

    let dist_to_bg = |p: [u8; 4]| -> f32 {
        let dr = p[0] as f32 - bg[0];
        let dg = p[1] as f32 - bg[1];
        let db = p[2] as f32 - bg[2];
        (dr * dr + dg * dg + db * db).sqrt()
    };

    const FILL_THRESHOLD: f32 = 60.0; // within this of backdrop → floodable
    const FEATHER_OUTER: f32 = 110.0; // edge pixels in (THRESHOLD, OUTER) fade

    // 4-connected flood fill seeded from the border.
    let mut removed = vec![false; wn * h as usize];
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
    for x in 0..w {
        for y in [0, h - 1] {
            let idx = y as usize * wn + x as usize;
            if !removed[idx] && dist_to_bg(img.get_pixel(x, y).0) <= FILL_THRESHOLD {
                removed[idx] = true;
                queue.push_back((x, y));
            }
        }
    }
    for y in 0..h {
        for x in [0, w - 1] {
            let idx = y as usize * wn + x as usize;
            if !removed[idx] && dist_to_bg(img.get_pixel(x, y).0) <= FILL_THRESHOLD {
                removed[idx] = true;
                queue.push_back((x, y));
            }
        }
    }

    while let Some((x, y)) = queue.pop_front() {
        let neighbors = [
            (x.checked_sub(1), Some(y)),
            (Some(x + 1), Some(y)),
            (Some(x), y.checked_sub(1)),
            (Some(x), Some(y + 1)),
        ];
        for (cx, cy) in neighbors {
            if let (Some(nx), Some(ny)) = (cx, cy) {
                if nx < w && ny < h {
                    let idx = ny as usize * wn + nx as usize;
                    if !removed[idx] && dist_to_bg(img.get_pixel(nx, ny).0) <= FILL_THRESHOLD {
                        removed[idx] = true;
                        queue.push_back((nx, ny));
                    }
                }
            }
        }
    }

    // Despill setup for a saturated (green/blue-screen) backdrop.
    let bg_max = bg[0].max(bg[1]).max(bg[2]);
    let bg_min = bg[0].min(bg[1]).min(bg[2]);
    let saturated = bg_max - bg_min > 70.0;
    let dominant = if bg[1] >= bg[0] && bg[1] >= bg[2] {
        1usize
    } else if bg[0] >= bg[2] {
        0usize
    } else {
        2usize
    };

    let mut out = img.clone();
    for y in 0..h {
        for x in 0..w {
            let idx = y as usize * wn + x as usize;
            if removed[idx] {
                out.get_pixel_mut(x, y).0[3] = 0;
                continue;
            }

            // Feather kept pixels that border a removed region.
            let on_boundary = [
                (x.checked_sub(1), Some(y)),
                (Some(x + 1), Some(y)),
                (Some(x), y.checked_sub(1)),
                (Some(x), Some(y + 1)),
            ]
            .into_iter()
            .any(|(cx, cy)| match (cx, cy) {
                (Some(nx), Some(ny)) if nx < w && ny < h => removed[ny as usize * wn + nx as usize],
                _ => false,
            });

            let pixel = out.get_pixel_mut(x, y);
            if on_boundary {
                let d = dist_to_bg(pixel.0);
                if d < FEATHER_OUTER {
                    let f = ((d - FILL_THRESHOLD) / (FEATHER_OUTER - FILL_THRESHOLD)).clamp(0.0, 1.0);
                    pixel.0[3] = (pixel.0[3] as f32 * f) as u8;
                }
            }

            if saturated && pixel.0[3] > 0 {
                let other = match dominant {
                    1 => pixel.0[0].max(pixel.0[2]),
                    0 => pixel.0[1].max(pixel.0[2]),
                    _ => pixel.0[0].max(pixel.0[1]),
                };
                if pixel.0[dominant] > other {
                    pixel.0[dominant] = other;
                }
            }
        }
    }
    out
}

fn ai_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    dir.push("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[command]
pub fn ai_ocr_image(data_url: String) -> Result<String, String> {
    platform_ocr_layout(data_url).map(|words| {
        let mut lines: Vec<Vec<String>> = Vec::new();
        for word in words {
            let idx = word.line_index as usize;
            if lines.len() <= idx {
                lines.resize_with(idx + 1, Vec::new);
            }
            lines[idx].push(word.text);
        }
        lines
            .into_iter()
            .filter(|line| !line.is_empty())
            .map(|line| line.join(" "))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

#[command]
pub fn ai_ocr_layout(data_url: String) -> Result<Vec<OcrWordPayload>, String> {
    platform_ocr_layout(data_url)
}

#[cfg(target_os = "windows")]
fn platform_ocr_layout(data_url: String) -> Result<Vec<OcrWordPayload>, String> {
    use windows::{
        Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };

    let bytes = decode_data_url(&data_url)?;
    let stream = InMemoryRandomAccessStream::new().map_err(|e| e.to_string())?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| e.to_string())?;
    writer.WriteBytes(&bytes).map_err(|e| e.to_string())?;
    writer
        .StoreAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    writer
        .FlushAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    stream.Seek(0).map_err(|e| e.to_string())?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let bitmap =
        SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Bgra8).map_err(|e| e.to_string())?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("Windows OCR is unavailable: {e}"))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let lines = result.Lines().map_err(|e| e.to_string())?;

    let mut words_payload = Vec::new();
    for i in 0..lines.Size().map_err(|e| e.to_string())? {
        let line = lines.GetAt(i).map_err(|e| e.to_string())?;
        let words = line.Words().map_err(|e| e.to_string())?;
        for j in 0..words.Size().map_err(|e| e.to_string())? {
            let word = words.GetAt(j).map_err(|e| e.to_string())?;
            let rect = word.BoundingRect().map_err(|e| e.to_string())?;
            words_payload.push(OcrWordPayload {
                text: word.Text().map_err(|e| e.to_string())?.to_string(),
                line_index: i,
                word_index: j,
                x: rect.X,
                y: rect.Y,
                width: rect.Width,
                height: rect.Height,
            });
        }
    }

    Ok(words_payload)
}

#[cfg(not(target_os = "windows"))]
fn platform_ocr_layout(_data_url: String) -> Result<Vec<OcrWordPayload>, String> {
    Err("Local OCR is currently implemented with Windows OCR only".to_string())
}
