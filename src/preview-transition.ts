import { listen } from "@tauri-apps/api/event";

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type TransitionPayload = {
  image: string;
  source: Rect;
  target: Rect;
  durationMs: number;
};

const ghost = document.querySelector<HTMLImageElement>("#ghost")!;

function setBaseRect(rect: Rect, radius: number) {
  ghost.style.left = `${rect.x}px`;
  ghost.style.top = `${rect.y}px`;
  ghost.style.width = `${rect.w}px`;
  ghost.style.height = `${rect.h}px`;
  ghost.style.borderRadius = `${radius}px`;
}

function animatePreviewTransition(payload: TransitionPayload) {
  const { source, target, durationMs } = payload;
  const scaleX = target.w / Math.max(source.w, 1);
  const scaleY = target.h / Math.max(source.h, 1);
  const dx = target.x - source.x;
  const dy = target.y - source.y;

  ghost.style.transition = "none";
  ghost.style.opacity = "1";
  ghost.style.transform = "translate3d(0, 0, 0) scale(1, 1)";
  setBaseRect(source, 8);
  ghost.src = payload.image;
  ghost.style.display = "block";

  ghost.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    ghost.style.transition = [
      `transform ${durationMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
      `border-radius ${durationMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
      "opacity 120ms ease",
    ].join(", ");
    ghost.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scaleX}, ${scaleY})`;
    ghost.style.borderRadius = "18px";
  });
}

listen<TransitionPayload>("liem-preview-transition", (event) => {
  animatePreviewTransition(event.payload);
}).catch(console.error);

listen("liem-preview-transition-hide", () => {
  ghost.style.opacity = "0";
  window.setTimeout(() => {
    ghost.style.display = "none";
    ghost.removeAttribute("src");
  }, 140);
}).catch(console.error);
