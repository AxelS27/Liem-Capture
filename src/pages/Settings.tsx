import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";

const DEFAULT_HOTKEY = "Ctrl+Shift+2";

// Map a KeyboardEvent.code to a token Tauri's accelerator parser accepts.
// Returns null for pure modifier keys or codes we don't support.
function mainKeyFromCode(code: string): string | null {
  if (
    code.startsWith("Control") ||
    code.startsWith("Shift") ||
    code.startsWith("Alt") ||
    code.startsWith("Meta") ||
    code === "OSLeft" ||
    code === "OSRight"
  ) {
    return null;
  }
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith("Numpad")) return code;
  const map: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Space: "Space",
    Tab: "Tab",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Backslash: "Backslash",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Backquote: "Backquote",
  };
  return map[code] ?? null;
}

function modifierFromCode(code: string): string | null {
  if (code.startsWith("Control")) return "Ctrl";
  if (code.startsWith("Shift")) return "Shift";
  if (code.startsWith("Alt")) return "Alt";
  if (code.startsWith("Meta") || code === "OSLeft" || code === "OSRight") return "Super";
  return null;
}

// Display label for a token in the saved spec.
function prettyKey(token: string): string {
  if (token === "Super") return "⊞";
  if (token.startsWith("Numpad")) return `Num ${token.slice(6)}`;
  if (token === "BracketLeft") return "[";
  if (token === "BracketRight") return "]";
  if (token === "Minus") return "-";
  if (token === "Equal") return "=";
  if (token === "Semicolon") return ";";
  if (token === "Quote") return "'";
  if (token === "Backslash") return "\\";
  if (token === "Comma") return ",";
  if (token === "Period") return ".";
  if (token === "Slash") return "/";
  if (token === "Backquote") return "`";
  return token;
}

function splitSpec(spec: string): string[] {
  return spec.split("+").map((s) => s.trim()).filter(Boolean);
}

