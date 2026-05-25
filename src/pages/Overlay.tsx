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

const SHOT_SFX_OFFSET_SECONDS = 0;
const OVERLAY_CLOSE_MS = 130;
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
  }
}

const MODES = [
  { key: "1", label: "Area",       disabled: false },
  { key: "2", label: "Fullscreen", disabled: false },
  { key: "3", label: "Scroll",     disabled: true  },
] as const;

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

const ROOT_LABEL = "Liem Shot";
const DRAG_THRESHOLD_PX = 5;

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
  // Root is always treated as expanded so its children are visible by default.
  const isExpanded = isRoot ? true : expanded.has(node.path);

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
        {hasChildren && !isRoot ? (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggleExpand(node.path); }}
            className="w-5 h-5 flex items-center justify-center shrink-0 rounded hover:bg-white/15 text-white/75"
            title={isExpanded ? "Collapse" : "Expand"}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              style={{
                transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 140ms ease",
              }}
            >
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          // Keep the same indent slot so folder icons stay aligned whether or
          // not the node has children / is the root.
          <span className="w-5 h-5 shrink-0" aria-hidden="true" />
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
  requestPreview,
  selected,
  onPointerDown,
  onCopy,
  onDelete,
}: {
  item: GalleryItem;
  previewB64?: string;
  requestPreview: (path: string) => void;
  selected: boolean;
  onPointerDown: (item: GalleryItem, e: ReactPointerEvent) => void;
  onCopy: (item: GalleryItem, e: ReactMouseEvent) => void;
  onDelete: (item: GalleryItem, e: ReactMouseEvent) => void;
}) {
  useEffect(() => {
    if (previewB64) return;
    requestPreview(item.path);
  }, [item.path, previewB64, requestPreview]);

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

function GallerySection({ onClose, onViewItem }: { onClose: () => void; onViewItem: (item: GalleryItem) => void }) {
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
  const hasItemsRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
    if (previews[path] || previewRequests.current.has(path)) return;
    previewRequests.current.add(path);
    invoke<string>("get_gallery_preview", { path })
      .then((b64) => setPreviews((prev) => ({ ...prev, [path]: b64 })))
      .catch(console.error);
  }, [previews]);

  const requestMetadata = useCallback((path: string) => {
    if (metadataCache[path]) return;
    invoke<GalleryMetadata>("get_gallery_metadata", { path })
      .then((meta) => setMetadataCache((prev) => ({ ...prev, [path]: meta })))
      .catch(console.error);
  }, [metadataCache]);

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
    let dropped = false;
    try {
      dropped = (await invoke<boolean>("start_drag", { path: item.path })) ?? false;
    } catch (err) { console.error(err); }
    await invoke("hide_drag_cancel_target").catch(() => {});
    if (!dropped) await invoke("show_overlay_again").catch(() => {});
  }, []);

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

  // Keyboard shortcuts: F2 = rename, Delete = delete. Targets the
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
      if (e.key !== "F2" && e.key !== "Delete") return;

      e.preventDefault();
      e.stopPropagation();

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
  }, [currentPath, dialog, handleDeleteFolder, handleRenameFolder, handleRenameItem, items, selectedPath, tree]);

  // Clear stale selection when the underlying items list changes (folder
  // switch, refresh, deletion) and the selected item no longer exists.
  useEffect(() => {
    if (selectedPath !== null && !items.some((i) => i.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [items, selectedPath]);

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
        <div className="flex-1 overflow-y-auto px-1 py-2">
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
              className="grid grid-cols-3 gap-2.5 overflow-y-auto pr-1"
              style={{ maxHeight: 420 }}
            >
              {items.map((item) => (
                <GalleryTile
                  key={item.path}
                  item={item}
                  previewB64={previews[item.path]}
                  requestPreview={requestPreview}
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

      {/* Right info panel — only mounted when a tile is selected. */}
      {selectedPath && (
        <div
          className="w-60 shrink-0 border-l border-white/12 flex flex-col"
          style={{ maxHeight: 520 }}
        >
          <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
            <span className="text-white/85 text-xs font-semibold tracking-tight">Info</span>
            <button
              onClick={() => setSelectedPath(null)}
              className="w-6 h-6 rounded-md hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white/95"
              title="Close info"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="px-3 pb-3 flex-1 overflow-y-auto flex flex-col gap-3">
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
        </div>
      )}

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

function ModeSelector({
  isClosing,
  onSelect,
  onClose,
}: {
  isClosing: boolean;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const [viewingItem, setViewingItem] = useState<GalleryItem | null>(null);

  // If the user closes the overlay while viewing, clear the viewer so the
  // next time they hit Ctrl+Shift+2 we land on the selector again.
  useEffect(() => {
    if (isClosing) setViewingItem(null);
  }, [isClosing]);

  const handleViewItem = useCallback((item: GalleryItem) => {
    setViewingItem(item);
  }, []);

  const handleCloseViewer = useCallback(() => {
    setViewingItem(null);
  }, []);

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
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: isClosing ? 0 : 1, y: 0 }}
              transition={{
                opacity: { duration: isClosing ? 0 : 0.12, ease: "easeOut" },
                y: { duration: 0.18, ease: "easeOut" },
              }}
              className="w-full rounded-[16px] overflow-hidden"
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "2px solid rgba(255,255,255,0.78)",
                boxShadow: "0 18px 48px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.32)",
                backdropFilter: "blur(24px) saturate(1.35)",
                WebkitBackdropFilter: "blur(24px) saturate(1.35)",
              }}
            >
              <div className="px-4 pt-4 pb-2 flex items-center gap-4">
                <span className="text-white font-semibold text-sm tracking-tight drop-shadow-sm">Capture mode</span>
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

            {/* Card 2 — gallery (tree + grid + right info panel) */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: isClosing ? 0 : 1, y: 0 }}
              transition={{
                opacity: { duration: isClosing ? 0 : 0.14, ease: "easeOut", delay: isClosing ? 0 : 0.04 },
                y: { duration: 0.2, ease: "easeOut" },
              }}
              className="w-full rounded-[16px] overflow-hidden"
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "2px solid rgba(255,255,255,0.78)",
                boxShadow: "0 18px 48px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.32)",
                backdropFilter: "blur(24px) saturate(1.35)",
                WebkitBackdropFilter: "blur(24px) saturate(1.35)",
              }}
            >
              <GallerySection onClose={onClose} onViewItem={handleViewItem} />
            </motion.div>
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
  const [mode, setMode] = useState<Mode>("select");
  const [overlayClosing, setOverlayClosing] = useState(false);
  const [selectorClosing, setSelectorClosing] = useState(false);

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
      close();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [close]);

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
        // If the inline image viewer or a styled dialog is open, let
        // them handle Esc. Their own listeners call
        // stopImmediatePropagation so we won't see this event, but as a
        // belt-and-braces guard we also check the flags.
        if (viewerOpenRef.current || dialogOpenRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        close();              // synchronous, always works
        return;
      }
      if (modeRef.current === "select") {
        // Don't trigger mode shortcuts while viewing or while a dialog
        // is taking input — those keys belong to those UIs.
        if (viewerOpenRef.current || dialogOpenRef.current) return;
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
          <ModeSelector isClosing={selectorClosing} onSelect={handleModeSelect} onClose={close} />
        )}
      </motion.div>
    </DialogProvider>
  );
}
