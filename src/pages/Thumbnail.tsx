import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DISMISS_SECONDS = 8;

interface ThumbnailData {
  path: string;
  image: string;
}

export default function Thumbnail() {
  const [imageSrc, setImageSrc] = useState("");
  const [fallbackSrc, setFallbackSrc] = useState("");
  const [filePath, setFilePath] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isHovered, setIsHovered] = useState(false);
  const [timeLeft, setTimeLeft] = useState(DISMISS_SECONDS);
  const [dragging, setDragging] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const label = getCurrentWindow().label;
    invoke<ThumbnailData>("get_thumbnail_data", { label })
      .then((data) => {
        setFilePath(data.path);
        setFallbackSrc(`data:image/png;base64,${data.image}`);
        setImageSrc(convertFileSrc(data.path));
      })
      .catch((err) => {
        console.error(err);
        setLoadError("Preview unavailable");
      });
  }, []);

  useEffect(() => {
    if (isHovered || dragging) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          getCurrentWindow().close();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isHovered, dragging]);

  const handlePointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0 || !filePath) return;
    e.preventDefault();
    setDragging(true);
    try {
      await invoke("start_drag", { path: filePath });
    } catch (err) {
      console.error("Drag failed:", err);
    }
    setDragging(false);
  };

  const progress = (timeLeft / DISMISS_SECONDS) * 100;

  return (
    <AnimatePresence>
      <motion.div
        key="thumbnail"
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="w-full h-full flex flex-col p-2 gap-1.5"
        style={{
          background: "rgba(18,18,20,0.96)",
          borderRadius: 12,
          boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
          boxSizing: "border-box",
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div
          className="relative flex-1 rounded-lg overflow-hidden group bg-zinc-900"
          style={{
            background: "#18181b",
            cursor: dragging ? "grabbing" : "grab",
          }}
          onPointerDown={handlePointerDown}
        >
          {imageSrc ? (
            <img
              src={imageSrc}
              alt="Screenshot"
              className="w-full h-full object-contain"
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                objectFit: "contain",
                background: "#18181b",
              }}
              draggable={false}
              onError={() => {
                if (fallbackSrc && imageSrc !== fallbackSrc) {
                  setImageSrc(fallbackSrc);
                } else {
                  setLoadError("Preview unavailable");
                  setImageSrc("");
                }
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <span
                className="text-white/20 text-xs"
                style={{ color: "rgba(255,255,255,0.28)", fontSize: 12 }}
              >
                {loadError}
              </span>
            </div>
          )}

          {imageSrc && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 bg-black/40 rounded-lg pointer-events-none">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12l7-7 7 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-white text-[11px] font-medium">Drag to share</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-0.5">
          <div className="flex-1 h-[3px] bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-white rounded-full"
              animate={{ scaleX: progress / 100 }}
              transition={{ duration: 0.9, ease: "linear" }}
              style={{ transformOrigin: "left" }}
            />
          </div>
          <button
            onClick={async () => {
              try {
                await invoke("copy_to_clipboard", { path: filePath });
              } catch {}
            }}
            className="text-white/30 hover:text-white/70 transition-colors text-xs"
            title="Copy"
            disabled={!filePath}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
          <button
            onClick={() => getCurrentWindow().close()}
            className="text-white/30 hover:text-white/70 transition-colors text-xs leading-none"
            title="Dismiss"
          >
            x
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
