import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { matchesRouter } from "./apiHandler";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
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

const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] RouteSync API listening on http://localhost:${port}`);
});

export default app;
