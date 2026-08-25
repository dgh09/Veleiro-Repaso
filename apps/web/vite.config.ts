import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = "http://localhost:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxying keeps every browser request same-origin, so the API never needs
    // CORS middleware - in this phase or any later one.
    proxy: {
      "/health": { target: API_TARGET, changeOrigin: true },
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
