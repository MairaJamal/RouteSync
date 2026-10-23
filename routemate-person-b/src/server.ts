import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { matchesRouter } from "./apiHandler";

const app = express();

app.use(cors());
app.use(express.json());

app.get(["/health", "/api/health"], (_req, res) => {
  res.json({ status: "ok" });
});

// Generous default: 2000 requests / 15 min per IP in dev so continuous polling
// (notifications, consents, chats) doesn't prematurely throttle localhost.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: process.env.NODE_ENV === "production" ? 200 : 2000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(matchesRouter);

// In production the Express container serves the Vite build and the API from
// one origin. The Vite dev server remains responsible for local development.
const webRoot = path.resolve(__dirname, "../dist-web");
app.use(express.static(webRoot));
app.get(/^(?!\/api(?:\/|$)|\/health$).*/, (_req, res) => {
  res.sendFile(path.join(webRoot, "index.html"));
});

// Vercel imports this module as a serverless function. Keep the listener for
// local development, but never start a long-lived socket in that environment.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] RouteSync API listening on http://localhost:${port}`);
  });
}

export default app;
