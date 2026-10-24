
import { Router } from "express";
import { pool } from "../db/pool.js";
import { createJobSchema } from "./job.schema.js";

export const jobRouter = Router();

jobRouter.post("/", async (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid job data",
      details: parsed.error.issues,
    });
  }

  const input = parsed.data;
  const idempotencyKey = req.get("Idempotency-Key") ?? null;

  if (idempotencyKey !== null && idempotencyKey.length > 255) {
    return res.status(400).json({
      error: "Idempotency-Key must not exceed 255 characters",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO jobs (type, payload, priority, max_attempts, run_at, idempotency_key)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, type, payload, status, priority, attempts,
                 max_attempts, run_at, created_at`,
      [
        input.type,
        JSON.stringify(input.payload),
        input.priority,
        input.maxAttempts,
        input.runAt ?? null,
        idempotencyKey,
      ],
    );

    if (result.rowCount === 0) {
      if (idempotencyKey === null) {
        throw new Error("Unexpected empty insert result");
      }

      const existing = await pool.query(
        `SELECT id, type, payload, status, priority, attempts,
                max_attempts, run_at, created_at
         FROM jobs
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      );

      if (existing.rowCount === 0) {
        return res.status(503).json({
          error: "Could not resolve idempotent submission; retry safely",
        });
      }

      return res.status(200).json({
        job: existing.rows[0],
        deduplicated: true,
      });
    }

    return res.status(201).json({
      job: result.rows[0],
      deduplicated: false,
    });
  } catch (error) {
    console.error("Failed to create job:", error);

    return res.status(500).json({
      error: "Failed to create job",
    });
  }
});


jobRouter.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, type, payload, status, priority,
              attempts, max_attempts, run_at,
              result, last_error, created_at,
              updated_at, started_at, completed_at
       FROM jobs
       WHERE id = $1`,
      [id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Job not found",
      });
    }

    return res.status(200).json({
      job: result.rows[0],
    });
  } catch (error) {
    console.error("Failed to retrieve job:", error);

    return res.status(500).json({
      error: "Failed to retrieve job",
    });
  }
});

