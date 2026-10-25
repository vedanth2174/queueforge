
import "dotenv/config";
import express from "express";
import { pool } from "./db/pool.js";
import { jobRouter } from "./jobs/job.routes.js";
import type { ErrorRequestHandler } from "express";

export const app = express();

app.use(express.json());

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

const errorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next,
) => {
  const candidate = error as {
    status?: number;
    type?: string;
  };

  if (
    error instanceof SyntaxError &&
    candidate.status === 400 &&
    candidate.type === "entity.parse.failed"
  ) {
    return res.status(400).json({
      error: "Malformed JSON request",
    });
  }

  console.error("Unhandled API error:", error);

  return res.status(500).json({
    error: "Internal server error",
  });
};


app.use(errorHandler);

app.use("/api/v1/jobs", jobRouter);
