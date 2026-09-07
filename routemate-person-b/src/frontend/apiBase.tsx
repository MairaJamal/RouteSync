/* Shared backend base URL for Day 7 frontend components.

   This is a .tsx file on purpose: the backend tsconfig compiles only
   plain .ts sources with module=commonjs, which rejects import.meta.
   Vite bundles the frontend, so env access is safe here (same pattern
   App.tsx uses). Falls back to same-origin — the Vite dev proxy
   forwards /api/* to the Express server. */
export const API_URL: string = (import.meta as any).env?.VITE_API_URL ?? "";
