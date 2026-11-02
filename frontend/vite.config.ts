import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Backend dev server (backend/.env PORT, default 4000). Only used when VITE_USE_MOCKS=false.
const backendTarget = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:4000";

const contractsDir = fileURLToPath(new URL("../contracts", import.meta.url));
const frontendDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [frontendDir, contractsDir] },
    proxy: { "/api": { target: backendTarget, changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
