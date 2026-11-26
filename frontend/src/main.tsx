import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { MotionPreferences } from "./MotionPreferences";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionPreferences>
      <App />
    </MotionPreferences>
  </StrictMode>,
);
