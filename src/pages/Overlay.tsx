import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useContext,
  createContext,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

type Mode = "select" | "crop";
interface Point { x: number; y: number }
interface Rect  { x: number; y: number; w: number; h: number }

const OVERLAY_CLOSE_MS = 130;

// Shot sfx via Web Audio API. Using <audio> elements with cloneNode was
// unreliable: clones sometimes played silent, and WebView2 throttles audio
// in hidden windows — which we are, by the time the capture invokes start.
// AudioContext writes straight to the OS mixer and keeps playing once a
// BufferSource is started, regardless of whether our webview is visible.
const SHOT_SFX_VOLUME = 0.95;
let shotSfxCtx: AudioContext | null = null;
let shotSfxBuffer: AudioBuffer | null = null;
let shotSfxLoadPromise: Promise<void> | null = null;

function ensureShotSfxLoaded(): Promise<void> {
  if (shotSfxLoadPromise) return shotSfxLoadPromise;
  shotSfxLoadPromise = (async () => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      shotSfxCtx = new AC();
      const res = await fetch("/sfx/shot_sfx.mp3");
      const bytes = await res.arrayBuffer();
      shotSfxBuffer = await shotSfxCtx.decodeAudioData(bytes);
    } catch (err) {
      console.error("[sfx] preload failed", err);
    }
  })();
  return shotSfxLoadPromise;
}

void ensureShotSfxLoaded();

function playShotSfx() {
  // If a user-gesture autoplay policy left the context "suspended", resuming
  // here is free since we're inside an actual user interaction handler.
  const ctx = shotSfxCtx;
  const buf = shotSfxBuffer;
  if (!ctx || !buf) {
    // Buffer not ready yet — fall back to a fresh <audio> so the first
    // capture after launch still beeps. Subsequent calls will hit the
    // Web Audio fast path.
    const audio = new Audio("/sfx/shot_sfx.mp3");
    audio.volume = SHOT_SFX_VOLUME;
    audio.play().catch(() => {});
    return;
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = SHOT_SFX_VOLUME;
  src.connect(gain).connect(ctx.destination);
  src.start(0);
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
  }
}

type OverlayAction = "area" | "fullscreen" | "gallery" | "settings";

type OverlayShortcuts = Record<OverlayAction, string>;

const OVERLAY_SHORTCUTS_KEY = "liem-capture:overlay-shortcuts";

const DEFAULT_OVERLAY_SHORTCUTS: OverlayShortcuts = {
  area: "1",
  fullscreen: "2",
  gallery: "g",
  settings: "s",
};

// Single character a-z or 0-9. Modifiers (Ctrl/Shift/Alt) are not allowed —
// these shortcuts only fire while the overlay is already foreground, so we
// keep them simple and conflict-free with the global capture hotkey.
function isValidOverlayKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]$/i.test(value);
}

function loadOverlayShortcuts(): OverlayShortcuts {
  try {
    const raw = window.localStorage.getItem(OVERLAY_SHORTCUTS_KEY);
    if (!raw) return { ...DEFAULT_OVERLAY_SHORTCUTS };
    const parsed = JSON.parse(raw) as Partial<Record<OverlayAction, unknown>>;
    const result = { ...DEFAULT_OVERLAY_SHORTCUTS };
    for (const action of ["area", "fullscreen", "gallery", "settings"] as const) {
      const v = parsed[action];
      if (isValidOverlayKey(v)) result[action] = v.toLowerCase();
    }
    // De-duplicate: if two actions collide (corrupted storage), fall back
    // to defaults so the user isn't stuck with broken shortcuts.
    const seen = new Set<string>();
    for (const action of ["area", "fullscreen", "gallery", "settings"] as const) {
      if (seen.has(result[action])) return { ...DEFAULT_OVERLAY_SHORTCUTS };
      seen.add(result[action]);
    }
    return result;
  } catch {
    return { ...DEFAULT_OVERLAY_SHORTCUTS };
  }
}

function saveOverlayShortcuts(value: OverlayShortcuts) {
  try {
    window.localStorage.setItem(OVERLAY_SHORTCUTS_KEY, JSON.stringify(value));
  } catch {
    // Non-fatal; user just won't have persistence.
  }
}

const OVERLAY_ACTION_LABELS: Record<OverlayAction, string> = {
  area: "Area capture",
  fullscreen: "Fullscreen capture",
  gallery: "Open gallery",
  settings: "Open settings",
};

const BASE_MODES = [
  { id: "area" as const,       label: "Area",       disabled: false },
  { id: "fullscreen" as const, label: "Fullscreen", disabled: false },
  { id: "scroll" as const,     label: "Scroll",     disabled: true  },
] as const;

const DEFAULT_HOTKEY = "Ctrl+Shift+2";

