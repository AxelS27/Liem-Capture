import { Component, ReactNode, ErrorInfo } from "react";
import { Routes, Route } from "react-router-dom";
import Settings from "./pages/Settings";
import Overlay from "./pages/Overlay";
import "./App.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Unhandled component render error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-zinc-950 text-white p-6 select-none">
          <div className="max-w-md w-full rounded-xl border border-red-500/30 bg-red-950/20 p-5 text-center shadow-lg">
            <h2 className="text-lg font-semibold text-red-400 mb-2">Something went wrong</h2>
            <p className="text-xs text-white/70 mb-4 break-words font-mono bg-black/40 p-2.5 rounded border border-white/10 text-left overflow-auto max-h-32">
              {this.state.error?.message || "An unexpected rendering error occurred."}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 text-white transition-colors"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Settings />} />
        <Route path="/overlay" element={<Overlay />} />
      </Routes>
    </ErrorBoundary>
  );
}
