
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

  if (idempotencyKey !== null) {
    if (
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > 255
    ) {
      return res.status(400).json({
        error:
          "Idempotency-Key must be non-empty and not exceed 255 characters",
      });
    }
  }

  // Store the validated request, not the job's mutable execution state.
  const idempotencyRequest = {
    type: input.type,
    payload: input.payload,
    priority: input.priority,
    maxAttempts: input.maxAttempts,
    runAt: input.runAt ?? null,
  };

  try {
    const result = await pool.query(
      `INSERT INTO jobs
         (
           type,
           payload,
           priority,
           max_attempts,
           run_at,
           idempotency_key,
           idempotency_request
         )
       VALUES (
         $1,
         $2::jsonb,
         $3,
         $4,
         COALESCE($5::timestamptz, NOW()),
         $6,
         $7::jsonb
       )
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
        JSON.stringify(idempotencyRequest),
      ],
    );

    if (result.rowCount === 1) {
      return res.status(201).json({
        job: result.rows[0],
        deduplicated: false,
      });
    }

    if (idempotencyKey === null) {
      throw new Error("Unexpected empty insert result");
    }

    const existing = await pool.query(
      `SELECT
         id,
         type,
         payload,
         status,
         priority,
         attempts,
         max_attempts,
         run_at,
         created_at,
         idempotency_request = $2::jsonb AS same_request
       FROM jobs
       WHERE idempotency_key = $1`,
      [idempotencyKey, JSON.stringify(idempotencyRequest)],
    );

    if (existing.rowCount !== 1) {
      return res.status(503).json({
        error: "Could not resolve idempotent submission; retry safely",
      });
    }

    const job = existing.rows[0];

    // Older rows created before migration 002 cannot be compared reliably:
    // their original request, especially an omitted runAt, is not recoverable.
    if (job.same_request === null) {
      return res.status(409).json({
        error:
          "This idempotency key belongs to a legacy job without a stored request fingerprint. Use a new key.",
      });
    }

    if (job.same_request !== true) {
      return res.status(409).json({
        error: "Idempotency-Key was already used for a different job",
      });
    }

    return res.status(200).json({
      job: {
        id: job.id,
        type: job.type,
        payload: job.payload,
        status: job.status,
        priority: job.priority,
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        run_at: job.run_at,
        created_at: job.created_at,
      },
      deduplicated: true,
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
