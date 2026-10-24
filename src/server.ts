import "dotenv/config";
import express from "express";
import { pool } from "./db/pool.js";
import { jobRouter } from "./jobs/job.routes.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use("/api/v1/jobs", jobRouter);

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

app.listen(PORT, () => {
  console.log(`QueueForge running on http://localhost:${PORT}`);
});