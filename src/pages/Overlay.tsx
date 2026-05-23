import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type Mode = "select" | "crop";
interface Point { x: number; y: number }
interface Rect  { x: number; y: number; w: number; h: number }

const SHOT_SFX_OFFSET_SECONDS = 0;
const shotSfx = new Audio("/sfx/shot_sfx.mp3");
shotSfx.preload = "auto";
shotSfx.volume = 0.62;
shotSfx.load();

function playShotSfx() {
  const audio = shotSfx.cloneNode(true) as HTMLAudioElement;
  audio.volume = shotSfx.volume;
  audio.currentTime = SHOT_SFX_OFFSET_SECONDS;
  audio.play().catch(() => {});
}

function toRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function drawCanvas(canvas: HTMLCanvasElement, rect: Rect | null) {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (rect && rect.w > 2 && rect.h > 2) {
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rect.x + 0.75, rect.y + 0.75, rect.w - 1.5, rect.h - 1.5);
    const label = `${rect.w} × ${rect.h}`;
    ctx.font = "bold 11px ui-monospace, monospace";
    const tw = ctx.measureText(label).width;
    const lx = rect.x + rect.w / 2 - tw / 2;
    const ly = rect.y > 22 ? rect.y - 8 : rect.y + rect.h + 18;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(lx - 6, ly - 12, tw + 12, 18);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, lx, ly);
  }
}

const MODES = [
  { key: "1", label: "Area",       disabled: false },
  { key: "2", label: "Fullscreen", disabled: false },
  { key: "3", label: "Scroll",     disabled: true  },
] as const;

function ModeSelector({ onSelect, onClose: _onClose }: { onSelect: (key: string) => void; onClose: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.74)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-[500px] max-w-[calc(100vw-32px)] rounded-[18px] overflow-hidden"
        style={{
          background: "rgba(255,255,255,0.08)",
          border: "2px solid rgba(255,255,255,0.78)",
          boxShadow: "0 18px 48px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.32)",
          backdropFilter: "blur(24px) saturate(1.35)",
          WebkitBackdropFilter: "blur(24px) saturate(1.35)",
        }}
      >
        <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-4">
          <span className="text-white font-semibold text-sm tracking-tight drop-shadow-sm">Capture mode</span>
          <p className="text-white/80 text-xs drop-shadow-sm">Press Esc to cancel</p>
        </div>

        <div className="px-3 pb-3 grid grid-cols-3 gap-2">
          {MODES.map((m) => (
            <button
              key={m.key}
              disabled={m.disabled}
              onClick={() => !m.disabled && onSelect(m.key)}
              className={[
                "h-16 flex items-center gap-3 px-3 rounded-xl text-left transition-all border",
                m.disabled
                  ? "opacity-45 cursor-not-allowed border-white/34 bg-black/[0.10]"
                  : "cursor-pointer border-white/60 bg-black/[0.16] hover:bg-white/[0.13] hover:border-white/80 active:bg-white/[0.18]",
              ].join(" ")}
            >
              <kbd className="w-6 h-6 rounded-md bg-white/16 border border-white/22 text-white/90 text-xs font-mono flex items-center justify-center shrink-0 shadow-sm">
                {m.key}
              </kbd>
              <span className="text-white text-sm font-semibold drop-shadow-sm min-w-0 truncate">{m.label}</span>
              {m.disabled && (
                <span className="ml-auto text-[10px] text-white/65 bg-white/10 border border-white/14 px-1.5 py-0.5 rounded-full">soon</span>
              )}
            </button>
          ))}
        </div>

      </motion.div>
    </motion.div>
  );
}

export default function Overlay() {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const startPt    = useRef<Point | null>(null);
  const cursorPt   = useRef<Point>({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const rafRef     = useRef<number>(0);
  const modeRef    = useRef<Mode>("select");
  const [mode, setMode] = useState<Mode>("select");

  // Keep ref in sync so event handlers always see latest mode without re-registering
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const hideOverlayBeforeCapture = useCallback(async () => {
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.display = "none";
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }

    setMode("select");
    modeRef.current = "select";
    await invoke("hide_overlay").catch(() => {});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }, []);

  // ── close: synchronous, fire-and-forget hide via Rust ──────────────────────
  const close = useCallback(() => {
    invoke("hide_overlay").catch(() => {});
    setMode("select");
    modeRef.current = "select";
    startPt.current = null;
    isDragging.current = false;
  }, []);

  // Reset when overlay is re-shown
  useEffect(() => {
    const unlisten = listen("reset-overlay", () => {
      setMode("select");
      modeRef.current = "select";
      startPt.current = null;
      isDragging.current = false;
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Size canvas when entering crop mode
  useEffect(() => {
    if (mode !== "crop") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    drawCanvas(canvas, null);
  }, [mode]);

  const handleModeSelect = useCallback((key: string) => {
    if (key === "1") {
      setMode("crop");
      modeRef.current = "crop";
    } else if (key === "2") {
      void (async () => {
        await hideOverlayBeforeCapture();
        playShotSfx();
        await invoke("take_fullscreen");
      })().catch(console.error);
    }
    // key "3" = coming soon
  }, [hideOverlayBeforeCapture]);

  // ── Single keydown listener — registered once, uses ref for mode ───────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();              // synchronous, always works
        return;
      }
      if (modeRef.current === "select") {
        if (e.key === "1" || e.key === "2" || e.key === "3") {
          handleModeSelect(e.key);
        }
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase = fires first
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, handleModeSelect]);

  // ── Crop mouse handlers ────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "crop") return;

    const onMove = (e: MouseEvent) => {
      cursorPt.current = { x: e.clientX, y: e.clientY };
      const canvas = canvasRef.current;
      if (!canvas) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const r = isDragging.current && startPt.current
          ? toRect(startPt.current, cursorPt.current) : null;
        drawCanvas(canvas, r);
      });
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      startPt.current = { x: e.clientX, y: e.clientY };
      isDragging.current = true;
    };

    const onUp = async (e: MouseEvent) => {
      if (!isDragging.current || !startPt.current) return;

      // Capture everything synchronously first
      const start = startPt.current;
      startPt.current  = null;
      isDragging.current = false;

      const rect = toRect(start, { x: e.clientX, y: e.clientY });
      if (rect.w < 8 || rect.h < 8) {
        if (canvasRef.current) drawCanvas(canvasRef.current, null);
        return;
      }

      const dpr = window.devicePixelRatio || 1;

      // Get window position, default to 0,0 if it fails
      let ox = 0, oy = 0;
      try {
        const pos = await getCurrentWindow().outerPosition();
        ox = pos.x;
        oy = pos.y;
      } catch {}

      // Hide immediately via Rust — fire and forget
      await hideOverlayBeforeCapture();

      try {
        playShotSfx();
        await invoke("take_screenshot", {
          x:      Math.round(rect.x * dpr) + ox,
          y:      Math.round(rect.y * dpr) + oy,
          width:  Math.round(rect.w * dpr),
          height: Math.round(rect.h * dpr),
        });
      } catch (err) {
        console.error("Screenshot failed:", err);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup",   onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup",   onUp);
      cancelAnimationFrame(rafRef.current);
    };
  }, [hideOverlayBeforeCapture, mode]);

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="fixed inset-0 w-full h-full"
        style={{ cursor: "crosshair", display: mode === "crop" ? "block" : "none" }}
      />
      <AnimatePresence>
        {mode === "select" && (
          <ModeSelector onSelect={handleModeSelect} onClose={close} />
        )}
      </AnimatePresence>
    </div>
  );
}
