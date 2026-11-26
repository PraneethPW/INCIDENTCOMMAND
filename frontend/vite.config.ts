import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:8787" },
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:8787" },
  },
});
