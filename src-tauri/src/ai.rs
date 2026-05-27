use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::png::PngEncoder,
    imageops::{self, FilterType},
    ColorType, ImageEncoder, RgbaImage,
};
use tauri::{command, AppHandle, Manager};
use tract_onnx::prelude::*;

const U2NETP_MODEL_URL: &str =
    "https://huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx";
const U2NET_INPUT_SIZE: u32 = 320;

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

#[command]
pub fn ai_upscale_image(data_url: String, scale: Option<u32>) -> Result<String, String> {
    let img = decode_rgba(&data_url)?;
    let scale = scale.unwrap_or(2).clamp(2, 4);
    let width = img.width().saturating_mul(scale).max(1);
    let height = img.height().saturating_mul(scale).max(1);
    let upscaled = image::imageops::resize(&img, width, height, FilterType::Lanczos3);
    encode_png_data_url(&upscaled)
}

#[command]
pub fn ai_remove_background(app: AppHandle, data_url: String) -> Result<String, String> {
    let mut img = decode_rgba(&data_url)?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return encode_png_data_url(&img);
    }

    let mask = run_u2netp_mask(&app, &img)?;
    for (pixel, alpha) in img.pixels_mut().zip(mask.pixels()) {
        let model_alpha = alpha.0[0] as u16;
        pixel.0[3] = ((pixel.0[3] as u16 * model_alpha) / 255) as u8;
    }

    encode_png_data_url(&img)
}

fn ai_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    dir.push("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn ensure_u2netp_model(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = ai_model_dir(app)?;
    path.push("u2netp.onnx");
    if path.exists() && path.metadata().map(|m| m.len()).unwrap_or(0) > 1_000_000 {
        return Ok(path);
    }

    let response = reqwest::blocking::get(U2NETP_MODEL_URL).map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download background model: {}",
            response.status()
        ));
    }
    let bytes = response.bytes().map_err(|e| e.to_string())?;
    let tmp_path = path.with_extension("onnx.download");
    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn run_u2netp_mask(app: &AppHandle, img: &RgbaImage) -> Result<image::GrayImage, String> {
    let model_path = ensure_u2netp_model(app)?;
    let resized = imageops::resize(
        img,
        U2NET_INPUT_SIZE,
        U2NET_INPUT_SIZE,
        FilterType::Triangle,
    );
    let mut input = tract_ndarray::Array4::<f32>::zeros((
        1,
        3,
        U2NET_INPUT_SIZE as usize,
        U2NET_INPUT_SIZE as usize,
    ));
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    for y in 0..U2NET_INPUT_SIZE {
        for x in 0..U2NET_INPUT_SIZE {
            let p = resized.get_pixel(x, y).0;
            for c in 0..3usize {
                input[[0, c, y as usize, x as usize]] = ((p[c] as f32 / 255.0) - mean[c]) / std[c];
            }
        }
    }

    let model = tract_onnx::onnx()
        .model_for_path(&model_path)
        .map_err(|e| e.to_string())?
        .with_input_fact(
            0,
            f32::fact([1, 3, U2NET_INPUT_SIZE as usize, U2NET_INPUT_SIZE as usize]).into(),
        )
        .map_err(|e| e.to_string())?
        .into_optimized()
        .map_err(|e| e.to_string())?
        .into_runnable()
        .map_err(|e| e.to_string())?;
    let outputs = model
        .run(tvec!(input.into_tensor().into()))
        .map_err(|e| e.to_string())?;
    let mask = outputs[0]
        .to_array_view::<f32>()
        .map_err(|e| e.to_string())?;
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for value in mask.iter().copied() {
        min = min.min(value);
        max = max.max(value);
    }
    let denom = (max - min).max(1e-8);
    let mut small = image::GrayImage::new(U2NET_INPUT_SIZE, U2NET_INPUT_SIZE);
    for y in 0..U2NET_INPUT_SIZE {
        for x in 0..U2NET_INPUT_SIZE {
            let value = (mask[[0, 0, y as usize, x as usize]] - min) / denom;
            small.put_pixel(x, y, image::Luma([(value.clamp(0.0, 1.0) * 255.0) as u8]));
        }
    }
    Ok(imageops::resize(
        &small,
        img.width(),
        img.height(),
        FilterType::Triangle,
    ))
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
