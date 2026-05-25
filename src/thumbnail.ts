import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DISMISS_MS = 8000;
const UNPIN_DISMISS_MS = 3000;
const PREVIEW_TOOLS_DELAY_MS = 70;
const COLOR_PREFS_KEY = "liem-shot-thumbnail-colors";
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
const drawGroup = document.querySelector<HTMLDivElement>("#draw-group")!;
const shapeGroup = document.querySelector<HTMLDivElement>("#shape-group")!;
const cropGroup = document.querySelector<HTMLDivElement>("#crop-group")!;
const transformGroup = document.querySelector<HTMLDivElement>("#transform-group")!;
const drawButton = document.querySelector<HTMLButtonElement>("#tool-draw")!;
const cropButton = document.querySelector<HTMLButtonElement>("#tool-crop")!;
const shapeButton = document.querySelector<HTMLButtonElement>("#tool-shape")!;
const transformButton = document.querySelector<HTMLButtonElement>("#tool-transform")!;
const sizeInput = document.querySelector<HTMLInputElement>("#tool-size")!;
const colorInput = document.querySelector<HTMLInputElement>("#tool-color")!;
const palette = document.querySelector<HTMLDivElement>("#palette")!;
const undoButton = document.querySelector<HTMLButtonElement>("#tool-undo")!;
const redoButton = document.querySelector<HTMLButtonElement>("#tool-redo")!;
const clearButton = document.querySelector<HTMLButtonElement>("#tool-clear")!;
const saveButton = document.querySelector<HTMLButtonElement>("#tool-save")!;

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
let snapshotBeforeAction = "";
let baseCanvas = document.createElement("canvas");
let editLayer = document.createElement("canvas");
let shapeObjects: ShapeObject[] = [];
let previewShape: ShapeObject | null = null;
let layerBeforeAction: ImageData | null = null;
let cropRect: CropRect | null = null;
let cropInteraction: {
  id: number;
  handle: CropHandle;
  startPoint: Point;
  startRect: CropRect;
} | null = null;
let undoStack: string[] = [];
let redoStack: string[] = [];
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

function captureSnapshot() {
  return editCanvas.toDataURL("image/png");
}

function drawSnapshot(dataUrl: string) {
  const img = new Image();
  img.onload = () => {
    baseCanvas.width = img.naturalWidth || img.width;
    baseCanvas.height = img.naturalHeight || img.height;
    editLayer.width = baseCanvas.width;
    editLayer.height = baseCanvas.height;
    editCanvas.width = baseCanvas.width;
    editCanvas.height = baseCanvas.height;
    baseCanvas.getContext("2d")?.drawImage(img, 0, 0);
    editLayer.getContext("2d")?.clearRect(0, 0, editLayer.width, editLayer.height);
    shapeObjects = [];
    previewShape = null;
    cropInteraction = null;
    setCropRect(null);
    resetCameraView();
    renderComposite();
  };
  img.src = dataUrl;
}

function layerContext() {
  const ctx = editLayer.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Edit layer unavailable");
  return ctx;
}

