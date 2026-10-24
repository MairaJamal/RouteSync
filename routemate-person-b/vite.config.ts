import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The frontend dev server runs on its own dedicated port (Vite's default 5173)
// so it no longer collides with the backend / any other service on 3000. The
// Express API (src/server.ts) listens on PORT (default 3001); we read the SAME
// PORT value here so the proxy target can never drift out of sync with the
// backend. That drift — /api/* being forwarded to a port nothing was listening
// on — is what produced the browser's "Failed to fetch" errors.
export default defineConfig(({ mode }) => {
  // prefix "" loads every var from .env (including the non-VITE PORT the
  // backend uses), not just VITE_*-prefixed ones.
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.PORT || "3001";
  const proxyTarget = `http://localhost:${backendPort}`;

  return {
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
      port: 5173,
      strictPort: true,
      open: false,
      proxy: {
        // Forwards frontend calls to /api/* to the Express server started by
        // `npm run server` (src/server.ts), so the browser can just call
        // relative paths in dev without a CORS dance.
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
        },
        "/health": {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
