import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DISMISS_MS = 8000;
const UNPIN_DISMISS_MS = 3000;
const PREVIEW_TOOLS_DELAY_MS = 70;
const COLOR_PREFS_KEY = "liem-capture-thumbnail-colors";
const DEFAULT_COLORS = ["#ff3b5f", "#ffffff", "#ffd84d", "#39d98a", "#4da3ff"];
const CROP_MIN_CANVAS_SIZE = 12;
const CROP_MIN_VISUAL_SIZE = 96;
const CAMERA_MIN_ZOOM = 1;
const CAMERA_MAX_ZOOM = 4;
const CROP_RATIOS: Record<CropRatioKey, number | null> = {
  custom: null,
  "1:1": 1,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
  "3:4": 3 / 4,
  "9:16": 9 / 16,
};

interface ThumbnailData {
  path: string;
  image: string;
}

interface PreviewTransitionStart {
  durationMs: number;
}

declare global {
  interface Window {
    __LIEM_PREPARE_THUMBNAIL?: () => void;
    __LIEM_REVEAL_THUMBNAIL?: () => void;
    __LIEM_CONCEAL_THUMBNAIL?: () => void;
    __LIEM_FORCE_THUMBNAIL_MODE?: () => void;
    __LIEM_SET_THUMBNAIL?: (data: ThumbnailData) => void;
  }
}

type Mode = "draw" | "shape" | "crop";
type DrawTool = "pencil" | "highlighter" | "eraser";
type ShapeTool = "rect" | "ellipse" | "line" | "arrow" | "diamond" | "triangle";
type Point = { x: number; y: number };
type CropHandle = "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type CropRatioKey = "custom" | "1:1" | "4:3" | "16:9" | "3:4" | "9:16";
type TransformAction = "rotate-right" | "rotate-left" | "flip-x" | "flip-y";
type AiAction = "upscale" | "remove-bg" | "ocr";
type OcrWord = {
  text: string;
  line_index: number;
  word_index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
type OcrBox = OcrWord & {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
type CropRect = { x: number; y: number; w: number; h: number };
type ShapeObject = {
  kind: ShapeTool;
  x: number;
  y: number;
  w: number;
  h: number;
  start: Point;
  end: Point;
  color: string;
  width: number;
  fillColor?: string;
};

const currentWindow = getCurrentWindow();
const preview = document.querySelector<HTMLDivElement>("#preview")!;
const shell = document.querySelector<HTMLElement>("#shell")!;
const image = document.querySelector<HTMLImageElement>("#image")!;
const editCanvas = document.querySelector<HTMLCanvasElement>("#edit-canvas")!;
const ocrLayer = document.querySelector<HTMLDivElement>("#ocr-layer")!;
const ocrSelection = document.querySelector<HTMLDivElement>("#ocr-selection")!;
const previewDragBar = document.querySelector<HTMLDivElement>("#preview-drag-bar")!;
const cropBox = document.querySelector<HTMLDivElement>("#crop-box")!;
const cropConfirmButton = document.querySelector<HTMLButtonElement>("#crop-confirm")!;
const cropCancelButton = document.querySelector<HTMLButtonElement>("#crop-cancel")!;
const eraserCursor = document.querySelector<HTMLDivElement>("#eraser-cursor")!;
const statusText = document.querySelector<HTMLDivElement>("#status")!;
const progress = document.querySelector<HTMLDivElement>("#progress")!;
const pinButton = document.querySelector<HTMLButtonElement>("#pin")!;
const minimizeButton = document.querySelector<HTMLButtonElement>("#minimize")!;
const closeButton = document.querySelector<HTMLButtonElement>("#close")!;
const thumbnailCopyButton = document.querySelector<HTMLButtonElement>("#thumbnail-copy")!;
const drawGroup = document.querySelector<HTMLDivElement>("#draw-group")!;
const shapeGroup = document.querySelector<HTMLDivElement>("#shape-group")!;
const cropGroup = document.querySelector<HTMLDivElement>("#crop-group")!;
const transformGroup = document.querySelector<HTMLDivElement>("#transform-group")!;
const aiGroup = document.querySelector<HTMLDivElement>("#ai-group")!;
const drawButton = document.querySelector<HTMLButtonElement>("#tool-draw")!;
const cropButton = document.querySelector<HTMLButtonElement>("#tool-crop")!;
const shapeButton = document.querySelector<HTMLButtonElement>("#tool-shape")!;
const transformButton = document.querySelector<HTMLButtonElement>("#tool-transform")!;
const aiButton = document.querySelector<HTMLButtonElement>("#tool-ai")!;
const sizeInput = document.querySelector<HTMLInputElement>("#tool-size")!;
const colorInput = document.querySelector<HTMLInputElement>("#tool-color")!;
const palette = document.querySelector<HTMLDivElement>("#palette")!;
const undoButton = document.querySelector<HTMLButtonElement>("#tool-undo")!;
const redoButton = document.querySelector<HTMLButtonElement>("#tool-redo")!;
const clearButton = document.querySelector<HTMLButtonElement>("#tool-clear")!;
const copyButton = document.querySelector<HTMLButtonElement>("#tool-copy")!;
const saveButton = document.querySelector<HTMLButtonElement>("#tool-save")!;
const saveGroup = document.querySelector<HTMLDivElement>("#save-group")!;

let filePath = "";
let imageDataUrl = "";
let hideTimeoutId = 0;
let toolsReadyTimeoutId = 0;
let timerDurationMs = DISMISS_MS;
let remainingMs = DISMISS_MS;
let timerStartedAt = 0;
let timerPaused = true;
let isPinned = false;
let isDismissing = false;
let isPreviewMode = false;
let isEditorReady = false;
let thumbnailImageReady = false;
let thumbnailRevealRequested = false;
let thumbnailRevealRaf = 0;
let mode: Mode = "draw";
let drawTool: DrawTool = "pencil";
let shapeTool: ShapeTool = "rect";
let cropRatio: CropRatioKey = "custom";
let toolSizes: Record<DrawTool | ShapeTool | "crop", number> = {
  pencil: 8,
  highlighter: 18,
  eraser: 28,
  rect: 8,
  ellipse: 8,
  line: 8,
  arrow: 8,
  diamond: 8,
  triangle: 8,
  crop: 2,
};
let drawing = false;
let startPoint: Point | null = null;
let lastPoint: Point | null = null;
let hoverPoint: ReturnType<typeof eventToCanvasPoint> | null = null;
let strokePoints: Point[] = [];
let snapshotBeforeAction: HTMLCanvasElement | null = null;
let baseCanvas = document.createElement("canvas");
let editLayer = document.createElement("canvas");
// Transient overlay for the in-progress stroke. Previously every
// pointermove did putImageData(editLayer) to "restore" then re-drew the
// growing stroke path on editLayer. On a 1080p+ canvas that's 20-50ms
// per frame and 1000Hz pointermoves snowballed into a queued backlog
// that locked the main thread. Drawing the live stroke on a separate
// canvas instead lets each frame just clear+redraw the stroke (cheap
// line draws, no full-canvas pixel copies). On pointerup we drawImage
// the strokeLayer onto editLayer to persist it.
let strokeLayer = document.createElement("canvas");
let strokeLayerDirty = false;
let shapeObjects: ShapeObject[] = [];
let previewShape: ShapeObject | null = null;
let cropRect: CropRect | null = null;
let cropInteraction: {
  id: number;
  handle: CropHandle;
  startPoint: Point;
  startRect: CropRect;
} | null = null;
// Undo / redo history holds raw canvas clones, not encoded PNG strings.
// `editCanvas.toDataURL("image/png")` was being called synchronously on
// every pointerdown via captureSnapshot(); on a 4K shot that blocked the
// main thread for 200-500ms and was the actual cause of the "ngeframe
// dulu" stall after Save — the in-flight save's async PNG encode raced
// with the new stroke's sync encode and the main thread froze.
// drawImage between canvases is essentially a GPU blit (<1ms).
let undoStack: HTMLCanvasElement[] = [];
let redoStack: HTMLCanvasElement[] = [];
// Hard cap so an aggressive editor session can't balloon memory. Each
// 4K snapshot is ~33MB of pixel data; keeping the last 30 still tops out
// around 1GB worst case, which is more than enough headroom for typical
// edits.
const MAX_UNDO_HISTORY = 30;
const initialColorPrefs = loadColorPrefs();
let savedColors = initialColorPrefs.colors;
let editingColorIndex = initialColorPrefs.index;
let previewDragState: {
  id: number;
  screenX: number;
  screenY: number;
  pendingX: number;
  pendingY: number;
  raf: number;
  moving: boolean;
} | null = null;
let cameraZoom = 1;
let cameraPanX = 0;
let cameraPanY = 0;
let cameraPanState: {
  id: number;
  x: number;
  y: number;
  panX: number;
  panY: number;
} | null = null;
let aiBusy = false;
let isOcrMode = false;
let ocrWords: OcrWord[] = [];
let ocrBoxes: OcrBox[] = [];
let selectedOcrIds = new Set<string>();
let ocrDragState: {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  // false = text-flow selection (Snipping Tool style, the default);
  // true = rectangular box selection (hold Ctrl). Captured at pointerdown
  // so toggling Ctrl mid-drag doesn't switch modes underfoot.
  box: boolean;
} | null = null;

interface PointerState {
  id: number;
  x: number;
  y: number;
  dragging: boolean;
}

let pointerState: PointerState | null = null;

function setStatus(message: string) {
  statusText.textContent = message;
  statusText.hidden = false;
}

function flashStatus(message: string) {
  setStatus(message);
  window.setTimeout(() => {
    statusText.hidden = true;
  }, 700);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function showImage(src: string) {
  return new Promise<void>((resolve) => {
    const reveal = () => {
      image.hidden = false;
      statusText.hidden = true;
      resolve();
    };

    image.hidden = true;
    image.onload = () => {
      if (typeof image.decode === "function") {
        image.decode().then(reveal).catch(reveal);
      } else {
        reveal();
      }
    };
    image.onerror = () => {
      image.hidden = true;
      setStatus("Preview unavailable");
      resolve();
    };
    image.src = src;
  });
}

function canvasContext() {
  const ctx = editCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  return ctx;
}

function canvasContentRect() {
  const rect = editCanvas.getBoundingClientRect();
  const scale = Math.min(rect.width / editCanvas.width, rect.height / editCanvas.height);
  const width = editCanvas.width * scale;
  const height = editCanvas.height * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
    scale,
  };
}

function eventToCanvasPoint(event: { clientX: number; clientY: number }) {
  const content = canvasContentRect();
  const x = Math.max(0, Math.min(editCanvas.width, (event.clientX - content.left) / content.scale));
  const y = Math.max(0, Math.min(editCanvas.height, (event.clientY - content.top) / content.scale));
  return { x, y, content };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function cameraPanBounds(zoom = cameraZoom) {
  if (zoom <= CAMERA_MIN_ZOOM) return { x: 0, y: 0 };

  return {
    x: (editCanvas.offsetWidth * (zoom - 1)) / 2,
    y: (editCanvas.offsetHeight * (zoom - 1)) / 2,
  };
}

function setCameraView(zoom: number, panX = cameraPanX, panY = cameraPanY) {
  cameraZoom = clamp(zoom, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
  const bounds = cameraPanBounds(cameraZoom);
  cameraPanX = cameraZoom <= CAMERA_MIN_ZOOM ? 0 : clamp(panX, -bounds.x, bounds.x);
  cameraPanY = cameraZoom <= CAMERA_MIN_ZOOM ? 0 : clamp(panY, -bounds.y, bounds.y);

  editCanvas.style.setProperty("--camera-x", `${Math.round(cameraPanX)}px`);
  editCanvas.style.setProperty("--camera-y", `${Math.round(cameraPanY)}px`);
  editCanvas.style.setProperty("--camera-zoom", cameraZoom.toFixed(3));
  shell.classList.toggle("camera-pannable", cameraZoom > CAMERA_MIN_ZOOM);
  shell.classList.toggle("camera-panning", cameraPanState !== null);
  renderCropBox();
  updateEraserCursor();
}

function resetCameraView() {
  cameraPanState = null;
  setCameraView(CAMERA_MIN_ZOOM, 0, 0);
}

function cropMinSize(axis: "width" | "height") {
  const canvasSize = axis === "width" ? editCanvas.width : editCanvas.height;
  if (canvasSize <= 0) return CROP_MIN_CANVAS_SIZE;

  const rect = editCanvas.getBoundingClientRect();
  const scale = Math.min(rect.width / Math.max(1, editCanvas.width), rect.height / Math.max(1, editCanvas.height));
  if (!Number.isFinite(scale) || scale <= 0) {
    return Math.min(canvasSize, CROP_MIN_CANVAS_SIZE);
  }

  return Math.min(canvasSize, Math.max(CROP_MIN_CANVAS_SIZE, CROP_MIN_VISUAL_SIZE / scale));
}

function activeCropRatio() {
  return CROP_RATIOS[cropRatio];
}

function normalizeCropRect(rect: CropRect): CropRect {
  const minWidth = cropMinSize("width");
  const minHeight = cropMinSize("height");
  const w = Math.max(minWidth, Math.min(rect.w, editCanvas.width));
  const h = Math.max(minHeight, Math.min(rect.h, editCanvas.height));
  return {
    x: clamp(rect.x, 0, Math.max(0, editCanvas.width - w)),
    y: clamp(rect.y, 0, Math.max(0, editCanvas.height - h)),
    w,
    h,
  };
}

function fitCropRectToRatio(rect: CropRect, ratio: number): CropRect {
  const minWidth = cropMinSize("width");
  const minHeight = cropMinSize("height");
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  let w = rect.w;
  let h = rect.h;

  if (w / h > ratio) {
    w = h * ratio;
  } else {
    h = w / ratio;
  }

  if (w < minWidth) {
    w = minWidth;
    h = w / ratio;
  }
  if (h < minHeight) {
    h = minHeight;
    w = h * ratio;
  }
  if (w > editCanvas.width) {
    w = editCanvas.width;
    h = w / ratio;
  }
  if (h > editCanvas.height) {
    h = editCanvas.height;
    w = h * ratio;
  }

  return normalizeCropRect({
    x: centerX - w / 2,
    y: centerY - h / 2,
    w,
    h,
  });
}

function setCropRect(rect: CropRect | null) {
  if (!rect) {
    cropRect = null;
    renderCropBox();
    return;
  }

  const normalized = normalizeCropRect(rect);
  const ratio = activeCropRatio();
  cropRect = ratio ? fitCropRectToRatio(normalized, ratio) : normalized;
  renderCropBox();
}

function renderCropBox() {
  if (mode !== "crop" || !cropRect || editCanvas.width === 0 || editCanvas.height === 0) {
    cropBox.style.display = "none";
    return;
  }

  const content = canvasContentRect();
  const previewRect = preview.getBoundingClientRect();
  cropBox.style.display = "block";
  cropBox.style.left = `${content.left - previewRect.left + cropRect.x * content.scale}px`;
  cropBox.style.top = `${content.top - previewRect.top + cropRect.y * content.scale}px`;
  cropBox.style.width = `${cropRect.w * content.scale}px`;
  cropBox.style.height = `${cropRect.h * content.scale}px`;
}

function initDefaultCropRect() {
  if (!editCanvas.width || !editCanvas.height) return;

  const w = Math.max(cropMinSize("width"), editCanvas.width * 0.84);
  const h = Math.max(cropMinSize("height"), editCanvas.height * 0.84);
  setCropRect({
    x: (editCanvas.width - w) / 2,
    y: (editCanvas.height - h) / 2,
    w,
    h,
  });
}

function resizeCropRect(startRect: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
  let left = startRect.x;
  let top = startRect.y;
  let right = startRect.x + startRect.w;
  let bottom = startRect.y + startRect.h;
  const minWidth = cropMinSize("width");
  const minHeight = cropMinSize("height");

  if (handle.includes("w")) {
    left = clamp(left + dx, 0, right - minWidth);
  }
  if (handle.includes("e")) {
    right = clamp(right + dx, left + minWidth, editCanvas.width);
  }
  if (handle.includes("n")) {
    top = clamp(top + dy, 0, bottom - minHeight);
  }
  if (handle.includes("s")) {
    bottom = clamp(bottom + dy, top + minHeight, editCanvas.height);
  }

  return normalizeCropRect({
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  });
}

function visualSizeToCanvasSize(size: number) {
  const { scale } = canvasContentRect();
  return size / Math.max(scale, 0.001);
}

function currentSize() {
  if (mode === "crop") return toolSizes.crop;
  if (mode === "shape") return toolSizes[shapeTool];
  return toolSizes[drawTool];
}

function eraserSize() {
  return Math.round(toolSizes.eraser * 1.9);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function loadColorPrefs() {
  const fallback = {
    activeColor: DEFAULT_COLORS[0],
    colors: DEFAULT_COLORS.slice(0, 3),
    index: 0,
  };

  try {
    const raw = window.localStorage.getItem(COLOR_PREFS_KEY);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as { activeColor?: unknown; colors?: unknown; index?: unknown };
    const colors = Array.isArray(parsed.colors)
      ? parsed.colors.filter(isHexColor).slice(0, 3)
      : fallback.colors;
    while (colors.length < 3) {
      colors.push(DEFAULT_COLORS[colors.length]);
    }

    const activeColor = isHexColor(parsed.activeColor) ? parsed.activeColor : colors[0];
    const parsedIndex = Number(parsed.index);
    const index = Number.isInteger(parsedIndex) && parsedIndex >= 0 && parsedIndex < colors.length ? parsedIndex : 0;

    return { activeColor, colors, index };
  } catch {
    return fallback;
  }
}

function saveColorPrefs() {
  try {
    window.localStorage.setItem(
      COLOR_PREFS_KEY,
      JSON.stringify({
        activeColor: colorInput.value,
        colors: savedColors,
        index: editingColorIndex,
      }),
    );
  } catch {
    // Color preferences are nice-to-have; editing should keep working without storage.
  }
}

function setActiveColor(color: string) {
  colorInput.value = color;
  sizeInput.style.accentColor = color;
  saveColorPrefs();
  renderPalette();
}

function setCurrentSize(value: number) {
  const size = Math.max(2, Math.min(48, value));
  if (mode === "crop") {
    toolSizes.crop = size;
  } else if (mode === "shape") {
    toolSizes[shapeTool] = size;
  } else {
    toolSizes[drawTool] = size;
  }
  sizeInput.value = String(size);
  updateEraserCursor();
}

function iconForDrawTool(tool: DrawTool) {
  if (tool === "highlighter") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 18l6-13 8 8-13 6-1-1z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" /></svg>';
  }
  if (tool === "eraser") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 15l8-8a3 3 0 014 0l2 2a3 3 0 010 4l-6 6H7l-3-3z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" /></svg>';
  }
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 00-3-3L5.2 16 4 20z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" /><path d="M14.5 6.5l3 3" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" /></svg>';
}

function iconForShapeTool(tool: ShapeTool) {
  if (tool === "ellipse") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="12" rx="7" ry="5" stroke="currentColor" stroke-width="1.9" /></svg>';
  }
  if (tool === "line") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19L19 5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" /></svg>';
  }
  if (tool === "arrow") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19L19 5M12 5h7v7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  }
  if (tool === "diamond") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4l8 8-8 8-8-8 8-8z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" /></svg>';
  }
  if (tool === "triangle") {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5l8 14H4L12 5z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" /></svg>';
  }
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="6" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.9" /></svg>';
}

