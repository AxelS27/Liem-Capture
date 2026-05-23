import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DISMISS_MS = 16000;
const UNPIN_DISMISS_MS = 3000;

interface ThumbnailData {
  path: string;
  image: string;
}

declare global {
  interface Window {
    __LIEM_SET_THUMBNAIL?: (data: ThumbnailData) => void;
  }
}

const currentWindow = getCurrentWindow();
const preview = document.querySelector<HTMLDivElement>("#preview")!;
const shell = document.querySelector<HTMLElement>("#shell")!;
const image = document.querySelector<HTMLImageElement>("#image")!;
const statusText = document.querySelector<HTMLDivElement>("#status")!;
const progress = document.querySelector<HTMLDivElement>("#progress")!;
const pinButton = document.querySelector<HTMLButtonElement>("#pin")!;
const closeButton = document.querySelector<HTMLButtonElement>("#close")!;

let filePath = "";
let imageDataUrl = "";
let hideTimeoutId = 0;
let timerDurationMs = DISMISS_MS;
let remainingMs = DISMISS_MS;
let timerStartedAt = 0;
let timerPaused = true;
let isPinned = false;
let isDismissing = false;

function setStatus(message: string) {
  statusText.textContent = message;
  statusText.hidden = false;
}

function showImage(src: string) {
  image.src = src;
  image.hidden = false;
  statusText.hidden = true;
}

function clearHideTimeout() {
  if (hideTimeoutId) {
    window.clearTimeout(hideTimeoutId);
    hideTimeoutId = 0;
  }
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

function resumeTimer() {
  if (!timerPaused || !filePath || isPinned) return;

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

function applyThumbnail(data: ThumbnailData) {
  isDismissing = false;
  shell.classList.remove("dismissing");
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
  showImage(imageDataUrl);
  if (isPinned) {
    pauseTimer();
    void invoke("pin_thumbnail", { label: currentWindow.label }).catch((error) => {
      console.error(error);
    });
  } else {
    restartTimer();
  }
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

image.addEventListener("error", () => {
  image.hidden = true;
  setStatus("Preview unavailable");
});

preview.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !filePath) return;

  event.preventDefault();
  pauseTimer();
  preview.classList.add("dragging");
  void invoke("start_drag", { path: filePath })
    .catch((error) => {
      console.error("Drag failed:", error);
    })
    .finally(() => {
      preview.classList.remove("dragging");
      resumeTimer();
    });
});

closeButton.addEventListener("click", () => {
  void hideThumbnail();
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
    }).catch((error) => {
      console.error(error);
    });
    resumeTimer();
    return;
  }

  isPinned = true;
  shell.classList.add("pinned");
  pinButton.title = "Unpin";
  pinButton.setAttribute("aria-label", "Unpin");
  pauseTimer();
  void invoke("pin_thumbnail", { label: currentWindow.label }).catch((error) => {
    console.error(error);
  });
});

listen("liem-thumbnail-pause", () => {
  pauseTimer();
}).catch(console.error);

listen("liem-thumbnail-resume", () => {
  resumeTimer();
}).catch(console.error);

window.__LIEM_SET_THUMBNAIL = applyThumbnail;

setProgress(1);
loadThumbnail();