function keyFromKeyboardEvent(event: KeyboardEvent) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^Numpad[0-9]$/.test(event.code)) return `Numpad${event.code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key.toUpperCase();
  const named: Record<string, string> = {
    Escape: "Escape",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
  };
  return named[event.key] ?? null;
}

function modifierFromKeyboardCode(code: string) {
  if (code.startsWith("Control")) return "Ctrl";
  if (code.startsWith("Shift")) return "Shift";
  if (code.startsWith("Alt")) return "Alt";
  if (code.startsWith("Meta") || code === "OSLeft" || code === "OSRight") return "Super";
  return null;
}

interface GalleryItem {
  path: string;
  name: string;
  modifiedMs: number;
}

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

interface GalleryMetadata {
  name: string;
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  modifiedMs: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return new Date(ms).toString();
  }
}

const ROOT_LABEL = "Liem Capture";
const DRAG_THRESHOLD_PX = 5;
const ESC_BACK_COOLDOWN_MS = 140;

// Shared between the inline ImageViewer and the Overlay's global keydown
// handler. While the viewer is open we want Esc to dismiss only the viewer
// (back to selector + gallery), not the whole Ctrl+Shift+2 modal. Lifting
// React state would mean threading setViewingItem through three components;
// a module-level flag plus a check in the Overlay handler is simpler and
// keeps the components decoupled.
const viewerOpenRef = { current: false };
// Same trick for the prompt/confirm/alert dialog — when one is showing,
// Esc / Enter belong to it, not to the overlay's mode-cancel hotkey.
const dialogOpenRef = { current: false };
const selectorBackRef: { current: null | (() => boolean) } = { current: null };

// ─── Themed prompt / confirm / alert ─────────────────────────────────────
// We replace the native browser dialogs (which can't be styled, blur the
// app, and don't match the glass aesthetic) with a centered modal rendered
// inside the overlay. Consumers call dialog.prompt({...}) / .confirm /
// .alert and get a Promise — same ergonomics as window.prompt without the
// ugly Chrome chrome.

interface DialogOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type ActiveDialog =
  | { kind: "prompt"; opts: DialogOptions; resolve: (val: string | null) => void }
  | { kind: "confirm"; opts: DialogOptions; resolve: (val: boolean) => void }
  | { kind: "alert"; opts: DialogOptions; resolve: () => void };

interface DialogApi {
  prompt: (opts: DialogOptions) => Promise<string | null>;
  confirm: (opts: DialogOptions) => Promise<boolean>;
  alert: (opts: DialogOptions) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog called outside DialogProvider");
  return ctx;
}

function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveDialog | null>(null);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<ActiveDialog | null>(null);
  const inputValueRef = useRef("");

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { inputValueRef.current = inputValue; }, [inputValue]);
  useEffect(() => { dialogOpenRef.current = active !== null; }, [active]);

  // Autofocus + select the input when a prompt opens so the user can just
  // start typing (or hit Enter to accept the prefilled value).
  useEffect(() => {
    if (active?.kind === "prompt") {
      const id = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 40);
      return () => window.clearTimeout(id);
    }
  }, [active]);

  const cancel = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    if (a.kind === "prompt") a.resolve(null);
    else if (a.kind === "confirm") a.resolve(false);
    else a.resolve();
    setActive(null);
  }, []);

  const submit = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    if (a.kind === "prompt") {
      const value = inputValueRef.current.trim();
      if (value === "") return; // require non-empty input
      a.resolve(value);
    } else if (a.kind === "confirm") {
      a.resolve(true);
    } else {
      a.resolve();
    }
    setActive(null);
  }, []);

  // Esc cancels, Enter confirms. stopImmediatePropagation prevents the
  // Overlay's window-level keydown handler from also acting on these.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel, submit]);

  const api = useMemo<DialogApi>(() => ({
    prompt: (opts) => new Promise<string | null>((resolve) => {
      setInputValue(opts.defaultValue ?? "");
      setActive({ kind: "prompt", opts, resolve });
    }),
    confirm: (opts) => new Promise<boolean>((resolve) => {
      setActive({ kind: "confirm", opts, resolve });
    }),
    alert: (opts) => new Promise<void>((resolve) => {
      setActive({ kind: "alert", opts, resolve });
    }),
  }), []);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.55)" }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="w-[400px] max-w-[calc(100vw-32px)] rounded-[14px] overflow-hidden"
            style={{
              background: "rgba(22,22,26,0.92)",
              border: "1.5px solid rgba(255,255,255,0.22)",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.15)",
              backdropFilter: "blur(20px) saturate(1.3)",
              WebkitBackdropFilter: "blur(20px) saturate(1.3)",
            }}
          >
            <div className="px-5 pt-4 pb-3">
              <h3 className="text-white text-sm font-semibold tracking-tight">{active.opts.title}</h3>
              {active.opts.message && (
                <p className="mt-1.5 text-white/70 text-[12px] leading-relaxed">{active.opts.message}</p>
              )}
              {active.kind === "prompt" && (
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={active.opts.placeholder}
                  className="mt-3 w-full px-3 py-2 rounded-md text-white text-[13px] outline-none border focus:border-white/55"
                  style={{
                    background: "rgba(0,0,0,0.35)",
                    borderColor: "rgba(255,255,255,0.18)",
                  }}
                />
              )}
            </div>
            <div className="px-4 pb-4 pt-1 flex items-center justify-end gap-2">
              <button
                onClick={cancel}
                className="px-3 py-1.5 rounded-md text-[12px] font-medium text-white/85 hover:bg-white/12 border border-white/15"
              >
                {active.opts.cancelLabel ?? "Cancel"}
              </button>
              <button
                onClick={submit}
                className={[
                  "px-3 py-1.5 rounded-md text-[12px] font-semibold border",
                  active.opts.destructive
                    ? "bg-red-500/85 hover:bg-red-500 text-white border-red-300/50"
                    : "bg-white/20 hover:bg-white/30 text-white border-white/30",
                ].join(" ")}
              >
                {active.opts.confirmLabel ?? (active.kind === "alert" ? "OK" : active.kind === "confirm" ? "Confirm" : "OK")}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

// Walk the folder tree breadth-first/recursively and return the FolderNode
// whose absolute path matches. Returns the root if `targetPath` is null.
function findFolder(node: FolderNode | null, targetPath: string | null): FolderNode | null {
  if (!node) return null;
  if (targetPath === null) return node;
  if (node.path === targetPath) return node;
  for (const child of node.children) {
    const hit = findFolder(child, targetPath);
    if (hit) return hit;
  }
  return null;
}

function FolderTreeNode({
  node,
  depth,
  currentPath,
  onSelect,
  onRename,
  onDelete,
  onCreateChild,
  dropTargetPath,
  isRoot,
  expanded,
  onToggleExpand,
}: {
  node: FolderNode;
  depth: number;
  currentPath: string | null;
  onSelect: (path: string | null) => void;
  onRename: (node: FolderNode) => void;
  onDelete: (node: FolderNode) => void;
  onCreateChild: (parent: FolderNode, isRoot: boolean) => void;
  dropTargetPath: string | null;
  isRoot: boolean;
  expanded: Set<string>;
  onToggleExpand: (path: string) => void;
}) {
  const isSelected = isRoot ? currentPath === null : currentPath === node.path;
  const isDropTarget = dropTargetPath === (isRoot ? "" : node.path);
  const hasChildren = node.children.length > 0;
  // Root uses a sentinel key in the expanded set so it can be collapsed
  // independently of any sub-folder. openSavePicker / GallerySection
  // seeds it on first mount so the default is expanded.
  const ROOT_KEY = "__root__";
  const isExpanded = isRoot ? expanded.has(ROOT_KEY) : expanded.has(node.path);

  return (
    <>
      <div
        data-folder-path={isRoot ? "" : node.path}
        onClick={() => onSelect(isRoot ? null : node.path)}
        className={[
          "group relative flex items-center gap-1 px-1.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors",
          isSelected
            ? "bg-white/18 text-white"
            : "text-white/75 hover:bg-white/8 hover:text-white",
          isDropTarget ? "ring-2 ring-emerald-400/80 bg-emerald-500/15" : "",
        ].join(" ")}
        style={{ paddingLeft: 6 + depth * 12 }}
        title={node.path}
      >
        {hasChildren ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleExpand(isRoot ? ROOT_KEY : node.path); }}
            className="w-6 h-6 flex items-center justify-center shrink-0 rounded hover:bg-white/18 text-white/80 hover:text-white"
            title={isExpanded ? "Collapse" : "Expand"}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              style={{
                transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
              }}
            >
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          // Keep the same indent slot so folder icons stay aligned whether or
          // not the node has children.
          <span className="w-6 h-6 shrink-0" aria-hidden="true" />
        )}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
          <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
        <span className="truncate flex-1">{node.name || ROOT_LABEL}</span>
        <span className="hidden group-hover:flex items-center gap-1">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCreateChild(node, isRoot); }}
            className="w-7 h-7 rounded-md hover:bg-white/18 flex items-center justify-center text-white/85 hover:text-white"
            title={`New folder inside ${node.name || ROOT_LABEL}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M12 11v6M9 14h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          {!isRoot && (
            <>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onRename(node); }}
                className="w-7 h-7 rounded-md hover:bg-white/18 flex items-center justify-center text-white/85 hover:text-white"
                title="Rename"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 00-3-3L5.2 16 4 20z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onDelete(node); }}
                className="w-7 h-7 rounded-md hover:bg-red-500/45 flex items-center justify-center text-white/85 hover:text-white"
                title="Delete folder"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 7h14M10 11v6M14 11v6M8 7l.7 12h6.6L16 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </>
          )}
        </span>
      </div>
      {isExpanded && node.children.map((child) => (
        <FolderTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          currentPath={currentPath}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onCreateChild={onCreateChild}
          dropTargetPath={dropTargetPath}
          isRoot={false}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
        />
      ))}
    </>
  );
}