function updateEraserCursor(point?: ReturnType<typeof eventToCanvasPoint>) {
  const targetPoint = point ?? hoverPoint;
  if (!isPreviewMode || mode !== "draw" || drawTool !== "eraser" || !targetPoint) {
    eraserCursor.style.display = "none";
    return;
  }

  const previewRect = preview.getBoundingClientRect();
  const diameter = Math.max(12, eraserSize());
  eraserCursor.style.display = "block";
  eraserCursor.style.width = `${diameter}px`;
  eraserCursor.style.height = `${diameter}px`;
  eraserCursor.style.left = `${targetPoint.content.left - previewRect.left + targetPoint.x * targetPoint.content.scale}px`;
  eraserCursor.style.top = `${targetPoint.content.top - previewRect.top + targetPoint.y * targetPoint.content.scale}px`;
}

function updateHistoryButtons() {
  undoButton.disabled = undoStack.length <= 1;
  redoButton.disabled = redoStack.length === 0;
  clearButton.disabled = undoStack.length <= 1;
}

function captureSnapshot(): HTMLCanvasElement {
  // Cheap canvas-to-canvas blit. drawImage on a fresh canvas is GPU /
  // memcpy, no PNG encoding.
  const snap = document.createElement("canvas");
  snap.width = editCanvas.width;
  snap.height = editCanvas.height;
  const ctx = snap.getContext("2d");
  if (ctx) ctx.drawImage(editCanvas, 0, 0);
  return snap;
}

function drawSnapshot(snap: HTMLCanvasElement) {
  // Undo/redo can resize the canvas (e.g. undoing a crop/rotate), which
  // invalidates the OCR word-box positions — drop them.
  exitOcrMode();
  baseCanvas.width = snap.width;
  baseCanvas.height = snap.height;
  editLayer.width = baseCanvas.width;
  editLayer.height = baseCanvas.height;
  editCanvas.width = baseCanvas.width;
  editCanvas.height = baseCanvas.height;
  baseCanvas.getContext("2d")?.drawImage(snap, 0, 0);
  editLayer.getContext("2d")?.clearRect(0, 0, editLayer.width, editLayer.height);
  shapeObjects = [];
  previewShape = null;
  cropInteraction = null;
  setCropRect(null);
  resetCameraView();
  renderComposite();
}

function canvasFromDataUrl(dataUrl: string) {
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const next = document.createElement("canvas");
      next.width = img.naturalWidth || img.width;
      next.height = img.naturalHeight || img.height;
      next.getContext("2d")?.drawImage(img, 0, 0);
      resolve(next);
    };
    img.onerror = () => reject(new Error("AI result image could not be loaded"));
    img.src = dataUrl;
  });
}

