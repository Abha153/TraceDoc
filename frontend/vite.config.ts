import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const contractsDir = fileURLToPath(new URL("../contracts", import.meta.url));
const frontendDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [frontendDir, contractsDir] },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