function GalleryTile({
  item,
  previewB64,
  selected,
  onPointerDown,
  onCopy,
  onDelete,
}: {
  item: GalleryItem;
  previewB64?: string;
  selected: boolean;
  onPointerDown: (item: GalleryItem, e: ReactPointerEvent) => void;
  onCopy: (item: GalleryItem, e: ReactMouseEvent) => void;
  onDelete: (item: GalleryItem, e: ReactMouseEvent) => void;
}) {
  return (
    <button
      onPointerDown={(e) => onPointerDown(item, e)}
      className={[
        "group relative aspect-[3/2] overflow-hidden rounded-lg border bg-black/30 transition-all",
        selected
          ? "border-white/85 ring-2 ring-white/40"
          : "border-white/15 hover:border-white/50",
      ].join(" ")}
      title={item.name}
      data-gallery-path={item.path}
    >
      {previewB64 ? (
        <img
          src={`data:image/png;base64,${previewB64}`}
          alt={item.name}
          draggable={false}
          className="w-full h-full object-cover pointer-events-none"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[10px] text-white/40">…</div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 px-1.5 py-1 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
        <span
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => onCopy(item, e)}
          className="w-6 h-6 rounded-md bg-white/15 hover:bg-white/30 border border-white/25 flex items-center justify-center cursor-pointer"
          title="Copy to clipboard"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="8" y="3" width="13" height="13" rx="2" stroke="white" strokeWidth="1.7" />
            <path d="M16 21H5a2 2 0 01-2-2V8" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </span>
        <span
          onPointerDown={(e) => { e.stopPropagation(); }}
          onClick={(e) => onDelete(item, e)}
          className="w-6 h-6 rounded-md bg-red-500/30 hover:bg-red-500/55 border border-red-300/40 flex items-center justify-center cursor-pointer"
          title="Delete"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 7h14" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M10 11v6M14 11v6" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M8 7l.7 12h6.6L16 7M10 7l.7-2h2.6L14 7" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </button>
  );
}

function GallerySection({
  onClose,
  onExternalDragComplete,
  onViewItem,
}: {
  onClose: () => void;
  onExternalDragComplete: () => void;
  onViewItem: (item: GalleryItem) => void;
}) {
  const dialog = useDialog();
  const [tree, setTree] = useState<FolderNode | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null); // null = root
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [draggingItem, setDraggingItem] = useState<GalleryItem | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [metadataCache, setMetadataCache] = useState<Record<string, GalleryMetadata>>({});
  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  const previewRequests = useRef<Set<string>>(new Set());
  const previewsRef = useRef<Record<string, string>>({});
  const hasItemsRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  const toggleExpand = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const refreshTree = useCallback(() => {
    invoke<FolderNode>("list_gallery_tree").then(setTree).catch(console.error);
  }, []);

  // Default the root node to expanded on first mount so the user sees
  // the gallery contents without having to click. After this we leave
  // the set alone — whatever the user collapses stays collapsed.
  const rootSeededRef = useRef(false);
  useEffect(() => {
    if (rootSeededRef.current) return;
    rootSeededRef.current = true;
    setExpandedFolders((prev) => {
      if (prev.has("__root__")) return prev;
      const next = new Set(prev);
      next.add("__root__");
      return next;
    });
  }, []);

  const refreshItems = useCallback((folder: string | null) => {
    invoke<GalleryItem[]>("list_gallery_items", { folder: folder ?? null })
      .then((data) => {
        setItems(data);
        hasItemsRef.current = data.length > 0;
        setInitialLoading(false);
      })
      .catch((err) => { console.error(err); setInitialLoading(false); });
  }, []);

  // Initial + reset-overlay refresh.
  useEffect(() => { refreshTree(); refreshItems(currentPath); }, [refreshTree, refreshItems, currentPath]);
  useEffect(() => {
    const unlisten = listen("reset-overlay", () => { refreshTree(); refreshItems(currentPath); });
    return () => { void unlisten.then((fn) => fn()); };
  }, [refreshTree, refreshItems, currentPath]);

  const requestPreview = useCallback((path: string) => {
    if (previewsRef.current[path] || previewRequests.current.has(path)) return;
    previewRequests.current.add(path);
    invoke<string>("get_gallery_preview", { path })
      .then((b64) => {
        setPreviews((prev) => ({ ...prev, [path]: b64 }));
      })
      .catch((error) => {
        previewRequests.current.delete(path);
        console.error(error);
      });
  }, []);

  const loadPreview = useCallback(async (path: string) => {
    if (previewsRef.current[path] || previewRequests.current.has(path)) return;
    previewRequests.current.add(path);
    try {
      const b64 = await invoke<string>("get_gallery_preview", { path });
      setPreviews((prev) => ({ ...prev, [path]: b64 }));
    } catch (error) {
      previewRequests.current.delete(path);
      console.error(error);
    }
  }, []);

  const requestMetadata = useCallback((path: string) => {
    if (metadataCache[path]) return;
    invoke<GalleryMetadata>("get_gallery_metadata", { path })
      .then((meta) => setMetadataCache((prev) => ({ ...prev, [path]: meta })))
      .catch(console.error);
  }, [metadataCache]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (const item of items) {
        if (cancelled) return;
        await loadPreview(item.path);
        await new Promise((resolve) => window.setTimeout(resolve, 35));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [items, loadPreview]);

  const openInEditor = useCallback((item: GalleryItem) => {
    void invoke("open_gallery_item", { path: item.path }).catch(console.error);
    onClose();
  }, [onClose]);

  const handleRenameItem = useCallback(async (item: GalleryItem) => {
    // Pre-fill the prompt with the name minus its extension so the user
    // doesn't accidentally retype/clobber it. Rust keeps the original
    // extension regardless.
    const dot = item.name.lastIndexOf(".");
    const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
    const next = await dialog.prompt({
      title: "Rename screenshot",
      defaultValue: stem,
      placeholder: "New name",
      confirmLabel: "Rename",
    });
    if (!next || next === stem) return;
    try {
      const newPath = await invoke<string>("rename_gallery_item", { path: item.path, newName: next });
      // Swap the preview cache entry over and re-anchor the current
      // selection to the new path.
      setPreviews((prev) => {
        const cached = prev[item.path];
        const { [item.path]: _, ...rest } = prev;
        return cached ? { ...rest, [newPath]: cached } : rest;
      });
      setMetadataCache((prev) => {
        const { [item.path]: _, ...rest } = prev;
        return rest;
      });
      setSelectedPath(newPath);
      refreshItems(currentPath);
    } catch (err) {
      void dialog.alert({ title: "Could not rename", message: String(err) });
    }
  }, [currentPath, dialog, refreshItems]);

  // View-mode handler hoisted to the parent so the inline viewer can live
  // INSIDE the Ctrl+Shift+2 modal instead of spawning a thumbnail window.
  const viewImage = onViewItem;

  const handleCopy = useCallback((item: GalleryItem, e: ReactMouseEvent) => {
    e.stopPropagation();
    void invoke("copy_to_clipboard", { path: item.path }).catch(console.error);
  }, []);

  const handleDeleteItem = useCallback((item: GalleryItem, e: ReactMouseEvent) => {
    e.stopPropagation();
    void invoke("delete_gallery_item", { path: item.path })
      .then(() => setItems((prev) => prev.filter((i) => i.path !== item.path)))
      .catch(console.error);
  }, []);

  const handleCreateChildFolder = useCallback(async (parent: FolderNode, isRoot: boolean) => {
    const name = await dialog.prompt({
      title: "New folder",
      message: `Inside "${parent.name || ROOT_LABEL}"`,
      placeholder: "Folder name",
      confirmLabel: "Create",
    });
    if (!name) return;
    const parentPath = isRoot ? null : parent.path;
    try {
      await invoke<string>("create_gallery_folder", { parent: parentPath, name });
      refreshTree();
      // Auto-expand the parent so the user can see the new folder appear.
      if (!isRoot) {
        setExpandedFolders((prev) => new Set(prev).add(parent.path));
      }
    } catch (err) {
      void dialog.alert({ title: "Could not create folder", message: String(err) });
    }
  }, [dialog, refreshTree]);

  const handleRenameFolder = useCallback(async (node: FolderNode) => {
    const next = await dialog.prompt({
      title: "Rename folder",
      defaultValue: node.name,
      placeholder: "New name",
      confirmLabel: "Rename",
    });
    if (!next || next === node.name) return;
    try {
      const newPath = await invoke<string>("rename_gallery_folder", { path: node.path, newName: next });
      if (currentPath === node.path) setCurrentPath(newPath);
      refreshTree();
    } catch (err) {
      void dialog.alert({ title: "Could not rename", message: String(err) });
    }
  }, [currentPath, dialog, refreshTree]);

  const handleDeleteFolder = useCallback(async (node: FolderNode) => {
    const confirmed = await dialog.confirm({
      title: "Delete folder?",
      message: `"${node.name}" and everything inside will be deleted. This cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await invoke("delete_gallery_folder", { path: node.path });
      if (currentPath === node.path) setCurrentPath(null);
      refreshTree();
      refreshItems(currentPath === node.path ? null : currentPath);
    } catch (err) {
      void dialog.alert({ title: "Could not delete", message: String(err) });
    }
  }, [currentPath, dialog, refreshTree, refreshItems]);

  // Drag flow — distinguishes internal (drop on folder = move) from external
  // (drop outside gallery = native OS drag). `pointerdown` arms a candidate;
  // we wait for movement before deciding what kind of drag this is.
  const dragStateRef = useRef<{
    item: GalleryItem;
    startX: number;
    startY: number;
    externalLaunched: boolean;
    armed: boolean;
  } | null>(null);

  const cleanupDrag = useCallback(() => {
    dragStateRef.current = null;
    setDraggingItem(null);
    setDropTargetPath(null);
  }, []);

  const launchExternalDrag = useCallback(async (item: GalleryItem) => {
    await invoke("hide_overlay_for_capture").catch(() => {});
    await invoke("show_drag_cancel_target").catch(() => {});
    try {
      await invoke<boolean>("start_drag", { path: item.path });
    } catch (err) { console.error(err); }
    await invoke("hide_drag_cancel_target").catch(() => {});
    await invoke("show_overlay_again").catch(() => {});
    onExternalDragComplete();
  }, [onExternalDragComplete]);

  const handleTilePointerDown = useCallback((item: GalleryItem, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStateRef.current = {
      item,
      startX: e.clientX,
      startY: e.clientY,
      externalLaunched: false,
      armed: false,
    };
  }, []);

  // Global listeners while a drag candidate is alive. We attach once and let
  // the state machine in dragStateRef decide what to do.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || state.externalLaunched) return;

      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (!state.armed && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      state.armed = true;
      setDraggingItem(state.item);

      const rect = containerRef.current?.getBoundingClientRect();
      const outside = !rect ||
        e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top || e.clientY > rect.bottom;

      if (outside) {
        state.externalLaunched = true;
        const item = state.item;
        cleanupDrag();
        void launchExternalDrag(item);
        return;
      }

      // Internal drag — figure out which folder tile (if any) is under the
      // cursor and highlight it as a drop target.
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const folderEl = el?.closest<HTMLElement>("[data-folder-path]");
      setDropTargetPath(folderEl ? folderEl.getAttribute("data-folder-path") : null);
    };

    const onUp = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      if (state.externalLaunched) { cleanupDrag(); return; }

      if (!state.armed) {
        // No drag → treat as a click.
        //  • Single click: select the tile and show its info panel.
        //  • Double click (≤350ms on the same tile): open the editor.
        const item = state.item;
        cleanupDrag();
        const now = performance.now();
        const last = lastClickRef.current;
        const isDouble =
          last !== null && last.path === item.path && now - last.time <= 350;
        if (isDouble) {
          lastClickRef.current = null;
          viewImage(item);
        } else {
          lastClickRef.current = { path: item.path, time: now };
          setSelectedPath(item.path);
          requestMetadata(item.path);
        }
        return;
      }

      // Released inside the gallery — if it's on a folder tile, move there.
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const folderEl = el?.closest<HTMLElement>("[data-folder-path]");
      const targetPath = folderEl?.getAttribute("data-folder-path");
      const item = state.item;
      cleanupDrag();

      if (typeof targetPath === "string") {
        invoke<string>("move_gallery_item", {
          path: item.path,
          destFolder: targetPath === "" ? null : targetPath,
        })
          .then(() => {
            // Drop the preview cache entry for the old path; the moved file
            // gets a fresh entry under its new path on next preview request.
            setPreviews((prev) => {
              const { [item.path]: _, ...rest } = prev;
              return rest;
            });
            refreshItems(currentPath);
            refreshTree();
          })
          .catch((err) => { void dialog.alert({ title: "Move failed", message: String(err) }); });
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [cleanupDrag, currentPath, launchExternalDrag, refreshItems, refreshTree, requestMetadata, viewImage]);

  const moveGallerySelection = useCallback((delta: number) => {
    if (items.length === 0) return;
    const currentIndex = selectedPath
      ? items.findIndex((item) => item.path === selectedPath)
      : -1;
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = Math.max(0, Math.min(items.length - 1, baseIndex + delta));
    const next = items[nextIndex];
    if (!next) return;
    setSelectedPath(next.path);
    requestPreview(next.path);
    requestMetadata(next.path);
  }, [items, requestMetadata, requestPreview, selectedPath]);

  // Keyboard shortcuts and navigation. Arrow keys move the selected tile
  // in the 3-column grid, Enter opens it, F2 renames, Delete removes it.
  // selected screenshot if any; otherwise falls back to the currently
  // browsed folder (so users can rename / delete the folder they're in
  // without having to right-click in the tree). Suppressed while a
  // dialog or viewer is open and while an input has focus, so typing
  // "delete" inside a text box doesn't nuke a file.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewerOpenRef.current || dialogOpenRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const isArrow = e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown";
      if (!isArrow && e.key !== "Enter" && e.key !== "F2" && e.key !== "Delete") return;

      e.preventDefault();
      e.stopPropagation();

      if (isArrow) {
        const delta =
          e.key === "ArrowLeft" ? -1 :
          e.key === "ArrowRight" ? 1 :
          e.key === "ArrowUp" ? -3 :
          3;
        moveGallerySelection(delta);
        return;
      }

      if (e.key === "Enter") {
        const item = selectedPath ? items.find((i) => i.path === selectedPath) : items[0];
        if (item) viewImage(item);
        return;
      }

      if (e.key === "F2") {
        if (selectedPath) {
          const item = items.find((i) => i.path === selectedPath);
          if (item) void handleRenameItem(item);
          return;
        }
        if (currentPath) {
          const folder = findFolder(tree, currentPath);
          if (folder) void handleRenameFolder(folder);
        }
        return;
      }

      // Delete
      if (selectedPath) {
        const item = items.find((i) => i.path === selectedPath);
        if (!item) return;
        invoke("delete_gallery_item", { path: item.path })
          .then(() => setItems((prev) => prev.filter((i) => i.path !== item.path)))
          .catch((err) => { void dialog.alert({ title: "Could not delete", message: String(err) }); });
        return;
      }
      if (currentPath) {
        const folder = findFolder(tree, currentPath);
        if (folder) void handleDeleteFolder(folder);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [currentPath, dialog, handleDeleteFolder, handleRenameFolder, handleRenameItem, items, moveGallerySelection, selectedPath, tree, viewImage]);

  // Keep the info panel useful as soon as the gallery opens: select the
  // first visible item by default, and move to the next item after deletes.
  useEffect(() => {
    if (items.length === 0) {
      if (selectedPath !== null) setSelectedPath(null);
      return;
    }
    if (selectedPath === null || !items.some((i) => i.path === selectedPath)) {
      setSelectedPath(items[0].path);
    }
  }, [items, selectedPath]);

  useEffect(() => {
    if (!selectedPath) return;
    requestPreview(selectedPath);
    requestMetadata(selectedPath);
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-gallery-path="${CSS.escape(selectedPath)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [requestMetadata, requestPreview, selectedPath]);

  const selectedMetadata = selectedPath ? metadataCache[selectedPath] : undefined;

  const currentFolder = useMemo(
    () => findFolder(tree, currentPath),
    [tree, currentPath],
  );

  return (
    <div className="flex flex-col">
      {/* Title bar matches the "Capture mode" header on the selector card. */}
      <div className="px-4 pt-4 pb-2 flex items-center gap-4 border-b border-white/12">
        <span className="text-white font-semibold text-sm tracking-tight drop-shadow-sm">Gallery</span>
      </div>
    <div ref={containerRef} className="flex" style={{ minHeight: 440 }}>
      {/* Folder tree sidebar */}
      <div className="w-56 shrink-0 border-r border-white/12 flex flex-col" style={{ maxHeight: 520 }}>
        <div className="liem-scrollbar flex-1 overflow-y-auto px-1 py-2">
          {tree ? (
            <FolderTreeNode
              node={tree}
              depth={0}
              currentPath={currentPath}
              onSelect={setCurrentPath}
              onRename={handleRenameFolder}
              onDelete={handleDeleteFolder}
              onCreateChild={handleCreateChildFolder}
              dropTargetPath={draggingItem ? dropTargetPath : null}
              isRoot={true}
              expanded={expandedFolders}
              onToggleExpand={toggleExpand}
            />
          ) : (
            <div className="px-2 py-2 text-[11px] text-white/55">Loading…</div>
          )}
        </div>
      </div>

      {/* Middle pane: header + grid */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
          <span className="text-white/85 text-xs font-semibold tracking-tight drop-shadow-sm truncate">
            {currentFolder?.name || ROOT_LABEL}
          </span>
          <span className="text-white/50 text-[10px]">
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="px-3 pb-3 flex-1 flex flex-col">
          {initialLoading && !hasItemsRef.current ? (
            <div className="text-center text-xs text-white/55 py-6">Loading gallery…</div>
          ) : items.length === 0 ? (
            <div className="text-center text-xs text-white/55 py-6">
              Folder is empty
            </div>
          ) : (
            <div
              ref={gridRef}
              className="liem-scrollbar grid grid-cols-[repeat(3,minmax(0,1fr))] auto-rows-max gap-2.5 overflow-y-auto pr-1.5"
              style={{ maxHeight: 420 }}
            >
              {items.map((item) => (
                <GalleryTile
                  key={item.path}
                  item={item}
                  previewB64={previews[item.path]}
                  selected={selectedPath === item.path}
                  onPointerDown={handleTilePointerDown}
                  onCopy={handleCopy}
                  onDelete={handleDeleteItem}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right info panel stays mounted so the gallery layout is complete on open. */}
      <div
        className="w-60 shrink-0 border-l border-white/12 flex flex-col"
        style={{ maxHeight: 520 }}
      >
        {selectedPath ? (
          <>
          <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
            <span className="text-white/85 text-xs font-semibold tracking-tight">Info</span>
          </div>
          <div className="liem-scrollbar px-3 pb-3 flex-1 overflow-y-auto flex flex-col gap-3">
            {/* Preview */}
            <div className="aspect-[3/2] rounded-lg overflow-hidden border border-white/15 bg-black/40">
              {previews[selectedPath] ? (
                <img
                  src={`data:image/png;base64,${previews[selectedPath]}`}
                  alt={selectedMetadata?.name ?? ""}
                  draggable={false}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-white/45">…</div>
              )}
            </div>

            {/* File name */}
            <div>
              <div className="uppercase tracking-wider text-white/45 text-[9px] mb-0.5">Name</div>
              <div className="group flex items-start gap-1.5">
                <div
                  className="text-white/95 text-[11px] break-all flex-1 min-w-0"
                  title={selectedMetadata?.name ?? selectedPath}
                >
                  {selectedMetadata?.name ?? "…"}
                </div>
                <button
                  onClick={() => {
                    const item = items.find((i) => i.path === selectedPath);
                    if (item) handleRenameItem(item);
                  }}
                  className="w-6 h-6 shrink-0 rounded-md hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white/95"
                  title="Rename"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 20l4.2-1 10.6-10.6a2.1 2.1 0 00-3-3L5.2 16 4 20z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>

            {selectedMetadata ? (
              <>
                <div>
                  <div className="uppercase tracking-wider text-white/45 text-[9px] mb-0.5">Resolution</div>
                  <div className="text-white/90 text-[11px]">
                    {selectedMetadata.width} × {selectedMetadata.height} px
                  </div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-white/45 text-[9px] mb-0.5">Size</div>
                  <div className="text-white/90 text-[11px]">{formatBytes(selectedMetadata.sizeBytes)}</div>
                </div>
                <div>
                  <div className="uppercase tracking-wider text-white/45 text-[9px] mb-0.5">Taken</div>
                  <div className="text-white/90 text-[11px]">{formatDateTime(selectedMetadata.modifiedMs)}</div>
                </div>
              </>
            ) : (
              <div className="text-[11px] text-white/55">Loading info…</div>
            )}

            {/* Action button at the bottom */}
            <button
              onClick={() => {
                const item = items.find((i) => i.path === selectedPath);
                if (item) openInEditor(item);
              }}
              className="mt-auto w-full px-3 py-2 rounded-md bg-white/15 hover:bg-white/30 border border-white/25 text-white/95 text-[12px] font-semibold"
              title="Open in editor"
            >
              Open in editor
            </button>
          </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
              <span className="text-white/85 text-xs font-semibold tracking-tight">Info</span>
            </div>
            <div className="px-3 pb-3 flex-1 flex items-center justify-center text-center text-[11px] text-white/55">
              No screenshots in this folder
            </div>
          </>
        )}
      </div>

      {/* Ghost that follows the cursor during an internal drag — purely
          visual cue so the user can see what they're moving. */}
      {draggingItem && previews[draggingItem.path] && (
        <DragGhost previewB64={previews[draggingItem.path]} />
      )}
    </div>
    </div>
  );
}

function ImageViewer({
  path,
  name,
  onClose,
}: {
  path: string;
  name: string;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const panStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 6;
  const ZOOM_STEP = 0.2;

  // Load the full image as base64 once when the viewer mounts.
  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_image_data", { path })
      .then((b64) => { if (!cancelled) setDataUrl(`data:image/png;base64,${b64}`); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [path]);

  // Mark the viewer as open while mounted so the Overlay's keydown handler
  // can ignore Esc and let our handler dismiss only the viewer.
  useEffect(() => {
    viewerOpenRef.current = true;
    return () => { viewerOpenRef.current = false; };
  }, []);

  // Esc closes the viewer. stopImmediatePropagation prevents any later
  // window-level listeners (e.g. the Overlay's own Esc handler) from also
  // firing on the same event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((window as Window & { __LIEM_RECORDING_HOTKEY?: boolean }).__LIEM_RECORDING_HOTKEY) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Ctrl + wheel = zoom. Recentred toward the cursor so the pixel under
  // the cursor stays roughly in place — feels natural and matches every
  // image viewer the user has touched before.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;

      setZoom((prevZoom) => {
        const direction = e.deltaY < 0 ? 1 : -1;
        const nextZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, +(prevZoom + direction * ZOOM_STEP).toFixed(3)),
        );
        if (nextZoom === prevZoom) return prevZoom;
        // Adjust pan so the point under the cursor stays anchored. With
        // zoom returning to 1 we reset pan to 0 since there's no slack.
        if (nextZoom <= MIN_ZOOM) {
          setPan({ x: 0, y: 0 });
          return MIN_ZOOM;
        }
        setPan((prevPan) => {
          const scaleDelta = nextZoom / prevZoom;
          return {
            x: cx - (cx - prevPan.x) * scaleDelta,
            y: cy - (cy - prevPan.y) * scaleDelta,
          };
        });
        return nextZoom;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag-to-pan, but only when there's headroom (zoom > 1). At 1x the
  // image fits exactly so panning would just slide it off-frame. Both
  // left (button 0) and middle (button 1) trigger pan — middle is the
  // muscle-memory pan button in image viewers / 3D apps, so honour it.
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if ((e.button !== 0 && e.button !== 1) || zoom <= MIN_ZOOM) return;
    e.preventDefault();
    panStateRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [pan.x, pan.y, zoom]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const s = panStateRef.current;
    if (!s) return;
    setPan({ x: s.baseX + (e.clientX - s.startX), y: s.baseY + (e.clientY - s.startY) });
  }, []);

  const onPointerUp = useCallback(() => { panStateRef.current = null; }, []);

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(3))), []);
  const zoomOut = useCallback(() => setZoom((z) => {
    const next = Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(3));
    if (next <= MIN_ZOOM) setPan({ x: 0, y: 0 });
    return next;
  }), []);

  const canPan = zoom > MIN_ZOOM;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="w-full rounded-[16px] overflow-hidden"
      style={{
        background: "rgba(255,255,255,0.08)",
        border: "2px solid rgba(255,255,255,0.78)",
        boxShadow: "0 18px 48px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.32)",
        backdropFilter: "blur(24px) saturate(1.35)",
        WebkitBackdropFilter: "blur(24px) saturate(1.35)",
      }}
    >
      <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-white/10">
        <span className="text-white font-semibold text-sm truncate drop-shadow-sm" title={name}>{name}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={zoomOut}
            className="w-8 h-7 rounded-md hover:bg-white/15 border border-white/15 flex items-center justify-center text-white/85"
            title="Zoom out"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
          <span className="w-12 text-center text-white/85 text-[11px] tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            onClick={zoomIn}
            className="w-8 h-7 rounded-md hover:bg-white/15 border border-white/15 flex items-center justify-center text-white/85"
            title="Zoom in"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M12 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
          <button
            onClick={resetView}
            disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
            className="px-2 h-7 rounded-md hover:bg-white/15 border border-white/15 flex items-center justify-center text-white/85 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
            title="Reset view"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className="w-8 h-7 rounded-md hover:bg-red-500/45 border border-white/15 flex items-center justify-center text-white/85"
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Suppress the browser's middle-click autoscroll widget so the
        // middle button is free to be used as a pan trigger.
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
        className="relative overflow-hidden flex items-center justify-center bg-black/60"
        style={{
          height: 520,
          cursor: canPan ? (panStateRef.current ? "grabbing" : "grab") : "default",
          touchAction: "none",
        }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={name}
            draggable={false}
            className="max-w-full max-h-full object-contain pointer-events-none select-none"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: panStateRef.current ? "none" : "transform 80ms linear",
            }}
          />
        ) : (
          <div className="text-white/55 text-xs">Loading image…</div>
        )}
      </div>
    </motion.div>
  );
}

function DragGhost({ previewB64 }: { previewB64: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return (
    <div
      ref={ref}
      className="fixed top-0 left-0 pointer-events-none z-50 w-32 aspect-[3/2] rounded-lg overflow-hidden border border-white/40 shadow-2xl opacity-90"
    >
      <img src={`data:image/png;base64,${previewB64}`} draggable={false} className="w-full h-full object-cover" />
    </div>
  );
}

const SELECTOR_SURFACE_STYLE = {
  background: "linear-gradient(145deg, rgba(24,24,27,0.98), rgba(12,12,14,0.98))",
  border: "1px solid rgba(255,255,255,0.10)",
  boxShadow: "0 26px 70px rgba(0,0,0,0.58), inset 0 1px 0 rgba(255,255,255,0.08)",
} as const;

const SELECTOR_BUTTON_CLASS =
  "h-16 flex items-center gap-3 px-3 rounded-lg text-left transition-all border border-white/[0.08] bg-zinc-900/80 hover:bg-zinc-800/95 hover:border-white/28 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.08)] active:bg-zinc-700/90 focus:outline-none";

const SELECTOR_ACTION_CLASS =
  "min-h-64 flex flex-col items-center justify-center gap-5 p-5 rounded-lg text-center transition-all border border-white/[0.08] bg-zinc-900/80 hover:bg-zinc-800/95 hover:border-white/28 active:bg-zinc-700/90 focus:outline-none";

const SELECTOR_ICON_CLASS =
  "w-6 h-6 rounded-md bg-white/[0.08] border border-white/[0.12] text-white/88 flex items-center justify-center shrink-0";

function defaultSelectorFocusKey() {
  const first = BASE_MODES.findIndex((m) => !m.disabled);
  return first === -1 ? "gallery" : `mode-${first + 1}`;
}

function SettingsPanel({
  hotkey,
  onHotkeyApplied,
  overlayShortcuts,
  onOverlayShortcutsChange,
}: {
  hotkey: string;
  onHotkeyApplied: (value: string) => void;
  overlayShortcuts: OverlayShortcuts;
  onOverlayShortcutsChange: (next: OverlayShortcuts) => void;
}) {
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [liveHotkeyTokens, setLiveHotkeyTokens] = useState<string[]>([]);
  const [hotkeyStatus, setHotkeyStatus] = useState("");
  const hotkeyEditAppliedRef = useRef(false);
  // Which overlay action's shortcut is currently being captured (null = idle).
  const [recordingOverlayAction, setRecordingOverlayAction] = useState<OverlayAction | null>(null);
  const [overlayShortcutError, setOverlayShortcutError] = useState<string>("");
  // Autostart toggle. `null` while we're still asking Rust on mount so the
  // switch doesn't flicker on→off during the first render.
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("get_autostart_enabled")
      .then((value) => { if (!cancelled) setAutostartEnabled(value); })
      .catch((err) => {
        console.error("get_autostart_enabled failed", err);
        if (!cancelled) setAutostartEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  const toggleAutostart = useCallback(async () => {
    if (autostartBusy || autostartEnabled === null) return;
    const next = !autostartEnabled;
    setAutostartBusy(true);
    setAutostartEnabled(next); // optimistic so the switch feels instant
    try {
      const applied = await invoke<boolean>("set_autostart_enabled", { enabled: next });
      setAutostartEnabled(applied);
    } catch (err) {
      console.error("set_autostart_enabled failed", err);
      setAutostartEnabled(!next); // revert on error
    } finally {
      setAutostartBusy(false);
    }
  }, [autostartBusy, autostartEnabled]);

  // Capture loop for the in-overlay shortcut rebinder. Listens for the next
  // a-z / 0-9 keypress, validates uniqueness against the other 3 shortcuts,
  // and persists. Esc cancels.
  useEffect(() => {
    if (!recordingOverlayAction) return;
    const action = recordingOverlayAction;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === "Escape") {
        setRecordingOverlayAction(null);
        setOverlayShortcutError("");
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) {
        setOverlayShortcutError("Modifier tidak dipakai — tekan huruf / angka aja");
        return;
      }
      const key = e.key.toLowerCase();
      if (!/^[a-z0-9]$/.test(key)) {
        setOverlayShortcutError("Cuma huruf a-z atau angka 0-9");
        return;
      }
      // Reject if another action already owns this key.
      const conflict = (Object.entries(overlayShortcuts) as [OverlayAction, string][])
        .find(([a, v]) => a !== action && v === key);
      if (conflict) {
        setOverlayShortcutError(`"${key.toUpperCase()}" sudah dipakai ${OVERLAY_ACTION_LABELS[conflict[0]]}`);
        return;
      }
      onOverlayShortcutsChange({ ...overlayShortcuts, [action]: key });
      setRecordingOverlayAction(null);
      setOverlayShortcutError("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingOverlayAction, overlayShortcuts, onOverlayShortcutsChange]);

  const startOverlayShortcutEdit = useCallback((action: OverlayAction) => {
    setOverlayShortcutError("");
    setRecordingOverlayAction(action);
  }, []);

  useEffect(() => {
    if (!recordingHotkey) setLiveHotkeyTokens([]);
  }, [hotkey, recordingHotkey]);

  const applyRecordedHotkey = useCallback(async (spec: string) => {
    try {
      const applied = await invoke<string>("set_capture_hotkey", { shortcut: spec });
      hotkeyEditAppliedRef.current = true;
      onHotkeyApplied(applied);
      setHotkeyStatus("");
    } catch (error) {
      setHotkeyStatus(String(error));
      void invoke("resume_capture_hotkey").catch(console.error);
    } finally {
      setRecordingHotkey(false);
      setLiveHotkeyTokens([]);
    }
  }, [onHotkeyApplied]);

  const startHotkeyEdit = useCallback(() => {
    setHotkeyStatus("Hold exactly 3 keys");
    setLiveHotkeyTokens([]);
    void invoke("suspend_capture_hotkey")
      .catch(console.error)
      .then(() => invoke("start_hotkey_recording"))
      .catch(console.error)
      .finally(() => setRecordingHotkey(true));
  }, []);

  useEffect(() => {
    if (!recordingHotkey) return;
    const recordingWindow = window as Window & { __LIEM_RECORDING_HOTKEY?: boolean };
    recordingWindow.__LIEM_RECORDING_HOTKEY = true;
    const pressedCodes = new Set<string>();
    const pressedModifiers = new Set<string>();
    const pressedMainKeys = new Set<string>();
    let capturedTokens: string[] = [];
    let applied = false;

    const tokensFromState = () => {
      // Windows key is intentionally excluded — Win-anything is reserved
      // by the OS (Win+R, Win+Shift+S, etc.) and even when our LL hook
      // swallows the down event, Windows often grabs the shortcut first,
      // leaving Win "stuck" in OS state. We just refuse the key outright
      // in the recorder instead of pretending it's a valid modifier.
      const orderedModifiers = ["Ctrl", "Shift", "Alt"].filter((token) => {
        return pressedModifiers.has(token);
      });
      return [...orderedModifiers, ...pressedMainKeys];
    };

    const hasMainKey = (tokens: string[]) => {
      return tokens.some((token) => !["Ctrl", "Shift", "Alt"].includes(token));
    };

    const cancelRecording = () => {
      setRecordingHotkey(false);
      setLiveHotkeyTokens([]);
      setHotkeyStatus("");
      void invoke("stop_hotkey_recording").catch(console.error);
      void invoke("resume_capture_hotkey").catch(console.error);
    };

    // Surface a friendly rejection the moment a Win key is pressed so the
    // user knows why nothing showed up in the chip row.
    const unlistenSuper = listen<{ down: boolean }>("liem-hotkey-super", (event) => {
      if (event.payload.down) {
        setHotkeyStatus("Windows key tidak didukung — pakai Ctrl / Shift / Alt");
      }
    });

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        cancelRecording();
        return;
      }
      pressedCodes.add(event.code);
      const modifier = modifierFromKeyboardCode(event.code);
      if (modifier) {
        pressedModifiers.add(modifier);
      }
      const key = keyFromKeyboardEvent(event);
      if (key) {
        pressedMainKeys.add(key);
      }
      const tokens = tokensFromState();
      setLiveHotkeyTokens(tokens);
      if (tokens.length > 3) {
        setHotkeyStatus("Use exactly 3 keys");
        return;
      }
      if (tokens.length < 3 || !hasMainKey(tokens)) {
        setHotkeyStatus("Hold exactly 3 keys");
        return;
      }
      capturedTokens = tokens;
      setHotkeyStatus("Release to apply");
    };

    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pressedCodes.delete(event.code);
      const modifier = modifierFromKeyboardCode(event.code);
      if (modifier) {
        pressedModifiers.delete(modifier);
      }
      const key = keyFromKeyboardEvent(event);
      if (key) {
        pressedMainKeys.delete(key);
      }
      if (pressedCodes.size > 0 || applied) return;
      if (capturedTokens.length !== 3 || !hasMainKey(capturedTokens)) {
        setHotkeyStatus("Hold exactly 3 keys");
        capturedTokens = [];
        setLiveHotkeyTokens([]);
        return;
      }
      applied = true;
      setHotkeyStatus("Applying...");
      void applyRecordedHotkey(capturedTokens.join("+"));
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      recordingWindow.__LIEM_RECORDING_HOTKEY = false;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      void unlistenSuper.then((fn) => fn());
      void invoke("stop_hotkey_recording").catch(console.error);
      if (!hotkeyEditAppliedRef.current) {
        void invoke("resume_capture_hotkey").catch(console.error);
      }
      hotkeyEditAppliedRef.current = false;
    };
  }, [applyRecordedHotkey, recordingHotkey]);

  const visibleHotkeyTokens = recordingHotkey
    ? liveHotkeyTokens
    : hotkey.split("+").map((part) => part.trim()).filter(Boolean);

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-2 flex items-center gap-4 border-b border-white/12">
        <span className="text-white/92 font-semibold text-sm tracking-tight">Settings</span>
      </div>
      <div className="flex" style={{ minHeight: 440 }}>
        <section className="flex-1 min-w-0 p-4">
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-white/85 text-xs font-semibold mb-3">Capture shortcut</div>
              <div className="flex items-center gap-2">
                <div className={[
                  "min-h-10 flex-1 rounded-lg border px-3 py-2 flex flex-wrap items-center gap-1.5",
                  recordingHotkey ? "border-blue-300/30 bg-blue-400/[0.07]" : "border-white/[0.08] bg-zinc-950/70",
                ].join(" ")}>
                  {visibleHotkeyTokens.length === 0 ? (
                    <span className="text-white/35 text-xs">Hold keys...</span>
                  ) : visibleHotkeyTokens.map((token) => (
                    <kbd
                      key={token}
                      className="px-2 py-1 rounded-md bg-white/[0.10] border border-white/[0.10] text-white/82 text-xs font-mono"
                    >
                      {token}
                    </kbd>
                  ))}
                </div>
                <button
                  onClick={startHotkeyEdit}
                  disabled={recordingHotkey}
                  className="h-10 px-3 rounded-lg border border-white/[0.10] bg-zinc-900/80 hover:bg-zinc-800/95 text-white/86 text-xs font-semibold transition-colors disabled:opacity-60"
                >
                  Edit
                </button>
              </div>
              <div className="mt-2 min-h-4 text-[11px] text-white/48">
                {recordingHotkey
                  ? "Hold exactly 3 keys. The shortcut applies automatically."
                  : hotkeyStatus}
              </div>
            </div>

            <div className="border-t border-white/[0.07] pt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-white/85 text-xs font-semibold">In-overlay shortcuts</div>
              </div>
              <div className="flex flex-col gap-1.5">
                {(["area", "fullscreen", "gallery", "settings"] as const).map((action) => {
                  const recording = recordingOverlayAction === action;
                  return (
                    <div
                      key={action}
                      className={[
                        "h-10 flex items-center gap-3 px-3 rounded-lg border transition-colors",
                        recording ? "border-blue-300/30 bg-blue-400/[0.07]" : "border-white/[0.08] bg-zinc-950/70",
                      ].join(" ")}
                    >
                      <span className="flex-1 text-white/82 text-xs">{OVERLAY_ACTION_LABELS[action]}</span>
                      <kbd className="px-2 py-1 rounded-md bg-white/[0.08] border border-white/[0.12] text-white/85 text-xs font-mono min-w-7 text-center">
                        {recording ? "…" : overlayShortcuts[action].toUpperCase()}
                      </kbd>
                      <button
                        onClick={() => {
                          if (recording) {
                            setRecordingOverlayAction(null);
                            setOverlayShortcutError("");
                          } else {
                            startOverlayShortcutEdit(action);
                          }
                        }}
                        disabled={!!recordingOverlayAction && !recording}
                        className="h-7 px-2.5 rounded-md border border-white/[0.10] bg-zinc-900/80 hover:bg-zinc-800/95 text-white/82 text-[11px] font-semibold transition-colors disabled:opacity-50"
                      >
                        {recording ? "Cancel" : "Edit"}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 min-h-4 text-[11px] text-white/48">
                {recordingOverlayAction
                  ? overlayShortcutError || "Tekan huruf / angka. Esc batal."
                  : overlayShortcutError}
              </div>
            </div>

            <div className="border-t border-white/[0.07] pt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-white/85 text-xs font-semibold">Startup</div>
              </div>
              <div className="h-10 flex items-center gap-3 px-3 rounded-lg border border-white/[0.08] bg-zinc-950/70">
                <span className="flex-1 text-white/82 text-xs">Run on startup</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autostartEnabled === true}
                  onClick={toggleAutostart}
                  disabled={autostartEnabled === null || autostartBusy}
                  className={[
                    "relative w-9 h-5 rounded-full border transition-colors shrink-0 disabled:opacity-50",
                    autostartEnabled
                      ? "bg-white/85 border-white/85"
                      : "bg-white/[0.10] border-white/[0.18]",
                  ].join(" ")}
                  title={autostartEnabled ? "Disable" : "Enable"}
                >
                  <span
                    className={[
                      "absolute top-[1px] w-[15px] h-[15px] rounded-full transition-all",
                      autostartEnabled
                        ? "left-[18px] bg-zinc-950"
                        : "left-[2px] bg-white/85",
                    ].join(" ")}
                  />
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ModeSelector({
  isClosing,
  onSelect,
  onClose,
  shortcuts,
  onShortcutsChange,
}: {
  isClosing: boolean;
  onSelect: (key: string) => void;
  onClose: () => void;
  shortcuts: OverlayShortcuts;
  onShortcutsChange: (next: OverlayShortcuts) => void;
}) {
  const [viewingItem, setViewingItem] = useState<GalleryItem | null>(null);
  const [selectorView, setSelectorView] = useState<"menu" | "gallery" | "settings">("menu");
  // Arrow-key focus tracking for the main menu. Covers all 5 actionable
  // tiles: 3 mode buttons (Area/Fullscreen/Scroll) + Gallery + Settings.
  // Default focus is the first non-disabled mode.
  const [focusedKey, setFocusedKey] = useState<string>(() => defaultSelectorFocusKey());
  const [showKeyboardFocus, setShowKeyboardFocus] = useState(false);
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);

  // If the user closes the overlay while viewing, clear the viewer so the
  // next time they hit Ctrl+Shift+2 we land on the selector again.
  useEffect(() => {
    if (isClosing) {
      setViewingItem(null);
      setSelectorView("menu");
      setFocusedKey(defaultSelectorFocusKey());
      setShowKeyboardFocus(false);
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }, [isClosing]);

  useEffect(() => {
    if (selectorView === "menu") {
      setFocusedKey(defaultSelectorFocusKey());
      setShowKeyboardFocus(false);
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }, [selectorView]);

  useEffect(() => {
    invoke<string>("get_capture_hotkey")
      .then(setHotkey)
      .catch(() => setHotkey(DEFAULT_HOTKEY));
  }, []);

  useEffect(() => {
    selectorBackRef.current = () => {
      if (viewingItem || selectorView === "menu") return false;
      setSelectorView("menu");
      return true;
    };

    return () => {
      selectorBackRef.current = null;
    };
  }, [selectorView, viewingItem]);


  // (Esc-back handling lives in Overlay's main keydown handler, which
  // is what actually consumes the event. selectorBackRef closes over
  // setSelectorView and the latest selectorView / viewingItem values.)

  const handleViewItem = useCallback((item: GalleryItem) => {
    setViewingItem(item);
  }, []);

  const handleCloseViewer = useCallback(() => {
    setViewingItem(null);
  }, []);

  // Keyboard navigation for the main menu. Layout:
  //   row 0: [mode-1] [mode-2] [mode-3]
  //   row 1: [gallery] [settings]
  // ←/→ cycles within the current row (skipping disabled). ↑/↓ jumps to
  // the other row, picking the column closest to where the focus was.
  // Enter triggers the focused tile. Only fires while we're actually on
  // the main menu and no view/dialog is layered above.
  useEffect(() => {
    if (viewingItem || selectorView !== "menu") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      type Item = { id: string; row: number; col: number; disabled: boolean; action: () => void };
      const items: Item[] = [
        { id: "mode-1", row: 0, col: 0, disabled: BASE_MODES[0].disabled, action: () => onSelect("area") },
        { id: "mode-2", row: 0, col: 1, disabled: BASE_MODES[1].disabled, action: () => onSelect("fullscreen") },
        { id: "mode-3", row: 0, col: 2, disabled: BASE_MODES[2].disabled, action: () => onSelect("scroll") },
        { id: "gallery", row: 1, col: 0, disabled: false, action: () => setSelectorView("gallery") },
        { id: "settings", row: 1, col: 1, disabled: false, action: () => setSelectorView("settings") },
      ];
      const current = items.find((it) => it.id === focusedKey) ?? items[0];

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        if (!showKeyboardFocus) {
          setShowKeyboardFocus(true);
          setFocusedKey(defaultSelectorFocusKey());
          return;
        }
        setShowKeyboardFocus(true);
        const delta = e.key === "ArrowLeft" ? -1 : 1;
        const sameRow = items.filter((it) => it.row === current.row && !it.disabled);
        if (sameRow.length === 0) return;
        const idx = sameRow.findIndex((it) => it.id === current.id);
        const nextIdx = (Math.max(0, idx) + delta + sameRow.length) % sameRow.length;
        setFocusedKey(sameRow[nextIdx].id);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (!showKeyboardFocus) {
          setShowKeyboardFocus(true);
          setFocusedKey("gallery");
          return;
        }
        setShowKeyboardFocus(true);
        if (current.row === 1) return;
        // Top → bottom: cols 0/1 land on Gallery, col 2 lands on Settings.
        setFocusedKey(current.col === 2 ? "settings" : "gallery");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (!showKeyboardFocus) {
          setShowKeyboardFocus(true);
          setFocusedKey(defaultSelectorFocusKey());
          return;
        }
        setShowKeyboardFocus(true);
        if (current.row === 0) return;
        // Bottom → top: Gallery → first enabled mode, Settings → 2nd
        // enabled mode (or first if 2nd is disabled).
        const enabledModes = items.filter((it) => it.row === 0 && !it.disabled);
        if (enabledModes.length === 0) return;
        const target = current.col === 0
          ? enabledModes[0]
          : enabledModes[Math.min(1, enabledModes.length - 1)];
        setFocusedKey(target.id);
      } else if (e.key === "Enter") {
        if (current.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        current.action();
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        // Customizable quick-jump shortcuts: gallery / settings. The area /
        // fullscreen shortcuts are handled by the outer Overlay keydown so
        // they can fire whether we're on the menu or already mid-capture.
        const k = e.key.toLowerCase();
        if (k === shortcuts.gallery) {
          e.preventDefault();
          e.stopPropagation();
          setSelectorView("gallery");
        } else if (k === shortcuts.settings) {
          e.preventDefault();
          e.stopPropagation();
          setSelectorView("settings");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedKey, onSelect, selectorView, shortcuts.gallery, shortcuts.settings, showKeyboardFocus, viewingItem]);

  return (
    <motion.div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.74)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: isClosing ? 0 : 1 }}
      transition={{ opacity: { duration: 0.12, ease: "easeOut" } }}
    >
      <div className="flex flex-col items-center gap-3 w-[920px] max-w-[calc(100vw-32px)]">
        {viewingItem ? (
          // ─── View mode: stays inside the Ctrl+Shift+2 modal so the user
          //   can scroll-zoom / pan / close without losing context. ───
          <ImageViewer
            path={viewingItem.path}
            name={viewingItem.name}
            onClose={handleCloseViewer}
          />
        ) : (
          <>
            {/* Card 1 — capture mode selector */}
            {selectorView === "menu" && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: isClosing ? 0 : 1, y: 0 }}
              transition={{
                opacity: { duration: isClosing ? 0 : 0.12, ease: "easeOut" },
                y: { duration: 0.18, ease: "easeOut" },
              }}
              className="w-full rounded-xl overflow-hidden"
              style={SELECTOR_SURFACE_STYLE}
            >
              <div className="px-4 pt-4 pb-2 flex items-center gap-4">
                <span className="text-white/92 font-semibold text-sm tracking-tight">Capture mode</span>
              </div>

              <div className="px-3 pb-3 grid grid-cols-3 gap-2">
                {BASE_MODES.map((m, i) => {
                  const focused = showKeyboardFocus && focusedKey === `mode-${i + 1}`;
                  const keyLabel = m.id === "area"
                    ? shortcuts.area.toUpperCase()
                    : m.id === "fullscreen"
                      ? shortcuts.fullscreen.toUpperCase()
                      : "·"; // scroll is disabled, no shortcut
                  return (
                  <button
                    key={m.id}
                    disabled={m.disabled}
                    onClick={(event) => {
                      event.currentTarget.blur();
                      if (!m.disabled) onSelect(m.id);
                    }}
                    onMouseEnter={() => !m.disabled && setFocusedKey(`mode-${i + 1}`)}
                    className={[
                      SELECTOR_BUTTON_CLASS,
                      m.disabled ? "opacity-45 cursor-not-allowed" : "cursor-pointer",
                      focused ? "ring-2 ring-white/55 border-white/30 bg-zinc-800/95" : "",
                    ].join(" ")}
                  >
                    <kbd className={SELECTOR_ICON_CLASS + " text-xs font-mono shadow-sm"}>
                      {keyLabel}
                    </kbd>
                    <span className="text-white text-sm font-semibold drop-shadow-sm min-w-0 truncate">{m.label}</span>
                    {m.disabled && (
                      <span className="ml-auto text-[10px] text-white/58 bg-white/[0.06] border border-white/[0.08] px-1.5 py-0.5 rounded-full">soon</span>
                    )}
                  </button>
                  );
                })}
              </div>
              <div className="px-3 pb-3 grid grid-cols-2 gap-2 border-t border-white/[0.07] pt-3">
                <button
                  onClick={() => setSelectorView("gallery")}
                  onMouseEnter={() => setFocusedKey("gallery")}
                  className={[
                    SELECTOR_ACTION_CLASS,
                    "relative",
                    showKeyboardFocus && focusedKey === "gallery" ? "ring-2 ring-white/55 border-white/30 bg-zinc-800/95" : "",
                  ].join(" ")}
                >
                  <kbd className="absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-white/[0.08] border border-white/[0.12] text-white/82 text-[10px] font-mono">
                    {shortcuts.gallery.toUpperCase()}
                  </kbd>
                  <span className="w-16 h-16 rounded-2xl bg-white/[0.08] border border-white/[0.12] text-white/88 flex items-center justify-center">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M8 14l2.2-2.2 2 2L15 11l3 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="text-white text-lg font-semibold">Gallery</span>
                </button>
                <button
                  onClick={() => setSelectorView("settings")}
                  onMouseEnter={() => setFocusedKey("settings")}
                  className={[
                    SELECTOR_ACTION_CLASS,
                    "relative",
                    showKeyboardFocus && focusedKey === "settings" ? "ring-2 ring-white/55 border-white/30 bg-zinc-800/95" : "",
                  ].join(" ")}
                >
                  <kbd className="absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-white/[0.08] border border-white/[0.12] text-white/82 text-[10px] font-mono">
                    {shortcuts.settings.toUpperCase()}
                  </kbd>
                  <span className="w-16 h-16 rounded-2xl bg-white/[0.08] border border-white/[0.12] text-white/88 flex items-center justify-center">
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M19 12a7 7 0 01-.1 1.2l2 1.5-2 3.4-2.4-1a7 7 0 01-2 1.1L14.2 21h-4.4l-.3-2.8a7 7 0 01-2-1.1l-2.4 1-2-3.4 2-1.5A7 7 0 015 12c0-.4 0-.8.1-1.2l-2-1.5 2-3.4 2.4 1a7 7 0 012-1.1L9.8 3h4.4l.3 2.8a7 7 0 012 1.1l2.4-1 2 3.4-2 1.5c.1.4.1.8.1 1.2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span className="text-white text-lg font-semibold">Settings</span>
                </button>
              </div>
            </motion.div>

            )}
            {selectorView === "gallery" && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: isClosing ? 0 : 1, y: 0 }}
              transition={{
                opacity: { duration: isClosing ? 0 : 0.14, ease: "easeOut", delay: isClosing ? 0 : 0.04 },
                y: { duration: 0.2, ease: "easeOut" },
              }}
              className="w-full rounded-xl overflow-hidden"
              style={SELECTOR_SURFACE_STYLE}
            >
              <div className="px-3 pt-3">
                <button
                  onClick={() => setSelectorView("menu")}
                  className="h-8 px-2.5 rounded-lg border border-white/[0.08] bg-zinc-900/80 hover:bg-zinc-800/95 text-white/82 text-xs font-semibold transition-colors"
                >
                  Back
                </button>
              </div>
              <GallerySection
                onClose={onClose}
                onExternalDragComplete={() => setSelectorView("gallery")}
                onViewItem={handleViewItem}
              />
            </motion.div>
            )}
            {selectorView === "settings" && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: isClosing ? 0 : 1, y: 0 }}
              transition={{
                opacity: { duration: isClosing ? 0 : 0.14, ease: "easeOut" },
                y: { duration: 0.2, ease: "easeOut" },
              }}
              className="w-full rounded-xl overflow-hidden"
              style={SELECTOR_SURFACE_STYLE}
            >
              <div className="px-3 pt-3">
                <button
                  onClick={() => setSelectorView("menu")}
                  className="h-8 px-2.5 rounded-lg border border-white/[0.08] bg-zinc-900/80 hover:bg-zinc-800/95 text-white/82 text-xs font-semibold transition-colors"
                >
                  Back
                </button>
              </div>
              <SettingsPanel
                hotkey={hotkey}
                onHotkeyApplied={setHotkey}
                overlayShortcuts={shortcuts}
                onOverlayShortcutsChange={onShortcutsChange}
              />
            </motion.div>
            )}
          </>
        )}
      </div>
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
  const closeTimerRef = useRef<number | null>(null);
  const escCloseSuppressedUntilRef = useRef(0);
  const [mode, setMode] = useState<Mode>("select");
  const [overlayClosing, setOverlayClosing] = useState(false);
  const [selectorClosing, setSelectorClosing] = useState(false);
  const [overlayShortcuts, setOverlayShortcuts] = useState<OverlayShortcuts>(() => loadOverlayShortcuts());
  // Mirror to a ref so the outer keydown handler can stay registered once
  // (instead of being torn down and rebuilt every time the user rebinds a
  // shortcut, which is also the path that re-runs side effects like
  // listening for "close-overlay").
  const overlayShortcutsRef = useRef(overlayShortcuts);
  useEffect(() => {
    overlayShortcutsRef.current = overlayShortcuts;
  }, [overlayShortcuts]);

  const updateOverlayShortcuts = useCallback((next: OverlayShortcuts) => {
    setOverlayShortcuts(next);
    saveOverlayShortcuts(next);
  }, []);

  // Keep ref in sync so event handlers always see latest mode without re-registering
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const hideOverlayBeforeCapture = useCallback(async () => {
    setOverlayClosing(true);
    setSelectorClosing(modeRef.current === "select");
    startPt.current = null;
    isDragging.current = false;

    await new Promise((resolve) => setTimeout(resolve, OVERLAY_CLOSE_MS));

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.display = "none";
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }

    setMode("select");
    modeRef.current = "select";
    await invoke("hide_overlay_for_capture").catch(() => {});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Clear the closing flags now that the window is hidden. The capture
    // path used to leave overlayClosing=true forever (only the Esc/close
    // path reset it), so the NEXT time the overlay was shown via hotkey it
    // rendered at opacity 0 and only became visible once the reset-overlay
    // event landed — but a freshly-shown (previously hidden) WebView2 is
    // throttled and frequently drops that first event, so the overlay
    // stayed invisible until a second press. Resetting here makes the next
    // show start at full opacity regardless of event delivery.
    setOverlayClosing(false);
    setSelectorClosing(false);
  }, []);

  // ── close: synchronous, fire-and-forget hide via Rust ──────────────────────
  const close = useCallback(() => {
    if (closeTimerRef.current !== null) {
      return;
    }

    const closingMode = modeRef.current;
    setOverlayClosing(true);
    setSelectorClosing(closingMode === "select");
    startPt.current = null;
    isDragging.current = false;

    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      invoke("hide_overlay").catch(() => {});
      setMode("select");
      setOverlayClosing(false);
      setSelectorClosing(false);
      modeRef.current = "select";
    }, OVERLAY_CLOSE_MS);
  }, []);

  const handleEscapeRequest = useCallback(() => {
    if (viewerOpenRef.current || dialogOpenRef.current) return;

    if (performance.now() < escCloseSuppressedUntilRef.current) {
      return;
    }

    if (selectorBackRef.current?.()) {
      escCloseSuppressedUntilRef.current = performance.now() + ESC_BACK_COOLDOWN_MS;
      return;
    }

    close();
  }, [close]);

  // Reset when overlay is re-shown
  useEffect(() => {
    const unlisten = listen("reset-overlay", () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setMode("select");
      setOverlayClosing(false);
      setSelectorClosing(false);
      modeRef.current = "select";
      startPt.current = null;
      isDragging.current = false;
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen("close-overlay", () => {
      handleEscapeRequest();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [handleEscapeRequest]);

  // Size canvas when entering crop mode
  useEffect(() => {
    if (mode !== "crop") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    drawCanvas(canvas, null);
  }, [mode]);

  const handleModeSelect = useCallback((action: string) => {
    if (action === "area") {
      setMode("crop");
      modeRef.current = "crop";
    } else if (action === "fullscreen") {
      void (async () => {
        // Fire sfx BEFORE hiding so the audio stream starts while our
        // webview is still visible (WebView2 suppresses audio in hidden
        // windows). Web Audio's OS mixer continues regardless.
        playShotSfx();
        await hideOverlayBeforeCapture();
        await invoke("take_fullscreen");
      })().catch(console.error);
    }
    // "scroll" = coming soon
  }, [hideOverlayBeforeCapture]);

  // ── Single keydown listener — registered once, uses refs for latest state ─
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (viewerOpenRef.current || dialogOpenRef.current) return;
        // Swallow key-repeat and the immediate native/DOM double-fire after
        // a back-to-menu Escape, without making normal follow-up Esc feel slow.
        if (e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (performance.now() < escCloseSuppressedUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        handleEscapeRequest();
        return;
      }
      if (modeRef.current === "select") {
        // Don't trigger mode shortcuts while viewing or while a dialog
        // is taking input — those keys belong to those UIs.
        if (viewerOpenRef.current || dialogOpenRef.current) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        const k = e.key.toLowerCase();
        const sc = overlayShortcutsRef.current;
        if (k === sc.area) {
          handleModeSelect("area");
        } else if (k === sc.fullscreen) {
          handleModeSelect("fullscreen");
        }
      }
    };
    window.addEventListener("keydown", onKey, true); // capture phase = fires first
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleEscapeRequest, handleModeSelect]);

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

      // Fire sfx BEFORE hiding so the audio stream starts while our
      // webview is still visible. Web Audio drives the OS mixer directly,
      // so playback survives the subsequent win.hide().
      playShotSfx();

      // Hide immediately via Rust — fire and forget
      await hideOverlayBeforeCapture();

      try {
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
    <DialogProvider>
      <motion.div
        className="fixed inset-0 w-full h-full overflow-hidden"
        animate={{ opacity: overlayClosing ? 0 : 1 }}
        transition={{ opacity: { duration: 0.12, ease: "easeOut" } }}
      >
        <canvas
          ref={canvasRef}
          className="fixed inset-0 w-full h-full"
          style={{ cursor: "crosshair", display: mode === "crop" ? "block" : "none" }}
        />
        {mode === "select" && (
          <ModeSelector
            isClosing={selectorClosing}
            onSelect={handleModeSelect}
            onClose={close}
            shortcuts={overlayShortcuts}
            onShortcutsChange={updateOverlayShortcuts}
          />
        )}
      </motion.div>
    </DialogProvider>
  );
}
