
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";

const WORKER_ID = `worker-${randomUUID()}`;
const LEASE_SECONDS = 30;

export async function claimJob() {
  const result = await pool.query(
    `WITH next_job AS (
       SELECT id
       FROM jobs
       WHERE status = 'queued'
         AND run_at <= NOW()
       ORDER BY priority DESC, run_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE jobs AS j
     SET status = 'running',
         locked_by = $1,
         locked_until = NOW() + ($2 * INTERVAL '1 second'),
         attempts = j.attempts + 1,
         started_at = COALESCE(j.started_at, NOW()),
         updated_at = NOW()
     FROM next_job
     WHERE j.id = next_job.id
     RETURNING j.*`,
    [WORKER_ID, LEASE_SECONDS],
  );

  return result.rows[0] ?? null;
}


export async function completeJob(
  jobId: string,
  resultData: unknown,
) {
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'completed',
         result = $3::jsonb,
         completed_at = NOW(),
         updated_at = NOW(),
         locked_by = NULL,
         locked_until = NULL
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND locked_until > NOW()
     RETURNING id, status, result, completed_at`,
    [jobId, WORKER_ID, JSON.stringify(resultData)],
  );

  return result.rows[0] ?? null;
}

export async function failJob(
  jobId: string,
  error: unknown,
) {
  const message =
    error instanceof Error ? error.message : String(error);

  const result = await pool.query(
    `UPDATE jobs
     SET status = CASE
           WHEN attempts >= max_attempts THEN 'dead'
           ELSE 'queued'
         END,
         run_at = CASE
           WHEN attempts >= max_attempts THEN run_at
           ELSE NOW() + (LEAST(POWER(2, attempts), 60) * INTERVAL '1 second')
         END,
         last_error = $3,
         updated_at = NOW(),
         locked_by = NULL,
         locked_until = NULL
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
     RETURNING id, status, attempts, max_attempts, run_at, last_error`,
    [jobId, WORKER_ID, message.slice(0, 4000)],
  );

  return result.rows[0] ?? null;
}



async function executeJob(job: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}) {
  // Temporary handler to prove the worker lifecycle works.
  // We'll replace this with a proper handler registry next.
  switch (job.type) {
    case "email":
      console.log(
        `Simulating email to: ${String(job.payload.to ?? "unknown")}`,
      );

      return {
        accepted: true,
        simulated: true,
        to: job.payload.to ?? null,
      };

    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

const POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startWorker() {
  console.log(`Worker ${WORKER_ID} started`);

  while (true) {
    try {
      const job = await claimJob();

      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`Claimed job ${job.id} (${job.type})`);

      try {
        const result = await executeJob({
          id: job.id,
          type: job.type,
          payload: job.payload,
        });

        const completed = await completeJob(job.id, result);

        if (!completed) {
          console.warn(
            `Could not complete job ${job.id}: lease expired or ownership changed`,
          );
        } else {
          console.log(`Completed job ${job.id}`);
        }
      } catch (error) {
        const failed = await failJob(job.id, error);

        if (failed) {
          console.error(
            `Job ${job.id} failed; status=${failed.status}`,
          );
        } else {
          console.warn(`Could not record failure for job ${job.id}`);
        }
      }
    } catch (error) {
      console.error("Worker loop error:", error);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}