export default function Settings() {
  const [hotkey, setHotkey] = useState<string>(DEFAULT_HOTKEY);
  const [recording, setRecording] = useState(false);
  const [draftTokens, setDraftTokens] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hotkeyEditAppliedRef = useRef(false);

  // Load saved hotkey on mount.
  useEffect(() => {
    invoke<string>("get_capture_hotkey")
      .then((v) => setHotkey(v || DEFAULT_HOTKEY))
      .catch(() => {});
  }, []);

  // Recording: show the held keys live, then auto-apply once the combo has
  // exactly three tokens, e.g. Ctrl+Shift+2.
  useEffect(() => {
    if (!recording) return;
    let capturedTokens: string[] = [];
    const pressedCodes = new Set<string>();
    const pressedModifiers = new Set<string>();
    const pressedMainKeys = new Set<string>();
    let done = false;
    let superDown = false;

    const tokensFromState = () => {
      const orderedModifiers = ["Ctrl", "Shift", "Alt", "Super"].filter((token) => {
        return pressedModifiers.has(token) || (token === "Super" && superDown);
      });
      return [...orderedModifiers, ...pressedMainKeys];
    };

    const hasMainKey = (tokens: string[]) => {
      return tokens.some((token) => !["Ctrl", "Shift", "Alt", "Super"].includes(token));
    };

    const stop = () => {
      done = true;
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      setDraftTokens([]);
      setRecording(false);
      void invoke("stop_hotkey_recording").catch(console.error);
      void invoke("resume_capture_hotkey").catch(console.error);
    };

    const unlistenSuper = listen<{ down: boolean }>("liem-hotkey-super", (event) => {
      superDown = event.payload.down;
      if (superDown) {
        pressedModifiers.add("Super");
        setDraftTokens(tokensFromState());
        return;
      }
      pressedModifiers.delete("Super");
      if (!superDown && pressedCodes.size === 0) {
        setDraftTokens([]);
      } else {
        setDraftTokens(tokensFromState());
      }
    });

    const onDown = (e: KeyboardEvent) => {
      if (done) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        stop();
        return;
      }
      pressedCodes.add(e.code);
      const modifier = modifierFromCode(e.code);
      if (modifier) pressedModifiers.add(modifier);
      const k = mainKeyFromCode(e.code);
      if (k) pressedMainKeys.add(k);
      const tokens = tokensFromState();
      setDraftTokens(tokens);
      if (tokens.length > 3) {
        setError("Use exactly 3 keys");
        return;
      }
      if (tokens.length < 3 || !hasMainKey(tokens)) {
        setError(null);
        return;
      }
      capturedTokens = tokens;
      setError("Release to apply");
    };

    const onUp = (e: KeyboardEvent) => {
      if (done) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      pressedCodes.delete(e.code);
      const modifier = modifierFromCode(e.code);
      if (modifier) pressedModifiers.delete(modifier);
      const key = mainKeyFromCode(e.code);
      if (key) pressedMainKeys.delete(key);
      if (pressedCodes.size > 0) return;
      if (capturedTokens.length !== 3 || !hasMainKey(capturedTokens)) {
        setError("Hold exactly 3 keys");
        capturedTokens = [];
        setDraftTokens([]);
        return;
      }
      const spec = capturedTokens.join("+");
      done = true;
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      invoke<string>("set_capture_hotkey", { shortcut: spec })
        .then((saved) => {
          hotkeyEditAppliedRef.current = true;
          setHotkey(saved);
          setError(null);
        })
        .catch((err) => {
          setError(typeof err === "string" ? err : "Invalid shortcut");
          void invoke("resume_capture_hotkey").catch(console.error);
        })
        .finally(() => {
          setDraftTokens([]);
          setRecording(false);
        });
    };

    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      done = true;
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      void unlistenSuper.then((fn) => fn());
      void invoke("stop_hotkey_recording").catch(console.error);
      if (!hotkeyEditAppliedRef.current) {
        void invoke("resume_capture_hotkey").catch(console.error);
      }
      hotkeyEditAppliedRef.current = false;
    };
  }, [recording]);

  const startRecording = () => {
    setError(null);
    setDraftTokens([]);
    void invoke("suspend_capture_hotkey")
      .catch(console.error)
      .then(() => invoke("start_hotkey_recording"))
      .catch(console.error)
      .finally(() => setRecording(true));
  };

  const factoryReset = async () => {
    const ok = await ask(
      "This clears your shortcut and local preferences (gallery folder, thumbnail colors). Past screenshots stay.",
      { title: "Factory reset?", kind: "warning" },
    );
    if (!ok) return;
    try {
      const restored = await invoke<string>("reset_capture_hotkey");
      setHotkey(restored);
    } catch (err) {
      console.error("reset_capture_hotkey failed", err);
    }
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("liem-capture")) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
    setError(null);
  };

  const displayTokens = recording
    ? draftTokens
    : splitSpec(hotkey);

  return (
    <main className="flex flex-col h-full bg-zinc-950/90 text-white select-none">
      {/* Titlebar drag region */}
      <div
        className="h-8 flex items-center justify-between px-4 shrink-0"
        data-tauri-drag-region
      >
        <span className="text-xs text-white/30 font-medium tracking-widest uppercase">
          Liem Capture
        </span>
        <button
          onClick={() => getCurrentWindow().hide()}
          className="w-5 h-5 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/30 hover:text-white/60 transition-all text-xs"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-7 px-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-2xl bg-white/12 border border-white/12 flex items-center justify-center shadow-lg shadow-black/20">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 7h3M3 12h3M3 17h3M8 4l4 4-4 4M12 4h9M12 9h6M12 14h9M12 19h6"
                stroke="white"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-white text-base font-semibold tracking-tight">
            Liem Capture
          </h1>
          <p className="text-white/30 text-xs">Capture. Drag. Done.</p>
        </div>

        {/* Shortcut editor */}
        <div className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] p-4">
          <p className="text-white/40 text-[11px] uppercase tracking-widest mb-3 text-center">
            Capture Shortcut
          </p>
          <div className="flex items-center gap-2">
            <div className={`min-h-10 flex-1 rounded-lg border px-3 py-2 flex flex-wrap items-center justify-center gap-1.5 ${
              recording ? "border-blue-300/30 bg-blue-400/[0.07]" : "border-white/[0.08] bg-black/20"
            }`}>
            {recording && displayTokens.length === 0 ? (
                <span className="text-white/30 text-xs">Hold keys...</span>
            ) : (
              displayTokens.map((token, i) => (
                <kbd
                  key={`${token}-${i}`}
                  className="px-2.5 py-1.5 rounded-md bg-white/[0.07] text-white/70 text-xs font-mono border border-white/[0.08] shadow-sm"
                >
                  {prettyKey(token)}
                </kbd>
              ))
            )}
            </div>
            <button
              type="button"
              onClick={startRecording}
              disabled={recording}
              className="h-10 px-3 rounded-lg border border-white/[0.10] bg-white/[0.06] hover:bg-white/[0.10] text-white/80 text-xs font-semibold transition-colors disabled:opacity-60"
            >
              Edit
            </button>
          </div>
          {recording && (
            <p className="mt-3 text-center text-white/35 text-xs">
              Hold exactly 3 keys. The shortcut applies automatically.
            </p>
          )}
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 -mt-1">
          {recording ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-sm shadow-blue-400/50 animate-pulse" />
              <span className="text-white/40 text-xs">Editing…</span>
            </>
          ) : error ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-sm shadow-red-400/50" />
              <span className="text-red-300/80 text-xs">{error}</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
              <span className="text-white/30 text-xs">Listening for shortcuts</span>
            </>
          )}
        </div>
      </div>

      <div className="pb-4 flex items-center justify-between px-4">
        <button
          type="button"
          onClick={factoryReset}
          className="text-white/25 hover:text-white/60 text-[10px] tracking-wide transition-colors"
        >
          Reset to defaults
        </button>
        <span className="text-white/15 text-[10px]">v0.1.0</span>
      </div>
    </main>
  );
}