function renderComposite() {
  const ctx = canvasContext();
  ctx.clearRect(0, 0, editCanvas.width, editCanvas.height);
  ctx.drawImage(baseCanvas, 0, 0);
  ctx.drawImage(editLayer, 0, 0);
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

function captureLayer() {
  return layerContext().getImageData(0, 0, editLayer.width, editLayer.height);
}

function restoreLayer() {
  if (!layerBeforeAction) return;
  layerContext().putImageData(layerBeforeAction, 0, 0);
  renderComposite();
}

function commitSnapshot(before: string) {
  const after = captureSnapshot();
  if (after === before) return;

  undoStack.push(after);
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

async function loadEditorCanvas() {
  const fullImage = await invoke<string>("get_image_data", { path: filePath });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Edit preview unavailable"));
    img.src = `data:image/png;base64,${fullImage}`;
  });

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

async function hideThumbnail() {
  if (isDismissing) return;

  setNativePreviewMode(false);
  isDismissing = true;
  clearHideTimeout();
  shell.classList.add("dismissing");
  await new Promise((resolve) => window.setTimeout(resolve, 360));

  try {
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
  setNativePreviewMode(false);
  isDismissing = false;
  isPreviewMode = false;
  isEditorReady = false;
  thumbnailImageReady = false;
  drawing = false;
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

function drawStroke(points: Point[]) {
  if (points.length < 2) return;

  const ctx = layerContext();
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = visualSizeToCanvasSize(drawTool === "eraser" ? eraserSize() : currentSize());

  if (drawTool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = colorInput.value;
    ctx.globalAlpha = drawTool === "highlighter" ? 0.34 : 1;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();
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

function replaceCanvasWith(next: HTMLCanvasElement, before: string, keepCropMode = false) {
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

editCanvas.addEventListener("auxclick", (event) => {
  if (event.button === 1) {
    event.preventDefault();
  }
});

editCanvas.addEventListener("pointerdown", (event) => {
  if (!isPreviewMode || !isEditorReady) return;

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
  }
  layerBeforeAction = captureLayer();
  editCanvas.setPointerCapture(event.pointerId);
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
    restoreLayer();
    drawStroke(strokePoints);
    renderComposite();
    lastPoint = point;
  } else if (mode === "shape") {
    drawShapePreview(startPoint, point);
  } else if (mode === "crop") {
    renderCropBox();
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

  if (mode === "draw") {
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
  layerBeforeAction = null;
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
  updateEraserCursor();
  if (editCanvas.hasPointerCapture(event.pointerId)) {
    editCanvas.releasePointerCapture(event.pointerId);
  }
  if (wasCropMode) {
    renderCropBox();
  } else {
    cropBox.style.display = "none";
    restoreLayer();
  }
  layerBeforeAction = null;
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

minimizeButton.addEventListener("click", () => {
  if (!isPreviewMode) return;

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
  setMode("draw");
});

drawButton.addEventListener("dblclick", () => {
  drawGroup.classList.toggle("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  setMode("draw");
});

shapeButton.addEventListener("click", () => {
  shapeGroup.classList.remove("open");
  drawGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  setMode("shape");
});

shapeButton.addEventListener("dblclick", () => {
  shapeGroup.classList.toggle("open");
  drawGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  setMode("shape");
});

cropButton.addEventListener("click", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  setMode("crop");
});

cropButton.addEventListener("dblclick", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  transformGroup.classList.remove("open");
  cropGroup.classList.add("open");
  setMode("crop");
});

transformButton.addEventListener("click", () => {
  drawGroup.classList.remove("open");
  shapeGroup.classList.remove("open");
  cropGroup.classList.remove("open");
  transformGroup.classList.toggle("open");
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
  if (undoStack.length <= 1) return;
  const before = captureSnapshot();
  drawSnapshot(undoStack[0]);
  window.setTimeout(() => commitSnapshot(before), 0);
});

saveButton.addEventListener("click", async () => {
  if (!filePath || !isPreviewMode || !isEditorReady) return;

  saveButton.disabled = true;
  saveButton.classList.add("active");
  try {
    const dataUrl = editCanvas.toDataURL("image/png");
    const data = await invoke<ThumbnailData>("save_edited_thumbnail", {
      label: currentWindow.label,
      path: filePath,
      dataUrl,
    });
    imageDataUrl = `data:image/png;base64,${data.image}`;
    image.src = imageDataUrl;
    undoStack = [dataUrl];
    redoStack = [];
    updateHistoryButtons();
    flashStatus("Saved");
  } catch (error) {
    console.error(error);
    flashStatus("Save failed");
  } finally {
    saveButton.disabled = false;
    saveButton.classList.remove("active");
  }
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

// Hover refresh: while the cursor sits on the thumbnail we freeze the
// countdown; when it leaves we restart the full DISMISS_MS lifetime. This is
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
  pauseTimer();
  void invoke("pause_thumbnail_lifetime", { label: currentWindow.label }).catch(console.error);
});

shell.addEventListener("mouseleave", () => {
  if (performance.now() < suppressHoverUntil) return;
  if (isPreviewMode || isDismissing || isPinned || !filePath) return;
  resetTimer(DISMISS_MS);
  void invoke("restart_thumbnail_lifetime", { label: currentWindow.label }).catch(console.error);
});

window.addEventListener("keydown", (event) => {
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

  if (event.key !== "Escape") return;

  event.preventDefault();
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
