import { getCurrentWindow } from "@tauri-apps/api/window";

export default function Settings() {
  return (
    <main className="flex flex-col h-full bg-zinc-950/90 text-white select-none">
      {/* Titlebar drag region */}
      <div
        className="h-8 flex items-center justify-between px-4 shrink-0"
        data-tauri-drag-region
      >
        <span className="text-xs text-white/30 font-medium tracking-widest uppercase">
          Liem Shot
        </span>
        <button
          onClick={() => getCurrentWindow().hide()}
          className="w-5 h-5 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/30 hover:text-white/60 transition-all text-xs"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6">
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
            Liem Shot
          </h1>
          <p className="text-white/30 text-xs">Capture. Drag. Done.</p>
        </div>

        {/* Shortcut display */}
        <div className="w-full rounded-xl border border-white/[0.07] bg-white/[0.04] p-4">
          <p className="text-white/40 text-[11px] uppercase tracking-widest mb-3 text-center">
            Capture Shortcut
          </p>
          <div className="flex items-center justify-center gap-1.5">
            {["Ctrl", "Shift", "2"].map((key) => (
              <kbd
                key={key}
                className="px-2.5 py-1.5 rounded-md bg-white/[0.07] text-white/70 text-xs font-mono border border-white/[0.08] shadow-sm"
              >
                {key}
              </kbd>
            ))}
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
          <span className="text-white/30 text-xs">Listening for shortcuts</span>
        </div>
      </div>

      <div className="pb-4 flex justify-center">
        <span className="text-white/15 text-[10px]">v0.1.0</span>
      </div>
    </main>
  );
}
