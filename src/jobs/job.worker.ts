
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { renewLeaseSafely } from "./job.heartbeat.js";
import { executeJob } from "./job.handlers.js";

const WORKER_ID = `worker-${randomUUID()}`;
const LEASE_SECONDS = 30;
const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

type LeaseStatus = "valid" | "lost" | "uncertain";

type Job = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

type JobProcessingOutcome =
  | { ok: true; result: unknown; leaseStatus: LeaseStatus }
  | { ok: false; error: unknown; leaseStatus: LeaseStatus };

let stopRequested = false;
let wakePoller: (() => void) | null = null;
let workerPromise: Promise<void> | null = null;


export function stopWorker(): Promise<void> {
  if (!workerPromise) {
    stopRequested = true;
    return Promise.resolve();
  }

  stopRequested = true;
  wakePoller?.();

  return workerPromise;
}


const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    let wake!: () => void;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (wakePoller === wake) {
        wakePoller = null;
      }

      resolve();
    };

    const timer = setTimeout(finish, ms);
    wake = finish;
    wakePoller = wake;
  });

export async function claimJob(workerId: string = WORKER_ID) {
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
    [workerId, LEASE_SECONDS],
  );

  return result.rows[0] ?? null;
}

export async function renewJobLease(
  jobId: string,
  workerId: string = WORKER_ID,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs
     SET locked_until = NOW() + ($3 * INTERVAL '1 second'),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND locked_until > NOW()
     RETURNING id`,
    [jobId, workerId, LEASE_SECONDS],
  );

  return result.rowCount === 1;
}

/**
 * Release a claim only while this worker owns a valid lease.
 * Used when shutdown occurs before the handler starts.
 */
export async function releaseClaimedJob(
  jobId: string,
  workerId: string = WORKER_ID,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs
     SET status = 'queued',
         run_at = NOW(),
         locked_by = NULL,
         locked_until = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'running'
       AND locked_by = $2
       AND locked_until > NOW()
     RETURNING id`,
    [jobId, workerId],
  );

  return result.rowCount === 1;
}

export async function recoverExpiredJobs() {
  const result = await pool.query(
    `UPDATE jobs
     SET status = CASE
           WHEN attempts >= max_attempts THEN 'dead'
           ELSE 'queued'
         END,
         run_at = CASE
           WHEN attempts >= max_attempts THEN run_at
           ELSE NOW() +
             (LEAST(POWER(2, attempts), 60) * INTERVAL '1 second')
         END,
         last_error = 'Worker lease expired; job recovered',
         locked_by = NULL,
         locked_until = NULL,
         updated_at = NOW()
     WHERE status = 'running'
       AND locked_until <= NOW()
     RETURNING id, status, attempts`,
  );

  for (const job of result.rows) {
    console.warn(`Recovered expired job ${job.id}; status=${job.status}`);
  }

  return result.rowCount ?? 0;
}

export async function completeJob(
  jobId: string,
  resultData: unknown,
  workerId: string = WORKER_ID,
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
    [jobId, workerId, JSON.stringify(resultData)],
  );

  return result.rows[0] ?? null;
}

export async function failJob(
  jobId: string,
  error: unknown,
  workerId: string = WORKER_ID,
) {
  const message = error instanceof Error ? error.message : String(error);

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
       AND locked_until > NOW()
     RETURNING id, status, attempts, max_attempts, run_at, last_error`,
    [jobId, workerId, message.slice(0, 4000)],
  );

  return result.rows[0] ?? null;
}

async function processJobWithHeartbeat(
  job: Job,
): Promise<JobProcessingOutcome> {
  let leaseStatus: LeaseStatus = "valid";
  let heartbeatBusy = false;

  const heartbeat = setInterval(() => {
    if (heartbeatBusy || leaseStatus !== "valid") return;

    heartbeatBusy = true;

    void renewLeaseSafely(() => renewJobLease(job.id))
      .then((outcome) => {
        if (outcome.status === "lease-lost") {
          leaseStatus = "lost";
          console.error(`Lease lost for job ${job.id}`);
        } else if (outcome.status === "uncertain") {
          leaseStatus = "uncertain";
          console.error(
            `Lease renewal uncertain for job ${job.id}:`,
            outcome.error,
          );
        }
      })
      .catch((error: unknown) => {
        leaseStatus = "uncertain";
        console.error(`Heartbeat failed for job ${job.id}:`, error);
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref();

  let outcome:
    | { ok: true; result: unknown }
    | { ok: false; error: unknown };

  try {
    outcome = {
      ok: true,
      result: await executeJob(job, {
        idempotencyKey: `queueforge:${job.id}`,
      }),
    };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  } finally {
    clearInterval(heartbeat);

    while (heartbeatBusy) {
      await sleep(50);
    }
  }

  return { ...outcome, leaseStatus };
}

async function runWorkerLoop(): Promise<void> {
  console.log(`Worker ${WORKER_ID} started`);

  while (!stopRequested) {
    try {
      await recoverExpiredJobs();

      if (stopRequested) break;

      const job = await claimJob();

      if (stopRequested) {
        if (job) {
          try {
            const released = await releaseClaimedJob(job.id);

            if (released) {
              console.log(`Released job ${job.id} during shutdown`);
            } else {
              console.warn(
                `Could not release job ${job.id}; lease may have expired or ownership changed`,
              );
            }
          } catch (error) {
            console.error(
              `Failed to release job ${job.id} during shutdown; lease recovery may be required:`,
              error,
            );
          }
        }

        break;
      }

      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`Claimed job ${job.id} (${job.type})`);

      const processed = await processJobWithHeartbeat({
        id: job.id,
        type: job.type,
        payload: job.payload,
      });

      if (processed.leaseStatus !== "valid") {
        console.warn(
          `Skipping state update for job ${job.id}: lease ${processed.leaseStatus}`,
        );
        continue;
      }

      if (!processed.ok) {
        const failed = await failJob(job.id, processed.error);

        if (failed) {
          console.error(`Job ${job.id} failed; status=${failed.status}`);
        } else {
          console.warn(`Could not record failure for job ${job.id}`);
        }

        continue;
      }

      const completed = await completeJob(job.id, processed.result);

      if (!completed) {
        console.warn(
          `Could not complete job ${job.id}: lease expired or ownership changed`,
        );
      } else {
        console.log(`Completed job ${job.id}`);
      }
    } catch (error) {
      console.error("Worker loop error:", error);

      if (!stopRequested) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  console.log("Worker loop stopped.");
}

/**
 * Multiple callers share the same promise while a worker is running.
 * After it stops, a later call can start a new worker loop.
 */
export function startWorker(): Promise<void> {
  if (workerPromise) {
    return workerPromise;
  }

  stopRequested = false;

  const runPromise = runWorkerLoop();
  let trackedPromise: Promise<void>;

  trackedPromise = runPromise.finally(() => {
    if (workerPromise === trackedPromise) {
      workerPromise = null;
    }
  });

  workerPromise = trackedPromise;

  return trackedPromise;
}
