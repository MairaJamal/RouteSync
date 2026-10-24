import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // NOTE: tsc (npm run build) already outputs the backend/test bundle to
  // ./dist. Vite defaulted to the same folder, so `vite build` was silently
  // deleting dist/test.js, dist/test_day4.js, dist/test_pooling.js, etc.
  // right before `npm test` ran them. Frontend build now goes to its own
  // folder so the two build steps never clobber each other.
  build: {
    outDir: "dist-web",
  },
  server: {
    port: 3000,
    strictPort: true,
    open: false,
    proxy: {
      // Forwards frontend calls to /api/* to the Express server started by
      // `npm run server` (src/server.ts), so the browser can just call
      // relative paths in dev without a CORS dance.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
