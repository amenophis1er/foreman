import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://localhost:4177";
export default defineConfig({
  plugins: [react()],
  server: {
    // Every route the API server owns. A path missing here is served by Vite
    // as the SPA index instead, which fails as an unexplained JSON parse error
    // in the dashboard — so this list must match src/server.ts, not a subset
    // of it. Prefix matching means "/run" also covers "/runs/<id>/events".
    proxy: Object.fromEntries(
      [
        "/answer", "/browse", "/chat", "/events", "/instances", "/interrupt", "/locate",
        "/missiondoc", "/mkdir", "/models", "/permission", "/projects", "/run",
        "/runs", "/settings", "/steer",
      ].map((p) => [p, { target: api, changeOrigin: true }]),
    ),
  },
  build: { outDir: "dist" },
});
