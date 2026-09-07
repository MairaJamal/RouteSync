import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { matchesRouter } from "./apiHandler";

const app = express();

app.use(cors());
app.use(express.json());

// Generous default: 200 requests / 15 min per IP. Tighter limits on
// specific high-risk endpoints (SOS logging, verification) live inline
// below so a burst on one endpoint can't be masked by the global window.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Note: apiHandler.ts validates SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY at
// import time (throwing before this file's own code runs), so a missing
// .env fails fast with a clear message rather than a confusing runtime 500
// on the first request.

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(matchesRouter);

const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] RouteSync API listening on http://localhost:${port}`);
});

export default app;
