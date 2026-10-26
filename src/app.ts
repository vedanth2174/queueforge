
import "dotenv/config";
import express from "express";
import { pool } from "./db/pool.js";
import { jobRouter } from "./jobs/job.routes.js";
import { apiErrorHandler } from "./middleware/errorHandler.js";
import cors from "cors";

export const app = express();
const allowedOrigins = (
  process.env.CORS_ORIGINS ??
  "http://localhost:8443,http://127.0.0.1:8443"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow command-line clients such as curl, which send no Origin.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Origin not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Idempotency-Key"],
  }),
);

// Render terminates TLS at one trusted proxy. Set TRUST_PROXY=1 only when
// running behind that trusted proxy so rate limiting uses the client IP.
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(express.json({ limit: "256kb" }));

app.get("/health/live", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "queueforge",
  });
});

app.get("/health/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "ready",
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "not_ready",
      database: "unavailable",
    });
  }
});


app.get("/metrics", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM jobs
       GROUP BY status`,
    );

    const counts: Record<string, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      cancelled: 0,
    };

    for (const row of result.rows) {
      counts[row.status] = row.count;
    }

    return res.status(200).json({
      service: "queueforge",
      jobs: counts,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to collect job metrics:", error);

    return res.status(500).json({
      error: "Failed to collect metrics",
    });
  }
});

app.use("/api/v1/jobs", jobRouter);

// Keep the error handler after every route and body-parsing middleware.
app.use(apiErrorHandler);