function localPointInOcrLayer(event: { clientX: number; clientY: number }) {
  const rect = ocrLayer.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function orderedOcrSelection() {
  return ocrBoxes
    .filter((box) => selectedOcrIds.has(box.id))
    .sort((a, b) => a.line_index - b.line_index || a.word_index - b.word_index);
}

function textFromOcrBoxes(boxes: OcrBox[]) {
  const lines: string[] = [];
  let currentLine = -1;
  let lineWords: string[] = [];

  for (const box of boxes) {
    if (box.line_index !== currentLine) {
      if (lineWords.length) lines.push(lineWords.join(" "));
      currentLine = box.line_index;
      lineWords = [];
    }
    lineWords.push(box.text);
  }
  if (lineWords.length) lines.push(lineWords.join(" "));
  return lines.join("\n");
}

function updateOcrSelectionClasses() {
  ocrLayer.querySelectorAll<HTMLElement>(".ocr-word").forEach((el) => {
    el.classList.toggle("selected", selectedOcrIds.has(el.dataset.ocrId ?? ""));
  });
}

function selectAllOcrText() {
  selectedOcrIds = new Set(ocrBoxes.map((box) => box.id));
  updateOcrSelectionClasses();
  if (selectedOcrIds.size) {
    flashStatus("All text selected");
  } else {
    flashStatus("No text found");
  }
}

function renderOcrLayer(words: OcrWord[]) {
  const content = canvasContentRect();
  const layerRect = ocrLayer.getBoundingClientRect();
  const offsetX = content.left - layerRect.left;
  const offsetY = content.top - layerRect.top;

  ocrBoxes = words.map((word) => {
    const left = offsetX + word.x * content.scale;
    const top = offsetY + word.y * content.scale;
    const width = word.width * content.scale;
    const height = word.height * content.scale;
    return {
      ...word,
      id: `${word.line_index}:${word.word_index}`,
      left,
      top,
      right: left + width,
      bottom: top + height,
    };
  });

  ocrLayer.querySelectorAll(".ocr-word").forEach((el) => el.remove());
  for (const box of ocrBoxes) {
    const el = document.createElement("div");
    el.className = "ocr-word";
    el.dataset.ocrId = box.id;
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${Math.max(4, box.right - box.left)}px`;
    el.style.height = `${Math.max(4, box.bottom - box.top)}px`;
    ocrLayer.appendChild(el);
  }
  updateOcrSelectionClasses();
}

function setOcrSelectionRect(startX: number, startY: number, x: number, y: number) {
  const left = Math.min(startX, x);
  const top = Math.min(startY, y);
  const width = Math.abs(x - startX);
  const height = Math.abs(y - startY);
  ocrSelection.style.display = "block";
  ocrSelection.style.left = `${left}px`;
  ocrSelection.style.top = `${top}px`;
  ocrSelection.style.width = `${width}px`;
  ocrSelection.style.height = `${height}px`;
}

function selectOcrBoxesInRect(startX: number, startY: number, x: number, y: number) {
  const left = Math.min(startX, x);
  const top = Math.min(startY, y);
  const right = Math.max(startX, x);
  const bottom = Math.max(startY, y);
  selectedOcrIds = new Set(
    ocrBoxes
      .filter((box) => box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom)
      .map((box) => box.id),
  );
  updateOcrSelectionClasses();
}

// OCR boxes sorted into natural reading order (top line first, left word
// first within a line). Used by the text-flow selection so a drag picks a
// contiguous run of words the way selecting text in a document would.
function ocrBoxesInReadingOrder(): OcrBox[] {
  return [...ocrBoxes].sort(
    (a, b) => a.line_index - b.line_index || a.word_index - b.word_index,
  );
}

// Index (into the reading-order array) of the word a point lands on. If the
// point isn't inside any box, snap to the nearest one, weighting vertical
// distance heavily so we lock onto the correct line before picking a word
// within it — matches how a caret behaves when you drag between lines.
function ocrReadingIndexAtPoint(ordered: OcrBox[], x: number, y: number): number {
  for (let i = 0; i < ordered.length; i += 1) {
    const b = ordered[i];
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return i;
  }
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < ordered.length; i += 1) {
    const b = ordered[i];
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    const score = Math.abs(y - cy) * 4 + Math.abs(x - cx);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// Text-flow selection: select every word in reading order between the word
// under the start point and the word under the end point (inclusive). This
// is the Snipping-Tool-style default — drag from one word to another and
// everything in between (across line wraps) gets picked, no rectangle.
function selectOcrBoxesFlow(startX: number, startY: number, x: number, y: number) {
  const ordered = ocrBoxesInReadingOrder();
  if (ordered.length === 0) {
    selectedOcrIds = new Set();
    updateOcrSelectionClasses();
    return;
  }
  const a = ocrReadingIndexAtPoint(ordered, startX, startY);
  const b = ocrReadingIndexAtPoint(ordered, x, y);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  selectedOcrIds = new Set(ordered.slice(lo, hi + 1).map((box) => box.id));
  updateOcrSelectionClasses();
}

async function copySelectedOcrText() {
  const selected = orderedOcrSelection();
  if (!selected.length) {
    flashStatus("No text selected");
    return;
  }
  try {
    await navigator.clipboard.writeText(textFromOcrBoxes(selected));
    flashStatus("Text copied");
  } catch (error) {
    flashStatus(`Copy failed: ${String(error)}`);
  }
}

async function copySelectedOcrTextIfAny() {
  if (!isOcrMode || selectedOcrIds.size === 0) return false;
  await copySelectedOcrText();
  return true;
}

function enterOcrMode(words: OcrWord[]) {
  drawing = false;
  // setMode("draw") calls exitOcrMode() internally; run it while isOcrMode
  // is still false so it no-ops, then flip OCR on afterward.
  setMode("draw");
  setCropRect(null);
  isOcrMode = true;
  ocrWords = words;
  selectedOcrIds = new Set();
  shell.classList.add("ocr-mode");
  renderOcrLayer(ocrWords);
  flashStatus(words.length ? "Drag to select · Ctrl+drag for box" : "No text found");
}

function exitOcrMode() {
  if (!isOcrMode) return;
  isOcrMode = false;
  ocrDragState = null;
  ocrWords = [];
  ocrBoxes = [];
  selectedOcrIds = new Set();
  ocrSelection.style.display = "none";
  ocrLayer.querySelectorAll(".ocr-word").forEach((el) => el.remove());
  shell.classList.remove("ocr-mode");
}

function layerContext() {
  const ctx = editLayer.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Edit layer unavailable");
  return ctx;
}

function syncStrokeLayerSize() {
  if (strokeLayer.width !== editCanvas.width || strokeLayer.height !== editCanvas.height) {
    strokeLayer.width = editCanvas.width;
    strokeLayer.height = editCanvas.height;
    strokeLayerDirty = false;
  }
}

function strokeLayerContext() {
  syncStrokeLayerSize();
  const ctx = strokeLayer.getContext("2d");
  if (!ctx) throw new Error("Stroke layer unavailable");
  return ctx;
}

function clearStrokeLayer() {
  if (!strokeLayerDirty) return;
  syncStrokeLayerSize();
  strokeLayer.getContext("2d")?.clearRect(0, 0, strokeLayer.width, strokeLayer.height);
  strokeLayerDirty = false;
}

function renderComposite() {
  const ctx = canvasContext();
  ctx.clearRect(0, 0, editCanvas.width, editCanvas.height);
  ctx.drawImage(baseCanvas, 0, 0);
  ctx.drawImage(editLayer, 0, 0);
  if (strokeLayerDirty) {
    ctx.drawImage(strokeLayer, 0, 0);
  }
  for (const shape of shapeObjects) {
    drawShapeObject(ctx, shape);
  }
  if (previewShape) {
    drawShapeObject(ctx, previewShape);
  }
}

function flattenShapeObjectsIntoLayer() {
  if (!shapeObjects.length) return;

  const ctx = layerContext();
  for (const shape of shapeObjects) {
    drawShapeObject(ctx, shape);
  }
  shapeObjects = [];
  previewShape = null;
  renderComposite();
}

function commitSnapshot(_before: HTMLCanvasElement | null) {
  // We can no longer dedupe by equality the way the old string-based
  // snapshots did — comparing two canvases pixel-by-pixel would be just
  // as expensive as the encode we were trying to skip. Always push; if
  // the user did nothing they can hit Undo to wipe the redundant entry.
  undoStack.push(captureSnapshot());
  if (undoStack.length > MAX_UNDO_HISTORY) {
    undoStack.splice(0, undoStack.length - MAX_UNDO_HISTORY);
  }
  redoStack = [];
  updateHistoryButtons();
}

function shapeFromPoints(kind: ShapeTool, start: Point, end: Point): ShapeObject {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  return {
    kind,
    x,
    y,
    w,
    h,
    start,
    end,
    color: colorInput.value,
    width: currentSize(),
  };
}

function closedShapePath(ctx: CanvasRenderingContext2D, shape: ShapeObject) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  if (shape.kind === "rect") {
    ctx.rect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.kind === "ellipse") {
    ctx.ellipse(cx, cy, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
  } else if (shape.kind === "diamond") {
    ctx.moveTo(cx, shape.y);
    ctx.lineTo(shape.x + shape.w, cy);
    ctx.lineTo(cx, shape.y + shape.h);
    ctx.lineTo(shape.x, cy);
    ctx.closePath();
  } else if (shape.kind === "triangle") {
    ctx.moveTo(cx, shape.y);
    ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
    ctx.lineTo(shape.x, shape.y + shape.h);
    ctx.closePath();
  }
}

function isClosedShape(shape: ShapeObject) {
  return shape.kind === "rect" || shape.kind === "ellipse" || shape.kind === "diamond" || shape.kind === "triangle";
}

function drawShapeObject(ctx: CanvasRenderingContext2D, shape: ShapeObject) {
  ctx.save();
  const lineWidth = visualSizeToCanvasSize(shape.width);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.fillColor ?? shape.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (isClosedShape(shape)) {
    ctx.beginPath();
    closedShapePath(ctx, shape);
    if (shape.fillColor) {
      ctx.fill();
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(shape.start.x, shape.start.y);
    ctx.lineTo(shape.end.x, shape.end.y);
    ctx.stroke();
    if (shape.kind === "arrow") {
      const angle = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x);
      const head = visualSizeToCanvasSize(Math.max(12, shape.width * 2.2));
      ctx.beginPath();
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(shape.end.x - head * Math.cos(angle - Math.PI / 6), shape.end.y - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(shape.end.x - head * Math.cos(angle + Math.PI / 6), shape.end.y - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
  }

  ctx.restore();
}

function shapeContainsPoint(shape: ShapeObject, point: Point) {
  if (!isClosedShape(shape)) return false;
  const hitCanvas = document.createElement("canvas");
  hitCanvas.width = editCanvas.width;
  hitCanvas.height = editCanvas.height;
  const ctx = hitCanvas.getContext("2d");
  if (!ctx) return false;
  ctx.beginPath();
  closedShapePath(ctx, shape);
  return ctx.isPointInPath(point.x, point.y);
}

function setMode(nextMode: Mode) {
  // Switching to any draw / shape / crop tool leaves OCR mode. Its word-box
  // overlay is pinned to the canvas content at OCR time, so it must not
  // linger once the user starts cropping / drawing (the "OCR boxes stay
  // stuck after I crop" bug). enterOcrMode sets isOcrMode AFTER its own
  // setMode("draw") call, so this exitOcrMode() no-ops during OCR entry.
  exitOcrMode();
  mode = nextMode;
  drawButton.classList.toggle("active", mode === "draw");
  cropButton.classList.toggle("active", mode === "crop");
  shapeButton.classList.toggle("active", mode === "shape");
  sizeInput.value = String(currentSize());
  if (mode === "crop") {
    if (!cropRect) initDefaultCropRect();
    else renderCropBox();
  } else {
    setCropRect(null);
  }
  updateEraserCursor();
}

function setDrawTool(tool: DrawTool) {
  drawTool = tool;
  setMode("draw");
  drawButton.innerHTML = iconForDrawTool(tool);
  if (tool === "highlighter" && colorInput.value.toLowerCase() === "#ff3b5f") {
    setActiveColor("#ffd84d");
  }
  document.querySelectorAll<HTMLButtonElement>("[data-draw-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.drawTool === tool);
  });
  drawGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
}

function setShapeTool(tool: ShapeTool) {
  shapeTool = tool;
  setMode("shape");
  shapeButton.innerHTML = iconForShapeTool(tool);
  document.querySelectorAll<HTMLButtonElement>("[data-shape-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.shapeTool === tool);
  });
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
}

function updateCropRatioMenu() {
  document.querySelectorAll<HTMLButtonElement>("[data-crop-ratio]").forEach((button) => {
    button.classList.toggle("active", button.dataset.cropRatio === cropRatio);
  });
}

function setCropRatio(nextRatio: CropRatioKey) {
  cropRatio = nextRatio;
  updateCropRatioMenu();
  setMode("crop");
  if (cropRect) {
    setCropRect(cropRect);
  }
  cropGroup.classList.remove("open");
}

function renderPalette() {
  [...palette.querySelectorAll(".swatch")].forEach((node) => node.remove());

  savedColors.forEach((color, index) => {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.type = "button";
    swatch.draggable = true;
    swatch.title = color;
    swatch.style.background = color;
    swatch.classList.toggle("active", color.toLowerCase() === colorInput.value.toLowerCase());
    swatch.addEventListener("click", () => {
      setActiveColor(color);
      editingColorIndex = index;
    });
    swatch.addEventListener("dblclick", () => {
      editingColorIndex = index;
      setActiveColor(color);
      if (typeof colorInput.showPicker === "function") {
        colorInput.showPicker();
      } else {
        colorInput.click();
      }
    });
    swatch.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", color);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
      }
    });
    palette.insertBefore(swatch, colorInput);
  });
}

// Tracks which file's editor state is currently sitting in the canvases.
// When the user minimizes and re-opens the same thumbnail we want to
// keep every pixel of baseCanvas / editLayer plus the undo stack and
// shape list so they can still undo / erase / continue editing. Only
// when filePath changes (a fresh screenshot lands in this slot) do we
// blow away state and load from disk.
let loadedFilePath: string | null = null;
// Has the user explicitly saved this thumbnail (or moved/renamed it via
// the picker) at least once? A fresh screenshot starts with this false,
// so "Save to gallery" stays enabled even though undoStack.length === 1.
// After a successful save we flip it true; combined with the no-edits
// check this is what locks the menu until the user makes a new change.
let hasUserSaved = false;
// De-duplicates concurrent loadEditorCanvas calls. The background
// preload kicked off by applyThumbnail and the user's later click-to-
// enter would otherwise both fetch + decode the same 4K PNG and fight
// over the global canvases. Same-target callers share the same promise;
// a different-target caller starts a fresh load while the stale one
// keeps running in the background (it'll self-cancel via the path
// check below before writing to the canvas).
let editorLoadPromise: Promise<void> | null = null;
let editorLoadTarget: string | null = null;
let preloadTimerId = 0;

async function loadEditorCanvas() {
  // Fast path: same file, canvases already populated, undo history alive
  // — just redraw the composite (in case anything got hidden) and return.
  if (loadedFilePath === filePath && editCanvas.width > 0 && undoStack.length > 0) {
    renderComposite();
    return;
  }

  if (editorLoadPromise && editorLoadTarget === filePath) {
    return editorLoadPromise;
  }

  const targetPath = filePath;
  let myPromise: Promise<void> | null = null;
  myPromise = (async () => {
    try {
      const fullImage = await invoke<string>("get_image_data", { path: targetPath });
      // If a newer screenshot has replaced this slot mid-fetch, abandon —
      // letting the load continue would stomp on the canvases with pixels
      // from the wrong file.
      if (filePath !== targetPath) return;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Edit preview unavailable"));
        img.src = `data:image/png;base64,${fullImage}`;
      });
      if (filePath !== targetPath) return;

      editCanvas.width = img.naturalWidth || img.width;
      editCanvas.height = img.naturalHeight || img.height;
      baseCanvas.width = editCanvas.width;
      baseCanvas.height = editCanvas.height;
      editLayer.width = editCanvas.width;
      editLayer.height = editCanvas.height;
      baseCanvas.getContext("2d")?.drawImage(img, 0, 0);
      layerContext().clearRect(0, 0, editLayer.width, editLayer.height);
      shapeObjects = [];
      previewShape = null;
      cropInteraction = null;
      setCropRect(null);
      resetCameraView();
      renderComposite();
      undoStack = [captureSnapshot()];
      redoStack = [];
      updateHistoryButtons();
      loadedFilePath = targetPath;
    } finally {
      // Only clear the slots if we're still the latest in-flight load.
      // A newer call may have replaced us — don't clobber its state.
      if (editorLoadPromise === myPromise) {
        editorLoadPromise = null;
        editorLoadTarget = null;
      }
    }
  })();
  editorLoadPromise = myPromise;
  editorLoadTarget = targetPath;
  return editorLoadPromise;
}

/// Kick off the editor canvas load in the background after a thumbnail
/// arrives. The user often takes a second or two to look at the tile
/// before deciding to click it — using that idle time to fetch + decode
/// the full PNG means the click → preview transition lands on already-
/// decoded pixels instead of paying the 1-3s IPC + decode cost during
/// the morph. Bailout if a newer screenshot supersedes this slot.
function schedulePreloadEditor(targetPath: string) {
  if (preloadTimerId) {
    window.clearTimeout(preloadTimerId);
    preloadTimerId = 0;
  }
  preloadTimerId = window.setTimeout(() => {
    preloadTimerId = 0;
    if (filePath !== targetPath) return;
    if (isPreviewMode || isDismissing) return;
    if (loadedFilePath === filePath) return;
    void loadEditorCanvas().catch(() => {});
  }, 220);
}

function clearHideTimeout() {
  if (hideTimeoutId) {
    window.clearTimeout(hideTimeoutId);
    hideTimeoutId = 0;
  }
}

function clearToolsReadyTimeout() {
  if (toolsReadyTimeoutId) {
    window.clearTimeout(toolsReadyTimeoutId);
    toolsReadyTimeoutId = 0;
  }
}

function hidePreviewTools() {
  clearToolsReadyTimeout();
  isEditorReady = false;
  shell.classList.remove("tools-ready");
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
}

function showPreviewToolsAfterCentering() {
  hidePreviewTools();
  toolsReadyTimeoutId = window.setTimeout(() => {
    if (isPreviewMode) {
      shell.classList.add("tools-ready");
      window.setTimeout(() => {
        if (isPreviewMode && shell.classList.contains("tools-ready")) {
          isEditorReady = true;
        }
      }, 160);
    }
    toolsReadyTimeoutId = 0;
  }, PREVIEW_TOOLS_DELAY_MS);
}

function setProgress(ratio: number) {
  progress.style.transition = "none";
  progress.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
}

function runTimer() {
  clearHideTimeout();
  timerStartedAt = performance.now();
  progress.getBoundingClientRect();
  progress.style.transition = `transform ${remainingMs}ms linear`;
  progress.style.transform = "scaleX(0)";
  hideTimeoutId = window.setTimeout(() => {
    void hideThumbnail();
  }, remainingMs);
}

function pauseTimer() {
  if (timerPaused) return;

  const elapsed = performance.now() - timerStartedAt;
  remainingMs = Math.max(0, remainingMs - elapsed);
  timerPaused = true;
  clearHideTimeout();
  setProgress(remainingMs / timerDurationMs);
}

function resumeTimer(authoritativeRemainingMs?: number) {
  if (!timerPaused || !filePath || isPinned || isPreviewMode) return;

  // Prefer Rust's remaining over JS's drifted estimate. When a new shot is
  // taken the resume event can land at the same JS tick as the new
  // thumbnail's eval — if we relied on JS pauseTimer's `remainingMs` here,
  // any IPC latency would make this thumbnail finish later than the fresh
  // one even though it has less time left.
  if (typeof authoritativeRemainingMs === "number" && authoritativeRemainingMs >= 0) {
    remainingMs = Math.min(authoritativeRemainingMs, timerDurationMs);
  }

  if (remainingMs <= 0) {
    void hideThumbnail();
    return;
  }

  timerPaused = false;
  runTimer();
}

function resetTimer(durationMs = DISMISS_MS) {
  if (isPinned) return;

  progress.style.transition = "none";
  progress.style.transform = "scaleX(1)";
  timerDurationMs = durationMs;
  remainingMs = durationMs;
  timerPaused = false;
  runTimer();
}

function resetAndPauseTimer(durationMs = DISMISS_MS) {
  if (isPinned) return;

  clearHideTimeout();
  timerDurationMs = durationMs;
  remainingMs = durationMs;
  timerPaused = true;
  setProgress(1);
}

async function hideThumbnail() {
  if (isDismissing) return;

  const shouldDiscardUnsaved = !!filePath && !hasUserSaved;
  setNativePreviewMode(false);
  isDismissing = true;
  clearHideTimeout();
  shell.classList.add("dismissing");
  await new Promise((resolve) => window.setTimeout(resolve, 360));

  try {
    if (shouldDiscardUnsaved) {
      await invoke("discard_unsaved_capture", { path: filePath }).catch(console.error);
    }
    await invoke("hide_thumbnail", { label: currentWindow.label });
  } catch (error) {
    console.error(error);
    currentWindow.hide().catch(console.error);
  } finally {
    shell.classList.remove("dismissing");
    isDismissing = false;
  }
}

function restartTimer() {
  clearHideTimeout();
  resetTimer();
}

function setNativePreviewMode(active: boolean) {
  void invoke("set_thumbnail_preview_mode", {
    label: currentWindow.label,
    active,
  }).catch(console.error);
}

function clearThumbnailRevealFrame() {
  if (thumbnailRevealRaf) {
    window.cancelAnimationFrame(thumbnailRevealRaf);
    thumbnailRevealRaf = 0;
  }
}

function concealThumbnailShell() {
  clearThumbnailRevealFrame();
  thumbnailRevealRequested = false;
  shell.classList.remove("ready");
  shell.classList.add("entering");
}

function revealThumbnailWhenReady() {
  if (!thumbnailRevealRequested || !thumbnailImageReady || thumbnailRevealRaf) return;

  thumbnailRevealRaf = window.requestAnimationFrame(() => {
    thumbnailRevealRaf = window.requestAnimationFrame(() => {
      thumbnailRevealRaf = 0;
      if (!thumbnailRevealRequested || !thumbnailImageReady || isDismissing) return;

      shell.classList.add("ready");
      shell.classList.remove("entering");
    });
  });
}

function requestThumbnailReveal() {
  thumbnailRevealRequested = true;
  revealThumbnailWhenReady();
}

function prepareThumbnailForUpdate() {
  exitOcrMode();
  setNativePreviewMode(false);
  isDismissing = false;
  isPreviewMode = false;
  isEditorReady = false;
  thumbnailImageReady = false;
  drawing = false;
  // New thumbnail data → user hasn't saved this one yet.
  hasUserSaved = false;
  concealThumbnailShell();
  shell.classList.remove("dismissing");
  shell.classList.remove("preview-mode");
  hidePreviewTools();
  cropBox.style.display = "none";
  eraserCursor.style.display = "none";
  statusText.hidden = true;
  image.hidden = true;
  image.removeAttribute("src");
  previewShape = null;
  cropRect = null;
  cropInteraction = null;
  cameraPanState = null;
  cameraZoom = CAMERA_MIN_ZOOM;
  cameraPanX = 0;
  cameraPanY = 0;
  editCanvas.style.setProperty("--camera-x", "0px");
  editCanvas.style.setProperty("--camera-y", "0px");
  editCanvas.style.setProperty("--camera-zoom", "1");
  shell.classList.remove("camera-pannable", "camera-panning");
  strokePoints = [];
  startPoint = null;
  lastPoint = null;
}

function forceThumbnailMode() {
  exitOcrMode();
  isPreviewMode = false;
  isEditorReady = false;
  drawing = false;
  cameraPanState = null;
  startPoint = null;
  lastPoint = null;
  strokePoints = [];
  cropInteraction = null;
  previewShape = null;
  cropRect = null;
  shell.classList.remove("preview-mode", "tools-ready", "camera-pannable", "camera-panning");
  hidePreviewTools();
  resetCameraView();
  if (editCanvas.width && editCanvas.height && baseCanvas.width && baseCanvas.height) {
    renderComposite();
  }
  cropBox.style.display = "none";
  eraserCursor.style.display = "none";
  statusText.hidden = true;
  if (imageDataUrl) {
    image.hidden = false;
  }
  setDrawTool("pencil");
}

function applyThumbnail(data: ThumbnailData) {
  prepareThumbnailForUpdate();
  filePath = data.path;
  imageDataUrl = `data:image/png;base64,${data.image}`;
  if (isPinned) {
    shell.classList.add("pinned");
    pinButton.title = "Unpin";
    pinButton.setAttribute("aria-label", "Unpin");
  } else {
    shell.classList.remove("pinned");
    pinButton.title = "Keep floating";
    pinButton.setAttribute("aria-label", "Keep floating");
  }
  void showImage(imageDataUrl).then(() => {
    thumbnailImageReady = true;
    revealThumbnailWhenReady();
  });
  if (isPinned) {
    pauseTimer();
    void invoke("pin_thumbnail", { label: currentWindow.label }).catch(console.error);
  } else {
    restartTimer();
  }
  // Pre-warm the full editor canvas so a click into preview mode lands
  // on already-decoded pixels — the morph + window resize were ALREADY
  // done by the time loadEditorCanvas finished, so the user saw a
  // visible "waiting" beat after the window jumped to center. Now that
  // beat is gone (the canvas is loaded long before they reach for it).
  schedulePreloadEditor(data.path);
}

async function enterPreviewMode(viewOnly = false) {
  if (!filePath || isPreviewMode || isDismissing) return;

  isPreviewMode = true;
  isEditorReady = false;
  setNativePreviewMode(true);
  pauseTimer();
  hidePreviewTools();
  setDrawTool(drawTool);

  void (async () => {
    try {
      const transition = await invoke<PreviewTransitionStart>("start_thumbnail_preview_transition", {
        label: currentWindow.label,
        image: imageDataUrl,
      });
      // In view-only mode we skip the editor canvas + tools and just show
      // the image at the larger preview size. The shell stays in
      // "preview-mode" *without* "tools-ready", which CSS reads as
      // "image visible, toolbar hidden, edit-canvas hidden".
      const editorReady = viewOnly
        ? Promise.resolve()
        : loadEditorCanvas().catch((error) => {
            console.error(error);
            setStatus("Edit preview unavailable");
          });

      await sleep(transition.durationMs);
      await invoke("expand_thumbnail_preview", { label: currentWindow.label });
      await editorReady;
      shell.classList.add("ready");
      shell.classList.remove("entering");
      shell.classList.add("preview-mode");
      void invoke("hide_preview_transition").catch(console.error);
      if (!viewOnly) {
        showPreviewToolsAfterCentering();
      }
    } catch (error) {
      console.error(error);
      isPreviewMode = false;
      setNativePreviewMode(false);
      shell.classList.remove("preview-mode");
      hidePreviewTools();
      void invoke("hide_preview_transition").catch(console.error);
      requestThumbnailReveal();
      resumeTimer();
    }
  })();
}

function exitPreviewMode() {
  if (!isPreviewMode) return;
  exitOcrMode();

  // Mirror the current edits onto the floating thumbnail tile so the
  // user can see what they did at a glance after minimizing. The actual
  // editor state (baseCanvas, editLayer, shapeObjects, undoStack) stays
  // alive in memory — loadEditorCanvas() reuses it when the user opens
  // this thumbnail again, so undo / erase / rotate continue to work.
  // Nothing is written to disk here; the explicit Save button is what
  // bakes edits into the underlying PNG.
  if (isEditorReady && undoStack.length > 1) {
    imageDataUrl = editCanvas.toDataURL("image/png");
    image.src = imageDataUrl;
  }

  isPreviewMode = false;
  isEditorReady = false;
  setNativePreviewMode(false);
  shell.classList.remove("preview-mode");
  hidePreviewTools();
  cropBox.style.display = "none";
  void invoke("collapse_thumbnail_preview", {
    label: currentWindow.label,
    remainingMs: Math.max(UNPIN_DISMISS_MS, Math.round(remainingMs || UNPIN_DISMISS_MS)),
  }).catch((error) => {
    console.error(error);
    resumeTimer();
  });
  resumeTimer();
}

async function loadThumbnail() {
  try {
    const data = await invoke<ThumbnailData>("get_thumbnail_data", {
      label: currentWindow.label,
    });
    applyThumbnail(data);
  } catch (error) {
    console.error(error);
    statusText.hidden = true;
  }
}

function clearPointerListeners() {
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerCancel);
}

function handlePointerMove(event: PointerEvent) {
  if (!pointerState || event.pointerId !== pointerState.id || pointerState.dragging) return;

  const dx = event.clientX - pointerState.x;
  const dy = event.clientY - pointerState.y;
  if (Math.hypot(dx, dy) < 7) return;

  pointerState.dragging = true;
  pauseTimer();
  preview.classList.add("dragging");
  clearPointerListeners();
  void invoke("start_drag", { path: filePath })
    .catch((error) => {
      console.error("Drag failed:", error);
    })
    .finally(() => {
      preview.classList.remove("dragging");
      pointerState = null;
      resumeTimer();
    });
}

function handlePointerUp(event: PointerEvent) {
  if (!pointerState || event.pointerId !== pointerState.id) return;

  const wasDragging = pointerState.dragging;
  pointerState = null;
  clearPointerListeners();

  if (!wasDragging && !isPreviewMode) {
    void enterPreviewMode();
  }
}

function handlePointerCancel(event: PointerEvent) {
  if (!pointerState || event.pointerId !== pointerState.id) return;

  pointerState = null;
  clearPointerListeners();
  preview.classList.remove("dragging");
  resumeTimer();
}

function strokePath(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

// Live stroke preview. Renders onto the transient strokeLayer so we don't
// have to putImageData(editLayer) every frame. The eraser still gets a
// preview (rendered semi-transparent) and is committed via
// destination-out on pointerup so the user sees what they'll erase.
function renderStrokePreview(points: Point[]) {
  syncStrokeLayerSize();
  const ctx = strokeLayerContext();
  ctx.clearRect(0, 0, strokeLayer.width, strokeLayer.height);
  strokeLayerDirty = false;

  if (points.length < 2) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (drawTool === "eraser") {
    ctx.lineWidth = visualSizeToCanvasSize(eraserSize());
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.globalAlpha = 0.6;
  } else {
    ctx.lineWidth = visualSizeToCanvasSize(currentSize());
    ctx.strokeStyle = colorInput.value;
    ctx.globalAlpha = drawTool === "highlighter" ? 0.34 : 1;
  }

  strokePath(ctx, points);
  ctx.restore();
  strokeLayerDirty = true;
}

// Apply the just-drawn stroke directly to editLayer on pointerup so it
// becomes part of the persistent state. For pencil / highlighter we just
// drawImage the strokeLayer over the editLayer. For eraser we re-run the
// path as a destination-out so it actually subtracts pixels.
function commitStrokeLayer(points: Point[]) {
  if (drawTool === "eraser") {
    if (points.length >= 2) {
      const ctx = layerContext();
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = visualSizeToCanvasSize(eraserSize());
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      strokePath(ctx, points);
      ctx.restore();
    }
  } else if (strokeLayerDirty) {
    const ctx = layerContext();
    ctx.drawImage(strokeLayer, 0, 0);
  }
  clearStrokeLayer();
}

function drawShapePreview(start: Point, end: Point) {
  previewShape = shapeFromPoints(shapeTool, start, end);
  renderComposite();
}

function applyCropRect(rect: CropRect) {
  const normalized = normalizeCropRect(rect);
  const x = Math.round(normalized.x);
  const y = Math.round(normalized.y);
  const w = Math.round(normalized.w);
  const h = Math.round(normalized.h);
  if (w < cropMinSize("width") || h < cropMinSize("height")) return false;

  const before = captureSnapshot();
  const next = document.createElement("canvas");
  next.width = w;
  next.height = h;
  next.getContext("2d")?.drawImage(editCanvas, x, y, w, h, 0, 0, w, h);
  baseCanvas.width = w;
  baseCanvas.height = h;
  editLayer.width = w;
  editLayer.height = h;
  editCanvas.width = w;
  editCanvas.height = h;
  baseCanvas.getContext("2d")?.drawImage(next, 0, 0);
  layerContext().clearRect(0, 0, w, h);
  shapeObjects = [];
  previewShape = null;
  cropInteraction = null;
  setCropRect(null);
  resetCameraView();
  renderComposite();
  commitSnapshot(before);
  return true;
}

function replaceCanvasWith(next: HTMLCanvasElement, before: HTMLCanvasElement, keepCropMode = false) {
  // Transform / AI upscale / remove-bg all swap the canvas out, which
  // invalidates the OCR word-box overlay — drop it.
  exitOcrMode();
  baseCanvas.width = next.width;
  baseCanvas.height = next.height;
  editLayer.width = next.width;
  editLayer.height = next.height;
  editCanvas.width = next.width;
  editCanvas.height = next.height;
  baseCanvas.getContext("2d")?.drawImage(next, 0, 0);
  layerContext().clearRect(0, 0, editLayer.width, editLayer.height);
  shapeObjects = [];
  previewShape = null;
  cropInteraction = null;
  setCropRect(null);
  renderComposite();
  if (keepCropMode && mode === "crop") {
    initDefaultCropRect();
  }
  commitSnapshot(before);
}

function applyTransform(action: TransformAction) {
  if (!isPreviewMode || !isEditorReady) return;

  const before = captureSnapshot();
  flattenShapeObjectsIntoLayer();
  const source = document.createElement("canvas");
  source.width = editCanvas.width;
  source.height = editCanvas.height;
  source.getContext("2d")?.drawImage(editCanvas, 0, 0);

  const next = document.createElement("canvas");
  if (action === "rotate-right" || action === "rotate-left") {
    next.width = source.height;
    next.height = source.width;
  } else {
    next.width = source.width;
    next.height = source.height;
  }

  const ctx = next.getContext("2d");
  if (!ctx) return;

  if (action === "rotate-right") {
    ctx.translate(next.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (action === "rotate-left") {
    ctx.translate(0, next.height);
    ctx.rotate(-Math.PI / 2);
  } else if (action === "flip-x") {
    ctx.translate(next.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, next.height);
    ctx.scale(1, -1);
  }

  ctx.drawImage(source, 0, 0);
  replaceCanvasWith(next, before, mode === "crop");
}

function setAiBusy(next: boolean) {
  aiBusy = next;
  aiButton.disabled = next;
  document.querySelectorAll<HTMLButtonElement>("[data-ai-action]").forEach((button) => {
    button.disabled = next;
  });
}

async function runAiAction(action: AiAction, scale = 2) {
  if (!isPreviewMode || !isEditorReady) return;
  if (aiBusy) return;

  const label =
    action === "upscale"
      ? `Upscale ${scale}x`
      : action === "remove-bg"
        ? "Remove background"
        : "OCR";

  setAiBusy(true);
  setStatus(`${label}...`);

  try {
    // `before` is a canvas snapshot kept for the undo stack. The AI
    // commands, however, want a PNG data URL *string* — captureSnapshot
    // used to return one, but was refactored to return a raw canvas for
    // fast undo/redo. Passing the canvas straight to invoke serialized it
    // to "{}" and the command failed (the "OCR doesn't work" bug). Encode
    // the current canvas to a data URL explicitly for the IPC payload.
    const before = captureSnapshot();
    const sourceDataUrl = await canvasToPngDataUrl(editCanvas);

    if (action === "ocr") {
      const words = await invoke<OcrWord[]>("ai_ocr_layout", { dataUrl: sourceDataUrl });
      enterOcrMode(words);
      return;
    }

    if (action === "upscale") {
      const result = await invoke<{ dataUrl: string; usedAi: boolean }>("ai_upscale_image", {
        dataUrl: sourceDataUrl,
        scale,
      });
      const next = await canvasFromDataUrl(result.dataUrl);
      replaceCanvasWith(next, before, mode === "crop");
      flashStatus(result.usedAi ? `Upscaled ${scale}x (AI)` : `Upscaled ${scale}x`);
      return;
    }

    const dataUrl = await invoke<string>("ai_remove_background", { dataUrl: sourceDataUrl });
    const next = await canvasFromDataUrl(dataUrl);
    replaceCanvasWith(next, before, mode === "crop");
    flashStatus("Background removed");
  } catch (error) {
    flashStatus(String(error));
  } finally {
    setAiBusy(false);
  }
}

preview.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !filePath || isPreviewMode) return;

  event.preventDefault();
  pointerState = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    dragging: false,
  };
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
});

function clearPreviewWindowDrag() {
  if (previewDragState?.raf) {
    window.cancelAnimationFrame(previewDragState.raf);
  }
  previewDragState = null;
  previewDragBar.classList.remove("dragging");
  window.removeEventListener("pointermove", handlePreviewWindowDragMove);
  window.removeEventListener("pointerup", handlePreviewWindowDragEnd);
  window.removeEventListener("pointercancel", handlePreviewWindowDragEnd);
}

function flushPreviewWindowDrag() {
  const state = previewDragState;
  if (!state) return;

  state.raf = 0;
  if (state.moving || (state.pendingX === 0 && state.pendingY === 0)) return;

  const deltaX = state.pendingX;
  const deltaY = state.pendingY;
  state.pendingX = 0;
  state.pendingY = 0;
  state.moving = true;
  void invoke("move_thumbnail_window_by", {
    label: currentWindow.label,
    deltaX,
    deltaY,
  })
    .catch((error) => {
      console.error("Window move failed:", error);
      clearPreviewWindowDrag();
    })
    .finally(() => {
      if (!previewDragState) return;
      previewDragState.moving = false;
      if ((previewDragState.pendingX !== 0 || previewDragState.pendingY !== 0) && !previewDragState.raf) {
        previewDragState.raf = window.requestAnimationFrame(flushPreviewWindowDrag);
      }
    });
}

function handlePreviewWindowDragMove(event: PointerEvent) {
  if (!previewDragState || event.pointerId !== previewDragState.id) return;

  const deltaX = event.screenX - previewDragState.screenX;
  const deltaY = event.screenY - previewDragState.screenY;
  if (deltaX === 0 && deltaY === 0) return;

  previewDragState.screenX = event.screenX;
  previewDragState.screenY = event.screenY;
  previewDragState.pendingX += deltaX;
  previewDragState.pendingY += deltaY;
  if (!previewDragState.raf) {
    previewDragState.raf = window.requestAnimationFrame(flushPreviewWindowDrag);
  }
}

function handlePreviewWindowDragEnd(event: PointerEvent) {
  if (!previewDragState || event.pointerId !== previewDragState.id) return;
  clearPreviewWindowDrag();
}

previewDragBar.addEventListener("pointerdown", (event) => {
  if (!isPreviewMode || !isEditorReady || event.button !== 0) return;

  event.preventDefault();
  previewDragState = {
    id: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    pendingX: 0,
    pendingY: 0,
    raf: 0,
    moving: false,
  };
  previewDragBar.classList.add("dragging");
  previewDragBar.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", handlePreviewWindowDragMove);
  window.addEventListener("pointerup", handlePreviewWindowDragEnd);
  window.addEventListener("pointercancel", handlePreviewWindowDragEnd);
});

function clearCropInteraction(event: PointerEvent) {
  if (!cropInteraction || event.pointerId !== cropInteraction.id) return;

  if (cropBox.hasPointerCapture(event.pointerId)) {
    cropBox.releasePointerCapture(event.pointerId);
  }
  cropInteraction = null;
}

function cancelCropSelection() {
  drawing = false;
  cropInteraction = null;
  startPoint = null;
  lastPoint = null;
  strokePoints = [];
  setCropRect(null);
  setMode("draw");
}

cropBox.addEventListener("pointerdown", (event) => {
  if (!isPreviewMode || !isEditorReady || mode !== "crop" || event.button !== 0 || !cropRect) return;
  if (cropConfirmButton.contains(event.target as Node) || cropCancelButton.contains(event.target as Node)) return;

  event.preventDefault();
  event.stopPropagation();
  const target = event.target as HTMLElement;
  const handle = (target.dataset.cropHandle as CropHandle | undefined) ?? "move";
  cropInteraction = {
    id: event.pointerId,
    handle,
    startPoint: eventToCanvasPoint(event),
    startRect: cropRect,
  };
  cropBox.setPointerCapture(event.pointerId);
});

cropBox.addEventListener("pointermove", (event) => {
  if (!cropInteraction || event.pointerId !== cropInteraction.id) return;

  event.preventDefault();
  event.stopPropagation();
  const point = eventToCanvasPoint(event);
  const dx = point.x - cropInteraction.startPoint.x;
  const dy = point.y - cropInteraction.startPoint.y;
  if (cropInteraction.handle === "move") {
    setCropRect({
      x: cropInteraction.startRect.x + dx,
      y: cropInteraction.startRect.y + dy,
      w: cropInteraction.startRect.w,
      h: cropInteraction.startRect.h,
    });
  } else {
    setCropRect(resizeCropRect(cropInteraction.startRect, cropInteraction.handle, dx, dy));
  }
});

cropBox.addEventListener("pointerup", clearCropInteraction);
cropBox.addEventListener("pointercancel", clearCropInteraction);

cropConfirmButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!isPreviewMode || !isEditorReady || mode !== "crop" || !cropRect) return;

  if (applyCropRect(cropRect)) {
    setDrawTool("pencil");
  }
});

cropCancelButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!isPreviewMode || !isEditorReady || mode !== "crop") return;

  cancelCropSelection();
});

editCanvas.addEventListener(
  "wheel",
  (event) => {
    if (!isPreviewMode || !isEditorReady || !event.ctrlKey) return;

    event.preventDefault();
    const zoomFactor = Math.exp(-event.deltaY * 0.0016);
    setCameraView(cameraZoom * zoomFactor);
  },
  { passive: false },
);

ocrLayer.addEventListener(
  "wheel",
  (event) => {
    if (!isOcrMode || !isPreviewMode || !isEditorReady || !event.ctrlKey) return;

    event.preventDefault();
    event.stopPropagation();
    const zoomFactor = Math.exp(-event.deltaY * 0.0016);
    setCameraView(cameraZoom * zoomFactor);
    renderOcrLayer(ocrWords);
  },
  { passive: false },
);

editCanvas.addEventListener("auxclick", (event) => {
  if (event.button === 1) {
    event.preventDefault();
  }
});

editCanvas.addEventListener("pointerdown", (event) => {
  if (!isPreviewMode || !isEditorReady) return;
  if (isOcrMode) return;

  if (event.button === 1) {
    event.preventDefault();
    if (cameraZoom <= CAMERA_MIN_ZOOM) return;

    cameraPanState = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: cameraPanX,
      panY: cameraPanY,
    };
    shell.classList.add("camera-panning");
    editCanvas.setPointerCapture(event.pointerId);
    return;
  }

  if (event.button !== 0) return;

  event.preventDefault();
  if (mode === "crop") {
    if (!cropRect) initDefaultCropRect();
    else renderCropBox();
    return;
  }

  const point = eventToCanvasPoint(event);
  drawing = true;
  startPoint = point;
  lastPoint = point;
  strokePoints = mode === "draw" ? [point] : [];

  snapshotBeforeAction = captureSnapshot();
  if (mode === "draw") {
    flattenShapeObjectsIntoLayer();
    // strokeLayer holds the in-progress live preview only. Start from a
    // clean slate every pointerdown so the previous (now committed)
    // stroke doesn't ghost-double under the new one.
    clearStrokeLayer();
  }
  editCanvas.setPointerCapture(event.pointerId);
});

// Apply the current OCR drag selection using whichever mode is active.
// Box mode (Ctrl) draws the marquee rectangle and picks intersecting words;
// flow mode (default) hides the rectangle and picks a reading-order run.
function applyOcrDragSelection() {
  if (!ocrDragState) return;
  const { startX, startY, x, y, box } = ocrDragState;
  if (box) {
    setOcrSelectionRect(startX, startY, x, y);
    selectOcrBoxesInRect(startX, startY, x, y);
  } else {
    ocrSelection.style.display = "none";
    selectOcrBoxesFlow(startX, startY, x, y);
  }
}

ocrLayer.addEventListener("pointerdown", (event) => {
  if (!isOcrMode || event.button !== 0) return;

  event.preventDefault();
  event.stopPropagation();
  const point = localPointInOcrLayer(event);
  ocrDragState = {
    id: event.pointerId,
    startX: point.x,
    startY: point.y,
    x: point.x,
    y: point.y,
    box: event.ctrlKey || event.metaKey,
  };
  selectedOcrIds = new Set();
  updateOcrSelectionClasses();
  // Seed the selection from the press point so a plain click (no drag)
  // already selects the word under the cursor.
  applyOcrDragSelection();
  ocrLayer.setPointerCapture(event.pointerId);
});

ocrLayer.addEventListener("pointermove", (event) => {
  if (!isOcrMode || !ocrDragState || event.pointerId !== ocrDragState.id) return;

  event.preventDefault();
  event.stopPropagation();
  const point = localPointInOcrLayer(event);
  ocrDragState.x = point.x;
  ocrDragState.y = point.y;
  applyOcrDragSelection();
});

ocrLayer.addEventListener("pointerup", (event) => {
  if (!isOcrMode || !ocrDragState || event.pointerId !== ocrDragState.id) return;

  event.preventDefault();
  event.stopPropagation();
  const point = localPointInOcrLayer(event);
  ocrDragState.x = point.x;
  ocrDragState.y = point.y;
  applyOcrDragSelection();
  ocrDragState = null;
  if (ocrLayer.hasPointerCapture(event.pointerId)) {
    ocrLayer.releasePointerCapture(event.pointerId);
  }
  ocrSelection.style.display = "none";
  if (selectedOcrIds.size) {
    flashStatus("Text selected");
  }
});

ocrLayer.addEventListener("pointercancel", (event) => {
  if (!ocrDragState || event.pointerId !== ocrDragState.id) return;
  ocrDragState = null;
  ocrSelection.style.display = "none";
});

editCanvas.addEventListener("pointerenter", (event) => {
  if (!isPreviewMode || !isEditorReady) return;
  hoverPoint = eventToCanvasPoint(event);
  updateEraserCursor(hoverPoint);
});

editCanvas.addEventListener("pointerleave", () => {
  hoverPoint = null;
  updateEraserCursor();
});

// rAF-coalesce the in-progress drawing render. Pointermove can fire at
// 1000Hz on modern mice; without batching we'd schedule a full canvas
// composite per event and back up dozens of frames behind a single render
// tick. Drawing is the hot path the user feels most — keep it lean.
let pendingStrokeRaf = 0;
function scheduleStrokeRender() {
  if (pendingStrokeRaf) return;
  pendingStrokeRaf = window.requestAnimationFrame(() => {
    pendingStrokeRaf = 0;
    if (!drawing || !startPoint || !lastPoint) return;
    if (mode === "draw") {
      renderStrokePreview(strokePoints);
      renderComposite();
    } else if (mode === "shape") {
      drawShapePreview(startPoint, lastPoint);
    } else if (mode === "crop") {
      renderCropBox();
    }
  });
}

editCanvas.addEventListener("pointermove", (event) => {
  if (!isPreviewMode || !isEditorReady) return;

  if (cameraPanState && event.pointerId === cameraPanState.id) {
    event.preventDefault();
    setCameraView(
      cameraZoom,
      cameraPanState.panX + event.clientX - cameraPanState.x,
      cameraPanState.panY + event.clientY - cameraPanState.y,
    );
    return;
  }

  const point = eventToCanvasPoint(event);
  hoverPoint = point;
  updateEraserCursor(point);

  if (!drawing || !startPoint || !lastPoint) return;

  if (mode === "draw") {
    strokePoints.push(point);
    lastPoint = point;
    scheduleStrokeRender();
  } else if (mode === "shape") {
    lastPoint = point;
    scheduleStrokeRender();
  } else if (mode === "crop") {
    scheduleStrokeRender();
  }
});

editCanvas.addEventListener("pointerup", (event) => {
  if (cameraPanState && event.pointerId === cameraPanState.id) {
    cameraPanState = null;
    shell.classList.remove("camera-panning");
    if (editCanvas.hasPointerCapture(event.pointerId)) {
      editCanvas.releasePointerCapture(event.pointerId);
    }
    setCameraView(cameraZoom);
    return;
  }

  if (!isPreviewMode || !isEditorReady || !drawing || !startPoint) return;

  const end = eventToCanvasPoint(event);
  drawing = false;
  updateEraserCursor();
  if (editCanvas.hasPointerCapture(event.pointerId)) {
    editCanvas.releasePointerCapture(event.pointerId);
  }

  // Cancel any pending stroke render — we're about to flatten and the
  // next tick's repaint would otherwise still try to draw the live
  // preview on top of the committed pixels.
  if (pendingStrokeRaf) {
    window.cancelAnimationFrame(pendingStrokeRaf);
    pendingStrokeRaf = 0;
  }

  if (mode === "draw") {
    // Flush any moves that hadn't rendered yet, then bake the stroke
    // into editLayer and clear the transient preview.
    strokePoints.push(end);
    renderStrokePreview(strokePoints);
    commitStrokeLayer(strokePoints);
    renderComposite();
    commitSnapshot(snapshotBeforeAction);
  } else if (mode === "shape") {
    const shape = shapeFromPoints(shapeTool, startPoint, end);
    previewShape = null;
    if (shape.w >= 4 || shape.h >= 4) {
      shapeObjects.push(shape);
      renderComposite();
    }
    commitSnapshot(snapshotBeforeAction);
  } else if (mode === "crop") {
    renderCropBox();
  }

  startPoint = null;
  lastPoint = null;
  strokePoints = [];
});

editCanvas.addEventListener("pointercancel", (event) => {
  if (cameraPanState && event.pointerId === cameraPanState.id) {
    cameraPanState = null;
    shell.classList.remove("camera-panning");
    if (editCanvas.hasPointerCapture(event.pointerId)) {
      editCanvas.releasePointerCapture(event.pointerId);
    }
    setCameraView(cameraZoom);
    return;
  }

  drawing = false;
  const wasCropMode = mode === "crop";
  startPoint = null;
  lastPoint = null;
  strokePoints = [];
  if (pendingStrokeRaf) {
    window.cancelAnimationFrame(pendingStrokeRaf);
    pendingStrokeRaf = 0;
  }
  updateEraserCursor();
  if (editCanvas.hasPointerCapture(event.pointerId)) {
    editCanvas.releasePointerCapture(event.pointerId);
  }
  if (wasCropMode) {
    renderCropBox();
  } else {
    // Drop the in-progress preview — the stroke was aborted so nothing
    // gets committed to editLayer.
    clearStrokeLayer();
    renderComposite();
  }
});

editCanvas.addEventListener("dragover", (event) => {
  if (!isPreviewMode || !isEditorReady) return;
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
});

editCanvas.addEventListener("drop", (event) => {
  if (!isPreviewMode || !isEditorReady) return;

  event.preventDefault();
  const color = event.dataTransfer?.getData("text/plain");
  if (!color) return;

  const point = eventToCanvasPoint(event);
  const target = [...shapeObjects]
    .reverse()
    .find((shape) => shapeContainsPoint(shape, point));
  if (!target) return;

  const before = captureSnapshot();
  target.fillColor = color;
  renderComposite();
  commitSnapshot(before);
});

image.addEventListener("error", () => {
  image.hidden = true;
  setStatus("Preview unavailable");
});

closeButton.addEventListener("click", () => {
  void hideThumbnail();
});

// Hover-only copy chip on the floating thumbnail tile. Reads the file
// straight from disk via `copy_to_clipboard` — for the tile (not the
// editor), the on-disk file IS the source of truth; users see the tile
// right after capture, before they've had a chance to edit anything.
// stopPropagation so the underlying preview's pointerdown doesn't also
// fire and try to start a drag.
thumbnailCopyButton.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
});
thumbnailCopyButton.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (!filePath || isPreviewMode || isDismissing) return;
  if (thumbnailCopyButton.classList.contains("active")) return;
  thumbnailCopyButton.classList.add("active");
  try {
    await invoke("copy_to_clipboard", { path: filePath });
    flashStatus("Copied");
  } catch (error) {
    console.error(error);
    flashStatus("Copy failed");
  } finally {
    thumbnailCopyButton.classList.remove("active");
  }
});

minimizeButton.addEventListener("click", () => {
  if (!isPreviewMode || isPinned) return;

  exitPreviewMode();
});

pinButton.addEventListener("click", () => {
  if (!filePath) return;

  if (isPinned) {
    isPinned = false;
    shell.classList.remove("pinned");
    pinButton.title = "Keep floating";
    pinButton.setAttribute("aria-label", "Keep floating");
    timerDurationMs = UNPIN_DISMISS_MS;
    remainingMs = UNPIN_DISMISS_MS;
    setProgress(1);
    void invoke("unpin_thumbnail", {
      label: currentWindow.label,
      remainingMs: UNPIN_DISMISS_MS,
    }).catch(console.error);
    resumeTimer();
    return;
  }

  isPinned = true;
  shell.classList.add("pinned");
  pinButton.title = "Unpin";
  pinButton.setAttribute("aria-label", "Unpin");
  pauseTimer();
  void invoke("pin_thumbnail", { label: currentWindow.label }).catch(console.error);
});

drawButton.addEventListener("click", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  setMode("draw");
});

drawButton.addEventListener("dblclick", () => {
  drawGroup.classList.toggle("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  setMode("draw");
});

shapeButton.addEventListener("click", () => {
  shapeGroup.classList.remove("open");
  drawGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  setMode("shape");
});

shapeButton.addEventListener("dblclick", () => {
  shapeGroup.classList.toggle("open");
  drawGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  setMode("shape");
});

cropButton.addEventListener("click", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  setMode("crop");
});

cropButton.addEventListener("dblclick", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  cropGroup.classList.add("open");
  setMode("crop");
});

transformButton.addEventListener("click", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  aiGroup.classList.remove("open");
  transformGroup.classList.toggle("open");
});

const aiUpscaleToggle = document.querySelector<HTMLButtonElement>("#ai-upscale-toggle")!;
const aiUpscaleScales = document.querySelector<HTMLDivElement>("#ai-upscale-scales")!;

function setUpscaleAccordion(open: boolean) {
  aiUpscaleScales.hidden = !open;
  aiUpscaleToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

aiButton.addEventListener("click", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  const willOpen = !aiGroup.classList.contains("open");
  aiGroup.classList.toggle("open");
  // Each fresh open of the AI menu starts with the Upscale row collapsed.
  if (willOpen) setUpscaleAccordion(false);
});

// "Upscale" row expands to reveal the 2× / 3× / 4× buttons instead of
// listing all three up front.
aiUpscaleToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setUpscaleAccordion(aiUpscaleScales.hidden);
});

document.querySelectorAll<HTMLButtonElement>("[data-crop-ratio]").forEach((button) => {
  button.addEventListener("click", () => {
    const ratio = button.dataset.cropRatio as CropRatioKey | undefined;
    if (ratio && ratio in CROP_RATIOS) setCropRatio(ratio);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-transform-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.transformAction as TransformAction | undefined;
    if (!action) return;

    transformGroup.classList.remove("open");
    applyTransform(action);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-ai-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.aiAction as AiAction | undefined;
    if (!action) return;
    const scale = Number(button.dataset.aiScale ?? "2") || 2;

    aiGroup.classList.remove("open");
    setUpscaleAccordion(false);
    void runAiAction(action, scale);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-draw-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    const tool = button.dataset.drawTool as DrawTool | undefined;
    if (tool) setDrawTool(tool);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-shape-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    const tool = button.dataset.shapeTool as ShapeTool | undefined;
    if (tool) setShapeTool(tool);
  });
});

sizeInput.addEventListener("input", () => {
  setCurrentSize(Number(sizeInput.value));
});

colorInput.addEventListener("input", () => {
  const color = colorInput.value;
  savedColors[editingColorIndex] = color;
  setActiveColor(color);
});

undoButton.addEventListener("click", () => {
  if (undoStack.length <= 1) return;
  const current = undoStack.pop();
  if (!current) return;
  redoStack.push(current);
  drawSnapshot(undoStack[undoStack.length - 1]);
  updateHistoryButtons();
});

redoButton.addEventListener("click", () => {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(next);
  drawSnapshot(next);
  updateHistoryButtons();
});

clearButton.addEventListener("click", () => {
  if (!isPreviewMode || !isEditorReady) return;
  // Wipe only the marker layer (pencil / highlighter / shapes / arrows).
  // baseCanvas is left alone, so any crop / rotate / mirror applied to
  // the underlying image stays put. commitSnapshot is a no-op if there
  // was nothing to clear, so spamming the button doesn't churn history.
  const before = captureSnapshot();
  shapeObjects = [];
  previewShape = null;
  layerContext().clearRect(0, 0, editLayer.width, editLayer.height);
  renderComposite();
  window.setTimeout(() => commitSnapshot(before), 0);
});

// Persistent preferences across edit sessions — both keys live in
// localStorage so the next time the user pops open the save menu their
// most recent destination is the default.
const LAST_GALLERY_FOLDER_KEY = "liem-capture:last-gallery-folder";
const LAST_SAVE_AS_DIR_KEY = "liem-capture:last-save-as-dir";
const saveMenu = document.querySelector<HTMLDivElement>("#save-menu")!;

interface SaveFolderNode {
  name: string;
  path: string;
  children: SaveFolderNode[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fileFolder(p: string): string {
  const slash = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return slash >= 0 ? p.slice(0, slash) : "";
}

function fileBaseName(p: string): string {
  const slash = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function renderSaveRootMenu() {
  // Lock "Save to gallery" only when the user has already saved this
  // thumbnail at least once AND made no changes since. A fresh
  // screenshot (hasUserSaved = false) stays unlocked so the user can
  // still open the picker to move it into a sub-folder.
  // "Save as…" is always available — exporting an unchanged copy
  // somewhere else is a legitimate flow.
  const galleryLocked = hasUserSaved && undoStack.length <= 1;
  saveMenu.innerHTML = [
    `<button class="menu-item${galleryLocked ? " disabled" : ""}" data-save-action="gallery"${galleryLocked ? " disabled aria-disabled=\"true\"" : ""}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 5h16v14H4z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" />
        <path d="M4 16l4-4 4 4 3-3 5 5" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" />
        <circle cx="9" cy="9" r="1.5" stroke="currentColor" stroke-width="1.9" />
      </svg>
      <span>Save to gallery</span>
    </button>`,
    `<button class="menu-item" data-save-action="as">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 4h12l2 2v14H5V4z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" />
        <path d="M16 3v6M13 6h6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
      </svg>
      <span>Save as…</span>
    </button>`,
  ].join("");
}

// ─── Save-to-gallery picker (the full tree + grid modal) ────────────────
const pickerOverlay = document.querySelector<HTMLDivElement>("#save-picker")!;
const pickerTreeEl = document.querySelector<HTMLElement>("#picker-tree")!;
const pickerGridEl = document.querySelector<HTMLDivElement>("#picker-grid")!;
const pickerCurrentName = document.querySelector<HTMLElement>("#picker-current-name")!;
const pickerCloseBtn = document.querySelector<HTMLButtonElement>("#picker-close")!;
const pickerCancelBtn = document.querySelector<HTMLButtonElement>("#picker-cancel")!;
const pickerConfirmBtn = document.querySelector<HTMLButtonElement>("#picker-confirm")!;
const pickerFilenameInput = document.querySelector<HTMLInputElement>("#picker-filename")!;

let pickerTree: SaveFolderNode | null = null;
let pickerSelectedPath: string = ""; // "" = gallery root
let pickerExpandedFolders: Set<string> = new Set();
let pickerSelectedItem: string | null = null;
let pickerKeyboardArea: "tree" | "grid" = "tree";
// Monotonic generation counter — bumped on every renderPickerGrid call so an
// in-flight lazy-load loop can detect it's stale (user switched folders /
// closed the picker) and bail without overwriting newer state.
let pickerGridGeneration = 0;
const pickerPreviewCache: Map<string, string> = new Map();
const pickerMetadataCache: Map<string, GalleryMetadata> = new Map();
// Delay between sequential preview fetches in the save picker. Keeps the
// frame-paint loop free so opening a busy folder doesn't visibly lag the
// editor UI behind it.
const PICKER_PREVIEW_STAGGER_MS = 28;

interface PickerItem { path: string; name: string }
interface GalleryMetadata {
  name: string;
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  modifiedMs: number;
}

const pickerInfoEl = document.querySelector<HTMLElement>("#picker-info")!;

function findPickerFolder(node: SaveFolderNode | null, target: string): SaveFolderNode | null {
  if (!node) return null;
  const nodePath = node === pickerTree ? "" : node.path; // root → ""
  if (nodePath === target) return node;
  for (const child of node.children) {
    const hit = findPickerFolder(child, target);
    if (hit) return hit;
  }
  return null;
}

// ─── Picker dialog (prompt / confirm) ────────────────────────────────────
interface PickerDialogOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  prompt?: boolean; // false → confirm
}

const pickerDialogEl = document.querySelector<HTMLDivElement>("#picker-dialog")!;
const pickerDialogTitleEl = document.querySelector<HTMLElement>("#picker-dialog-title")!;
const pickerDialogMessageEl = document.querySelector<HTMLElement>("#picker-dialog-message")!;
const pickerDialogInputEl = document.querySelector<HTMLInputElement>("#picker-dialog-input")!;
const pickerDialogCancelBtn = document.querySelector<HTMLButtonElement>("#picker-dialog-cancel")!;
const pickerDialogConfirmBtn = document.querySelector<HTMLButtonElement>("#picker-dialog-confirm")!;

let pickerDialogResolver: ((value: string | boolean | null) => void) | null = null;
let pickerDialogIsPrompt = true;

function pickerDialog(opts: PickerDialogOptions): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    pickerDialogResolver = resolve;
    pickerDialogIsPrompt = opts.prompt !== false;
    pickerDialogTitleEl.textContent = opts.title;
    pickerDialogMessageEl.textContent = opts.message ?? "";
    pickerDialogMessageEl.style.display = opts.message ? "" : "none";
    pickerDialogInputEl.style.display = pickerDialogIsPrompt ? "" : "none";
    pickerDialogInputEl.value = opts.defaultValue ?? "";
    pickerDialogInputEl.placeholder = opts.placeholder ?? "";
    pickerDialogConfirmBtn.textContent = opts.confirmLabel ?? (pickerDialogIsPrompt ? "OK" : "Confirm");
    pickerDialogCancelBtn.textContent = opts.cancelLabel ?? "Cancel";
    pickerDialogConfirmBtn.classList.toggle("danger", !!opts.destructive);
    pickerDialogEl.hidden = false;
    if (pickerDialogIsPrompt) {
      window.setTimeout(() => {
        pickerDialogInputEl.focus();
        pickerDialogInputEl.select();
      }, 30);
    } else {
      window.setTimeout(() => pickerDialogConfirmBtn.focus(), 30);
    }
  });
}

function settlePickerDialog(value: string | boolean | null) {
  pickerDialogEl.hidden = true;
  const resolver = pickerDialogResolver;
  pickerDialogResolver = null;
  resolver?.(value);
}

pickerDialogCancelBtn.addEventListener("click", () => {
  settlePickerDialog(pickerDialogIsPrompt ? null : false);
});
pickerDialogConfirmBtn.addEventListener("click", () => {
  if (pickerDialogIsPrompt) {
    const value = pickerDialogInputEl.value.trim();
    if (!value) return; // require non-empty
    settlePickerDialog(value);
  } else {
    settlePickerDialog(true);
  }
});
pickerDialogInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    pickerDialogConfirmBtn.click();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    pickerDialogCancelBtn.click();
  }
});

// ─── Tree rendering with expand/collapse + hover actions ────────────────
const CHEVRON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const FOLDER_ICON = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="picker-tree-icon"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" /></svg>`;

function renderPickerTree() {
  if (!pickerTree) {
    pickerTreeEl.innerHTML = `<div class="picker-empty">Gallery unavailable</div>`;
    return;
  }
  const items: string[] = [];

  const walk = (node: SaveFolderNode, depth: number, isRoot: boolean) => {
    const path = isRoot ? "" : node.path;
    const active = path === pickerSelectedPath;
    const hasChildren = node.children.length > 0;
    // Root uses its absolute path as the expansion key (matching the
    // actual `data-folder-path` we serialize). Non-root nodes likewise.
    // openSavePicker seeds the root key so it defaults to expanded.
    const expandKey = isRoot ? node.path : node.path;
    const expanded = hasChildren && pickerExpandedFolders.has(expandKey);

    const chevron = hasChildren
      ? `<button class="picker-tree-chevron${expanded ? " expanded" : ""}" data-tree-action="toggle" data-folder-path="${escapeHtml(isRoot ? "__root__" : path)}" title="${expanded ? "Collapse" : "Expand"}">${CHEVRON_SVG}</button>`
      : `<span class="picker-tree-chevron-placeholder"></span>`;

    const actions = `
      <div class="picker-tree-actions">
        <button data-tree-action="create" data-folder-path="${escapeHtml(path)}" title="New folder inside" aria-label="New folder">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M12 11v6M9 14h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        ${isRoot ? "" : `
          <button data-tree-action="rename" data-folder-path="${escapeHtml(path)}" title="Rename" aria-label="Rename">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 00-3-3L5.2 16 4 20z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="danger" data-tree-action="delete" data-folder-path="${escapeHtml(path)}" title="Delete folder" aria-label="Delete folder">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 7h14M10 11v6M14 11v6M8 7l.7 12h6.6L16 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        `}
      </div>`;

    items.push(
      `<div class="picker-tree-row${active ? " active" : ""}" data-folder-path="${escapeHtml(path)}" data-tree-action="select" data-tree-depth="${depth}" data-tree-has-children="${hasChildren ? "true" : "false"}" data-tree-expanded="${expanded ? "true" : "false"}" style="padding-left: ${4 + depth * 12}px;">
        ${chevron}
        ${FOLDER_ICON}
        <span class="picker-tree-label">${escapeHtml(node.name)}</span>
        ${actions}
      </div>`,
    );

    if (expanded) {
      for (const child of node.children) walk(child, depth + 1, false);
    }
  };

  walk(pickerTree, 0, true);
  pickerTreeEl.innerHTML = items.join("");
}

async function refreshPickerTree() {
  try {
    pickerTree = await invoke<SaveFolderNode>("list_gallery_tree");
  } catch (error) {
    console.error(error);
    pickerTree = null;
  }
  renderPickerTree();
}

// ─── Folder operations (create / rename / delete) ───────────────────────
async function handleTreeCreate(parentPath: string) {
  const folder = findPickerFolder(pickerTree, parentPath);
  const parentName = folder?.name ?? "Liem Capture";
  const name = await pickerDialog({
    title: "New folder",
    message: `Inside "${parentName}"`,
    placeholder: "Folder name",
    confirmLabel: "Create",
    prompt: true,
  }) as string | null;
  if (!name) return;
  try {
    await invoke("create_gallery_folder", {
      parent: parentPath === "" ? null : parentPath,
      name,
    });
    if (parentPath) pickerExpandedFolders.add(parentPath);
    await refreshPickerTree();
  } catch (error) {
    await pickerDialog({ title: "Could not create folder", message: String(error), prompt: false });
  }
}

async function handleTreeRename(path: string) {
  const folder = findPickerFolder(pickerTree, path);
  if (!folder) return;
  const next = await pickerDialog({
    title: "Rename folder",
    defaultValue: folder.name,
    placeholder: "New name",
    confirmLabel: "Rename",
    prompt: true,
  }) as string | null;
  if (!next || next === folder.name) return;
  try {
    const newPath = await invoke<string>("rename_gallery_folder", { path, newName: next });
    if (pickerSelectedPath === path) pickerSelectedPath = newPath;
    if (pickerExpandedFolders.has(path)) {
      pickerExpandedFolders.delete(path);
      pickerExpandedFolders.add(newPath);
    }
    await refreshPickerTree();
    updatePickerCurrentLabel();
    refreshPickerGridView();
  } catch (error) {
    await pickerDialog({ title: "Could not rename", message: String(error), prompt: false });
  }
}

async function handleTreeDelete(path: string) {
  const folder = findPickerFolder(pickerTree, path);
  if (!folder) return;
  const confirmed = await pickerDialog({
    title: "Delete folder?",
    message: `"${folder.name}" and everything inside will be removed. This cannot be undone.`,
    confirmLabel: "Delete",
    destructive: true,
    prompt: false,
  }) as boolean;
  if (!confirmed) return;
  try {
    await invoke("delete_gallery_folder", { path });
    if (pickerSelectedPath === path) pickerSelectedPath = "";
    pickerExpandedFolders.delete(path);
    await refreshPickerTree();
    updatePickerCurrentLabel();
    refreshPickerGridView();
  } catch (error) {
    await pickerDialog({ title: "Could not delete", message: String(error), prompt: false });
  }
}

function togglePickerExpand(path: string) {
  // "__root__" sentinel comes from the root row's chevron. Translate
  // it to the gallery root's absolute path so both sides agree on the
  // expansion key.
  const key = path === "__root__" ? (pickerTree?.path ?? "") : path;
  if (pickerExpandedFolders.has(key)) pickerExpandedFolders.delete(key);
  else pickerExpandedFolders.add(key);
  renderPickerTree();
}

function refreshPickerGridView() {
  void renderPickerGrid();
}

function selectPickerFolder(path: string) {
  pickerSelectedPath = path;
  pickerSelectedItem = null;
  renderPickerTree();
  renderPickerInfo();
  updatePickerCurrentLabel();
  refreshPickerGridView();
  pickerTreeEl
    .querySelector<HTMLElement>(`[data-tree-action="select"][data-folder-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function visiblePickerRows() {
  return Array.from(pickerTreeEl.querySelectorAll<HTMLElement>(".picker-tree-row[data-folder-path]"));
}

function visiblePickerTiles() {
  return Array.from(pickerGridEl.querySelectorAll<HTMLElement>("[data-preview-path]"));
}

function selectPickerTile(path: string | null) {
  pickerSelectedItem = path;
  pickerGridEl.querySelectorAll<HTMLElement>(".picker-tile.selected").forEach((el) => {
    el.classList.remove("selected");
  });
  if (pickerSelectedItem) {
    const tile = pickerGridEl.querySelector<HTMLElement>(
      `[data-preview-path="${CSS.escape(pickerSelectedItem)}"]`,
    );
    tile?.classList.add("selected");
    tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  renderPickerInfo();
}

function movePickerTreeSelection(delta: number) {
  const rows = visiblePickerRows();
  if (!rows.length) return;
  const currentIndex = rows.findIndex((row) => (row.dataset.folderPath ?? "") === pickerSelectedPath);
  const baseIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = Math.max(0, Math.min(rows.length - 1, baseIndex + delta));
  selectPickerFolder(rows[nextIndex].dataset.folderPath ?? "");
}

function movePickerGridSelection(delta: number) {
  const tiles = visiblePickerTiles();
  if (!tiles.length) return;
  const currentIndex = pickerSelectedItem
    ? tiles.findIndex((tile) => tile.dataset.previewPath === pickerSelectedItem)
    : -1;
  const baseIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = Math.max(0, Math.min(tiles.length - 1, baseIndex + delta));
  selectPickerTile(tiles[nextIndex].dataset.previewPath ?? null);
}

// Single delegated handler covers every tree-row interaction. The
// `data-tree-action` attribute on the inner button (or the row itself
// for plain selection) decides which path to take.
pickerTreeEl.addEventListener("click", (event) => {
  pickerKeyboardArea = "tree";
  const actionEl = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tree-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.treeAction;
  const path = actionEl.dataset.folderPath ?? "";

  if (action === "toggle") {
    event.stopPropagation();
    togglePickerExpand(path);
    return;
  }
  if (action === "create") { event.stopPropagation(); void handleTreeCreate(path); return; }
  if (action === "rename") { event.stopPropagation(); void handleTreeRename(path); return; }
  if (action === "delete") { event.stopPropagation(); void handleTreeDelete(path); return; }

  // Default = row click = select folder.
  if (path !== pickerSelectedPath) {
    selectPickerFolder(path);
  }
});

async function renderPickerGrid() {
  // Snapshot the generation + folder we were called with. If the user
  // switches folders or closes the picker mid-load, every async step below
  // checks these and bails so it can't overwrite the fresher view.
  const generation = ++pickerGridGeneration;
  const folder = pickerSelectedPath;

  pickerGridEl.classList.remove("is-prompt");
  pickerGridEl.innerHTML = `<div class="picker-empty">Loading…</div>`;
  let items: PickerItem[] = [];
  try {
    items = await invoke<PickerItem[]>("list_gallery_items", {
      folder: folder === "" ? null : folder,
    });
  } catch (error) {
    console.error(error);
    if (generation !== pickerGridGeneration) return;
    pickerGridEl.innerHTML = `<div class="picker-empty">Could not list folder</div>`;
    if (pickerSelectedItem) {
      pickerSelectedItem = null;
      renderPickerInfo();
    }
    return;
  }
  if (generation !== pickerGridGeneration) return;

  // Clear stale selection if the previously-selected file is no longer
  // in the visible folder.
  if (pickerSelectedItem && !items.some((it) => it.path === pickerSelectedItem)) {
    pickerSelectedItem = null;
    renderPickerInfo();
  }
  if (items.length === 0) {
    pickerGridEl.innerHTML = `<div class="picker-empty">Folder is empty</div>`;
    return;
  }

  // Render every tile as an empty placeholder right away. The grid layout
  // is final before any preview comes in, so the editor underneath never
  // sees a jank-y reflow. Previews then drop in one-by-one below.
  pickerGridEl.innerHTML = items
    .map((it) => {
      const selected = pickerSelectedItem === it.path ? " selected" : "";
      return `<div class="picker-tile${selected}" data-preview-path="${escapeHtml(it.path)}" title="${escapeHtml(it.name)}"></div>`;
    })
    .join("");

  // Sequential lazy load. Previously every visible tile fired its preview
  // request in parallel, which hammered Rust with N decodes the moment the
  // picker opened — that's the "jetlag" feel the user described. Stagger
  // each fetch by PICKER_PREVIEW_STAGGER_MS so the UI thread + IPC channel
  // stay breathing.
  for (const it of items) {
    if (generation !== pickerGridGeneration) return;
    const tile = pickerGridEl.querySelector<HTMLElement>(
      `[data-preview-path="${CSS.escape(it.path)}"]`,
    );
    if (!tile) continue;

    const cached = pickerPreviewCache.get(it.path);
    if (cached !== undefined) {
      tile.innerHTML = `<img src="data:image/png;base64,${cached}" draggable="false" />`;
      continue;
    }

    try {
      const b64 = await invoke<string>("get_gallery_preview", { path: it.path });
      if (generation !== pickerGridGeneration) return;
      pickerPreviewCache.set(it.path, b64);
      if (tile.isConnected) {
        tile.innerHTML = `<img src="data:image/png;base64,${b64}" draggable="false" />`;
      }
    } catch (err) {
      console.error(err);
    }

    await new Promise((resolve) => window.setTimeout(resolve, PICKER_PREVIEW_STAGGER_MS));
  }
}

function fileBaseNameNoExt(p: string): string {
  const base = fileBaseName(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function renderPickerInfo() {
  if (!pickerSelectedItem) {
    pickerInfoEl.hidden = true;
    pickerInfoEl.innerHTML = "";
    return;
  }
  const path = pickerSelectedItem;
  const meta = pickerMetadataCache.get(path);
  const preview = pickerPreviewCache.get(path);
  const name = meta?.name ?? fileBaseName(path);

  pickerInfoEl.hidden = false;
  pickerInfoEl.innerHTML = `
    <div class="picker-info-header">
      <span class="picker-info-header-title">Info</span>
      <button class="picker-info-icon-btn" data-info-action="close" title="Close">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <div class="picker-info-preview">
      ${preview ? `<img src="data:image/png;base64,${preview}" draggable="false" />` : ""}
    </div>
    <div class="picker-info-row picker-info-name-row">
      <div style="flex: 1; min-width: 0;">
        <span class="picker-info-label">Name</span>
        <div class="picker-info-value">${escapeHtml(name)}</div>
      </div>
      <button class="picker-info-icon-btn" data-info-action="rename" title="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 00-3-3L5.2 16 4 20z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="picker-info-icon-btn danger" data-info-action="delete" title="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 7h14M10 11v6M14 11v6M8 7l.7 12h6.6L16 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    ${meta ? `
      <div class="picker-info-row">
        <span class="picker-info-label">Resolution</span>
        <div class="picker-info-value">${meta.width} × ${meta.height} px</div>
      </div>
      <div class="picker-info-row">
        <span class="picker-info-label">Size</span>
        <div class="picker-info-value">${formatPickerBytes(meta.sizeBytes)}</div>
      </div>
      <div class="picker-info-row">
        <span class="picker-info-label">Taken</span>
        <div class="picker-info-value">${formatPickerDate(meta.modifiedMs)}</div>
      </div>
    ` : `<div class="picker-info-row"><div class="picker-info-value" style="color: rgba(255,255,255,0.55);">Loading info…</div></div>`}
  `;

  if (!meta) {
    invoke<GalleryMetadata>("get_gallery_metadata", { path })
      .then((m) => {
        pickerMetadataCache.set(path, m);
        if (pickerSelectedItem === path) renderPickerInfo();
      })
      .catch(console.error);
  }
}

function formatPickerBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatPickerDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return new Date(ms).toString();
  }
}

async function renamePickerItem(path: string) {
  const stem = fileBaseNameNoExt(path);
  const next = await pickerDialog({
    title: "Rename screenshot",
    defaultValue: stem,
    placeholder: "New name",
    confirmLabel: "Rename",
    prompt: true,
  }) as string | null;
  if (!next || next === stem) return;
  try {
    const newPath = await invoke<string>("rename_gallery_item", { path, newName: next });
    // Migrate caches over to the new path so we don't refetch the
    // preview and metadata we already have.
    const preview = pickerPreviewCache.get(path);
    if (preview !== undefined) {
      pickerPreviewCache.set(newPath, preview);
      pickerPreviewCache.delete(path);
    }
    pickerMetadataCache.delete(path);
    if (pickerSelectedItem === path) pickerSelectedItem = newPath;
    await renderPickerGrid();
    renderPickerInfo();
  } catch (error) {
    await pickerDialog({ title: "Could not rename", message: String(error), prompt: false });
  }
}

async function deletePickerItem(path: string) {
  const baseName = fileBaseName(path);
  const confirmed = await pickerDialog({
    title: "Delete screenshot?",
    message: `"${baseName}" will be removed. This cannot be undone.`,
    confirmLabel: "Delete",
    destructive: true,
    prompt: false,
  }) as boolean;
  if (!confirmed) return;
  try {
    await invoke("delete_gallery_item", { path });
    pickerPreviewCache.delete(path);
    pickerMetadataCache.delete(path);
    if (pickerSelectedItem === path) pickerSelectedItem = null;
    await renderPickerGrid();
    renderPickerInfo();
  } catch (error) {
    await pickerDialog({ title: "Could not delete", message: String(error), prompt: false });
  }
}

// Click on a tile in the grid → select for info viewing.
pickerGridEl.addEventListener("click", (event) => {
  pickerKeyboardArea = "grid";
  const tile = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-preview-path]");
  if (!tile) return;
  const path = tile.dataset.previewPath ?? "";
  selectPickerTile(pickerSelectedItem === path ? null : path);
});

// Info panel action delegation (close / rename / delete).
pickerInfoEl.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-info-action]");
  if (!target || !pickerSelectedItem) return;
  const action = target.dataset.infoAction;
  if (action === "close") {
    pickerSelectedItem = null;
    pickerGridEl.querySelectorAll<HTMLElement>(".picker-tile.selected").forEach((el) => el.classList.remove("selected"));
    renderPickerInfo();
  } else if (action === "rename") {
    void renamePickerItem(pickerSelectedItem);
  } else if (action === "delete") {
    void deletePickerItem(pickerSelectedItem);
  }
});

// F2 → rename selected file (or current folder if no file selected).
// Delete → delete selected file (or current folder if root has no item).
window.addEventListener("keydown", (event) => {
  if (pickerOverlay.hidden) return;
  // Don't hijack typing inside the filename input / dialog input.
  const t = event.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  // Don't fire while a dialog is open (its own listeners handle keys).
  if (!pickerDialogEl.hidden) return;

  const isArrow = event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown";
  if (isArrow) {
    event.preventDefault();
    event.stopPropagation();

    if (pickerKeyboardArea === "grid" && visiblePickerTiles().length > 0) {
      const delta =
        event.key === "ArrowLeft" ? -1 :
        event.key === "ArrowRight" ? 1 :
        event.key === "ArrowUp" ? -3 :
        3;
      movePickerGridSelection(delta);
      return;
    }

    pickerKeyboardArea = "tree";
    if (event.key === "ArrowDown") {
      movePickerTreeSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      movePickerTreeSelection(-1);
      return;
    }

    const currentRow = visiblePickerRows().find((row) => (row.dataset.folderPath ?? "") === pickerSelectedPath);
    if (!currentRow) return;
    const hasChildren = currentRow.dataset.treeHasChildren === "true";
    const expanded = currentRow.dataset.treeExpanded === "true";
    if (event.key === "ArrowRight" && hasChildren && !expanded) {
      togglePickerExpand(pickerSelectedPath === "" ? "__root__" : pickerSelectedPath);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (hasChildren && expanded) {
        togglePickerExpand(pickerSelectedPath === "" ? "__root__" : pickerSelectedPath);
        return;
      }
      const currentDepth = Number(currentRow.dataset.treeDepth ?? "0");
      if (currentDepth <= 0) return;
      const rows = visiblePickerRows();
      const currentIndex = rows.indexOf(currentRow);
      for (let i = currentIndex - 1; i >= 0; i -= 1) {
        if (Number(rows[i].dataset.treeDepth ?? "0") === currentDepth - 1) {
          selectPickerFolder(rows[i].dataset.folderPath ?? "");
          return;
        }
      }
    }
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    confirmSaveFromPicker();
    return;
  }

  if (event.key === "F2") {
    event.preventDefault();
    event.stopPropagation();
    if (pickerSelectedItem) void renamePickerItem(pickerSelectedItem);
    else if (pickerSelectedPath) void handleTreeRename(pickerSelectedPath);
    return;
  }
  if (event.key === "Delete") {
    event.preventDefault();
    event.stopPropagation();
    if (pickerSelectedItem) void deletePickerItem(pickerSelectedItem);
    else if (pickerSelectedPath) void handleTreeDelete(pickerSelectedPath);
  }
}, true);

function updatePickerCurrentLabel() {
  const folder = findPickerFolder(pickerTree, pickerSelectedPath);
  pickerCurrentName.textContent = folder?.name ?? "…";
}

function autoExpandAncestors(rootPath: string, targetPath: string) {
  if (!targetPath || targetPath === rootPath) return;
  // The path "D:/Liem Capture/Foo/Bar" needs every ancestor segment
  // expanded so the selected node is actually visible. Walk parents
  // until we hit the gallery root (or filesystem root as a fallback).
  let current = targetPath;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (current && current !== rootPath) {
    pickerExpandedFolders.add(current);
    const slash = Math.max(current.lastIndexOf("\\"), current.lastIndexOf("/"));
    if (slash <= 0) break;
    const parent = current.slice(0, slash);
    if (parent === current) break;
    current = parent;
  }
}

async function openSavePicker() {
  if (!filePath || !isPreviewMode || !isEditorReady) return;
  try {
    pickerTree = await invoke<SaveFolderNode>("list_gallery_tree");
  } catch (error) {
    console.error(error);
    pickerTree = null;
  }
  // Default selection: if this file is ALREADY in the gallery, anchor the
  // picker to its current folder so an absent-minded "Save" overwrites in
  // place instead of moving the file to some unrelated last-used folder.
  // The remembered folder is reserved for fresh screenshots (still living
  // in the temp capture dir) where we genuinely don't know where to put
  // them yet.
  //
  // Without this guard the previous logic preferred LAST_GALLERY_FOLDER_KEY
  // unconditionally, so a re-edit + Save would silently relocate the file
  // to wherever the user last saved something else — and the original copy
  // got deleted because Rust treats "saved to a different path" as a move.
  const galleryRootPath = pickerTree?.path ?? "";
  const currentFolder = fileFolder(filePath);
  const inGallery = !!galleryRootPath
    && (currentFolder === galleryRootPath
      || currentFolder.startsWith(galleryRootPath + "\\")
      || currentFolder.startsWith(galleryRootPath + "/"));

  if (inGallery) {
    if (currentFolder === galleryRootPath) {
      pickerSelectedPath = ""; // root sentinel
    } else if (findPickerFolder(pickerTree, currentFolder)) {
      pickerSelectedPath = currentFolder;
    } else {
      pickerSelectedPath = "";
    }
  } else {
    const remembered = localStorage.getItem(LAST_GALLERY_FOLDER_KEY);
    pickerSelectedPath = remembered !== null && findPickerFolder(pickerTree, remembered)
      ? remembered
      : "";
  }
  // Root defaults to expanded the first time the user opens the picker.
  // After that we respect whatever expansion state they left it in.
  if (pickerTree) {
    if (!pickerExpandedFolders.has(pickerTree.path)
        && !pickerExpandedFolders.has("__root_seen__")) {
      pickerExpandedFolders.add(pickerTree.path);
      pickerExpandedFolders.add("__root_seen__");
    }
  }
  // Make sure the selected folder is visible in the tree.
  if (pickerTree && pickerSelectedPath) {
    autoExpandAncestors(pickerTree.path, pickerSelectedPath);
  }
  pickerSelectedItem = null;
  // Pre-fill the filename input with the current file's name (without
  // the .png extension — that's added as a static suffix in the UI).
  const baseName = fileBaseName(filePath);
  const dotIdx = baseName.lastIndexOf(".");
  pickerFilenameInput.value = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName;

  renderPickerTree();
  renderPickerInfo();
  updatePickerCurrentLabel();
  refreshPickerGridView();
  pickerOverlay.hidden = false;
  // Focus + select the name input so users can immediately type a new
  // name or hit Enter to accept the default.
  window.setTimeout(() => {
    pickerFilenameInput.focus();
    pickerFilenameInput.select();
  }, 50);
}

function closeSavePicker() {
  pickerOverlay.hidden = true;
  pickerSelectedItem = null;
  renderPickerInfo();
  if (!pickerDialogEl.hidden) settlePickerDialog(null);
}

pickerCloseBtn.addEventListener("click", closeSavePicker);
pickerCancelBtn.addEventListener("click", closeSavePicker);

function confirmSaveFromPicker() {
  const dest = pickerSelectedPath;
  const name = pickerFilenameInput.value.trim();
  closeSavePicker();
  void saveToFolder(dest, name.length > 0 ? name : null);
}

pickerConfirmBtn.addEventListener("click", confirmSaveFromPicker);

// Enter in the filename input → submit. Esc in the input → close picker
// (the global Esc handler below also handles this but capturing here
// stops the input's own keydown from doing anything weird first).
pickerFilenameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    confirmSaveFromPicker();
  }
});

// Esc closes the picker (when it's open) without disturbing the editor.
// If a dialog is layered on top of the picker, Esc unwinds that first
// so users can back out one step at a time.
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || pickerOverlay.hidden) return;
  event.preventDefault();
  event.stopPropagation();
  if (!pickerDialogEl.hidden) {
    settlePickerDialog(pickerDialogIsPrompt ? null : false);
  } else {
    closeSavePicker();
  }
}, true);

// PNG-encode the editor canvas without freezing the main thread.
// `toDataURL` does a synchronous encode that can take 200-500ms on a 4K
// canvas, which is exactly the "ngeframe dulu" lag the user reported when
// saving. `toBlob` hands the encode to a worker; we then read the bytes as
// a data URL via FileReader (also off-thread). Main-thread cost drops to
// nearly zero.
function canvasToPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Canvas encode failed"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
      reader.readAsDataURL(blob);
    }, "image/png");
  });
}

// Tracks an in-flight save so a double-click on the menu can't spawn
// two concurrent invokes (each would auto-version because hasEdits=true,
// littering the gallery with phantom duplicates).
let saveInFlight = false;

async function saveToFolder(folderPath: string, destName: string | null = null) {
  if (saveInFlight) return;
  if (!filePath || !isPreviewMode || !isEditorReady) return;
  saveInFlight = true;
  saveButton.classList.add("active");
  flashStatus("Saving…");

  // Capture the inputs to the save at the moment the user clicked. If
  // they kick off another save (or open a different gallery item) while
  // this one is in flight we want to land THIS file's pixels at THIS
  // path — not whatever state the editor has drifted to.
  const hasEdits = undoStack.length > 1;
  const savingFromPath = filePath;

  // Whole pipeline runs in the background so the editor canvas stays
  // responsive. Before this, the user reported a freeze right after Save
  // — the encode + IPC took 300-800ms, and worse, the post-save
  // `undoStack = [dataUrl]` reset triggered a GC pause when it dropped
  // multiple multi-megabyte snapshot strings, stalling the next pointer
  // frame. Now everything heavy is fire-and-forget; the editor is back
  // in the user's hands immediately.
  void (async () => {
    try {
      const dataUrl = await canvasToPngDataUrl(editCanvas);
      const data = await invoke<ThumbnailData>("save_edited_thumbnail", {
        label: currentWindow.label,
        path: savingFromPath,
        dataUrl,
        destFolder: folderPath === "" ? null : folderPath,
        destName,
        hasEdits,
      });

      // Only re-anchor file metadata if the user is still editing the
      // same file. If they swapped to another gallery item mid-save the
      // path now points elsewhere and we must not stomp on it.
      //
      // We DON'T blow away the undo stack here anymore. The save is a
      // side effect; the user's edit history stays intact so they can
      // keep undoing past the save point. The old behaviour of
      // `undoStack = [dataUrl]` was the main cause of the post-save
      // freeze the user complained about.
      //
      // We also DON'T touch `image.src`. That element backs the small
      // floating tile, which isn't visible while we're in preview mode.
      // When the user collapses back to the tile, the existing
      // `imageDataUrl` value is already current enough — and skipping
      // the assignment avoids a preview PNG decode in the hot path.
      if (filePath === savingFromPath) {
        filePath = data.path;
        loadedFilePath = data.path;
        imageDataUrl = `data:image/png;base64,${data.image}`;
      }
      flashStatus("Saved");
      hasUserSaved = true;
      localStorage.setItem(LAST_GALLERY_FOLDER_KEY, folderPath);
    } catch (error) {
      // Rust returns descriptive strings for the "nothing to save" and
      // "duplicate exists" guards; surface them in the status pill so the
      // user knows why the click didn't take.
      const message = typeof error === "string" ? error : "Save failed";
      console.error(error);
      flashStatus(message);
    } finally {
      saveButton.classList.remove("active");
      saveInFlight = false;
    }
  })();
}

async function saveAs() {
  if (!filePath || !isPreviewMode || !isEditorReady) return;
  // Lazy-load the dialog plugin so the cold start of the thumbnail
  // window isn't paying for code that most users never invoke.
  const { save } = await import("@tauri-apps/plugin-dialog");

  const baseName = fileBaseName(filePath);
  const lastDir = localStorage.getItem(LAST_SAVE_AS_DIR_KEY);
  const defaultPath = lastDir ? `${lastDir}\\${baseName}` : baseName;

  let chosen: string | null = null;
  try {
    chosen = await save({
      defaultPath,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
  } catch (error) {
    console.error(error);
    flashStatus("Save failed");
    return;
  }
  if (!chosen) return; // user cancelled

  saveButton.disabled = true;
  saveButton.classList.add("active");
  try {
    const dataUrl = await canvasToPngDataUrl(editCanvas);
    await invoke("export_png_to_path", { path: chosen, dataUrl });
    flashStatus("Saved");
    const dir = fileFolder(chosen);
    if (dir) localStorage.setItem(LAST_SAVE_AS_DIR_KEY, dir);
  } catch (error) {
    console.error(error);
    flashStatus("Save failed");
  } finally {
    saveButton.disabled = false;
    saveButton.classList.remove("active");
  }
}

// Tracks an in-flight clipboard push so a double-click on the button can't
// queue up two `set_image` calls in a row. For large shots the second push
// would be wasted work — Windows would broadcast WM_CLIPBOARDUPDATE twice
// and every clipboard listener would re-read the same pixels.
let copyInFlight = false;

async function copyEditorToClipboard() {
  if (copyInFlight) return;
  if (!filePath || !isPreviewMode || !isEditorReady) return;
  copyInFlight = true;
  copyButton.classList.add("active");
  flashStatus("Copying…");
  try {
    const dataUrl = await canvasToPngDataUrl(editCanvas);
    await invoke("copy_image_dataurl_to_clipboard", { dataUrl });
    flashStatus("Copied");
  } catch (error) {
    console.error(error);
    flashStatus("Copy failed");
  } finally {
    copyButton.classList.remove("active");
    copyInFlight = false;
  }
}

copyButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (copyButton.disabled) return;
  void copyEditorToClipboard();
});

saveButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (saveButton.disabled) return;
  if (saveGroup.classList.contains("open")) {
    saveGroup.classList.remove("open");
    return;
  }
  renderSaveRootMenu();
  saveGroup.classList.add("open");
});

saveGroup.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)
    ?.closest<HTMLElement>("[data-save-action]");
  if (!target) return;
  event.stopPropagation();
  // Locked entries (e.g. "Save to gallery" when there's nothing new) get
  // a disabled attribute and a "No changes" hint. Swallow the click so
  // nothing happens — leaving the menu open lets the user pick another
  // option without having to reopen it.
  if (target.hasAttribute("disabled")) return;
  saveGroup.classList.remove("open");

  const action = target.dataset.saveAction;
  if (action === "gallery") void openSavePicker();
  else if (action === "as") void saveAs();
});

listen("liem-thumbnail-pause", () => {
  pauseTimer();
}).catch(console.error);

listen<number | null>("liem-thumbnail-resume", (event) => {
  resumeTimer(typeof event.payload === "number" ? event.payload : undefined);
}).catch(console.error);

listen<number>("liem-thumbnail-restart", (event) => {
  resetTimer(event.payload || DISMISS_MS);
}).catch(console.error);

// Rust's auto-dismiss timer fires this when the thumbnail's lifetime ends.
// Going through hideThumbnail() ensures the 360ms slide-out animation plays
// before the window is hidden natively. The payload carries the label of the
// thumbnail being dismissed — Tauri v2 broadcasts emit() to every webview,
// so we have to filter here, otherwise *all* thumbnails dismiss together
// whenever any one of them times out.
listen<string>("liem-thumbnail-auto-dismiss", (event) => {
  if (event.payload !== currentWindow.label) return;
  void hideThumbnail();
}).catch(console.error);

// Fired by Rust when the user clicks an item in the overlay gallery — the
// freshly populated thumbnail should jump straight into preview/editor mode
// instead of waiting for a click on the floating tile.
listen<string>("liem-thumbnail-auto-preview", (event) => {
  if (event.payload !== currentWindow.label) return;
  if (!filePath || isPreviewMode || isDismissing) return;
  void enterPreviewMode();
}).catch(console.error);

// View-only counterpart of `liem-thumbnail-auto-preview` — opens the
// thumbnail at the larger preview size but skips the editor canvas / toolbar.
// Triggered when the user double-clicks a tile in the overlay gallery.
listen<string>("liem-thumbnail-auto-view", (event) => {
  if (event.payload !== currentWindow.label) return;
  if (!filePath || isPreviewMode || isDismissing) return;
  void enterPreviewMode(true);
}).catch(console.error);

// Hover refresh: while the cursor sits on the thumbnail we refill and freeze
// the countdown; when it leaves we run the full DISMISS_MS lifetime. This is
// the only path that extends a thumbnail's life — taking a new screenshot no
// longer resets sibling thumbnails.
//
// When a new screenshot comes in, the Rust side reflows the stack and our
// window can slide under (or out from under) a stationary cursor. Windows /
// the webview then fires a *synthetic* mouseenter/mouseleave even though the
// user never moved the mouse. We suppress hover handling for a short window
// after a reflow so the timer is not paused/reset by something the user did
// not actually do.
let suppressHoverUntil = 0;
const HOVER_SUPPRESS_MS = 350;

listen("liem-thumbnail-reflow", () => {
  suppressHoverUntil = performance.now() + HOVER_SUPPRESS_MS;
}).catch(console.error);

shell.addEventListener("mouseenter", () => {
  if (performance.now() < suppressHoverUntil) return;
  if (isPreviewMode || isDismissing || isPinned || !filePath) return;
  resetAndPauseTimer(DISMISS_MS);
  void invoke("pause_thumbnail_lifetime", { label: currentWindow.label }).catch(console.error);
});

shell.addEventListener("mouseleave", () => {
  if (performance.now() < suppressHoverUntil) return;
  if (isPreviewMode || isDismissing || isPinned || !filePath) return;
  resumeTimer(DISMISS_MS);
  void invoke("restart_thumbnail_lifetime", { label: currentWindow.label }).catch(console.error);
});

window.addEventListener("keydown", (event) => {
  if (isOcrMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectAllOcrText();
    return;
  }

  if (isOcrMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
    event.preventDefault();
    void copySelectedOcrTextIfAny();
    return;
  }

  if (isPreviewMode && isEditorReady && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redoButton.click();
    else undoButton.click();
    return;
  }

  if (isPreviewMode && isEditorReady && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoButton.click();
    return;
  }

  // Ctrl+C in the editor → copy current canvas to clipboard. OCR mode has
  // its own Ctrl+C earlier in this handler, so we don't collide there.
  if (isPreviewMode && isEditorReady && !isOcrMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
    event.preventDefault();
    void copyEditorToClipboard();
    return;
  }

  if (event.key !== "Escape") return;

  event.preventDefault();
  if (isOcrMode) {
    exitOcrMode();
    flashStatus("OCR canceled");
    return;
  }
  if (isPreviewMode && isEditorReady && drawing) {
    drawing = false;
    if (mode === "crop") {
      startPoint = null;
      lastPoint = null;
      strokePoints = [];
      renderCropBox();
      return;
    }

    cropBox.style.display = "none";
    if (snapshotBeforeAction) drawSnapshot(snapshotBeforeAction);
    return;
  }
  if (isPreviewMode) {
    exitPreviewMode();
  } else {
    void hideThumbnail();
  }
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;
  if (!drawGroup.contains(target)) drawGroup.classList.remove("open");
  if (!shapeGroup.contains(target)) shapeGroup.classList.remove("open");
  if (!cropGroup.contains(target)) cropGroup.classList.remove("open");
  if (!transformGroup.contains(target)) transformGroup.classList.remove("open");
  if (!aiGroup.contains(target)) aiGroup.classList.remove("open");
  if (!saveGroup.contains(target)) saveGroup.classList.remove("open");
});

window.__LIEM_SET_THUMBNAIL = applyThumbnail;
window.__LIEM_PREPARE_THUMBNAIL = prepareThumbnailForUpdate;
window.__LIEM_REVEAL_THUMBNAIL = requestThumbnailReveal;
window.__LIEM_CONCEAL_THUMBNAIL = concealThumbnailShell;
window.__LIEM_FORCE_THUMBNAIL_MODE = forceThumbnailMode;

renderPalette();
updateCropRatioMenu();
setActiveColor(initialColorPrefs.activeColor);
setProgress(1);
loadThumbnail();
