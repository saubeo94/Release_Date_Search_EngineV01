import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // local dev has no serverless runtime — proxy /api to production
    proxy: {
      "/api": {
        target: "https://release-date-checker.vercel.app",
        changeOrigin: true,
      },
    },
  },
});
