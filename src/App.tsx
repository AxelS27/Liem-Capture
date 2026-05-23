import { Routes, Route } from "react-router-dom";
import Settings from "./pages/Settings";
import Overlay from "./pages/Overlay";
import Thumbnail from "./pages/Thumbnail";
import "./App.css";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Settings />} />
      <Route path="/overlay" element={<Overlay />} />
      <Route path="/thumbnail" element={<Thumbnail />} />
    </Routes>
  );
}
