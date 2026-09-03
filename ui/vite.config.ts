import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://localhost:4177";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      ["/events", "/run", "/permission", "/answer", "/interrupt", "/missiondoc", "/browse", "/status"]
        .map((p) => [p, { target: api, changeOrigin: true }]),
    ),
  },
  build: { outDir: "dist" },
});
