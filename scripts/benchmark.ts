
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pool } from "../src/db/pool.js";
import { claimJob, completeJob } from "../src/jobs/job.worker.js";

const confirmation = process.env.QUEUEFORGE_BENCHMARK_CONFIRM;
const jobsArg = process.argv.find((arg) => arg.startsWith("--jobs="));
const workersArg = process.argv.find((arg) => arg.startsWith("--workers="));

const jobCount = Number(jobsArg?.split("=")[1] ?? 100);
const workerCount = Number(workersArg?.split("=")[1] ?? 1);

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil((p / 100) * sorted.length) - 1].toFixed(2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (confirmation !== "YES") {
    throw new Error("Set QUEUEFORGE_BENCHMARK_CONFIRM=YES to proceed.");
  }

  if (process.env.DB_NAME !== "queueforge_benchmark") {
    throw new Error("DB_NAME must be queueforge_benchmark.");
  }

  if (!Number.isInteger(jobCount) || jobCount < 1 || jobCount > 1000) {
    throw new Error("--jobs must be between 1 and 1000.");
  }

  if (![1, 2, 4, 8].includes(workerCount)) {
    throw new Error("--workers must be 1, 2, 4, or 8.");
  }

  const db = await pool.query<{ current_database: string }>(
    "SELECT current_database()",
  );

  if (db.rows[0]?.current_database !== "queueforge_benchmark") {
    throw new Error("Connected to the wrong database.");
  }

  const active = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM jobs WHERE status IN ('queued', 'running')",
  );

  if (Number(active.rows[0]?.count ?? "0") !== 0) {
    throw new Error("Benchmark database must have no queued or running jobs.");
  }

  const runId = randomUUID();
  const ids: string[] = [];
  const insertedAt = new Map<string, number>();
  const queueWaitFromEnqueueMs: number[] = [];
  const queueWaitFromProcessingStartMs: number[] = [];
  const processingMs: number[] = [];

  let completedCount = 0;
  let failure: unknown = null;

  const runStartedAt = new Date().toISOString();
  const insertionStart = performance.now();

  try {
    // Insert benchmark jobs individually, as in the original baseline.
    for (let i = 0; i < jobCount; i++) {
      const id = randomUUID();
      ids.push(id);

      await pool.query(
        `INSERT INTO jobs
          (id, type, payload, status, priority, attempts, max_attempts, run_at)
         VALUES ($1, 'benchmark.noop', $2::jsonb, 'queued', 2147483647, 0, 1, NOW())`,
        [id, JSON.stringify({ benchmarkRunId: runId, index: i })],
      );

      insertedAt.set(id, performance.now());
    }

    const insertionEnd = performance.now();
    const processingStart = performance.now();
    const processingStartedAt = new Date().toISOString();

    // Poll less frequently when the queue is temporarily empty.
    async function consume(workerIndex: number): Promise<void> {
      const workerId = `bench-${runId}-${workerIndex}`;

      while (!failure) {
        try {
          const job = await claimJob(workerId);

          if (!job) {
            // No benchmark job was claimed. Check only benchmark records.
            const remaining = await pool.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count
               FROM jobs
               WHERE id = ANY($1::uuid[])
                 AND status IN ('queued', 'running')`,
              [ids],
            );

            if (Number(remaining.rows[0]?.count ?? "0") === 0) {
              return;
            }

            await sleep(25);
            continue;
          }

          if (!insertedAt.has(job.id)) {
            throw new Error(
              `Claimed unrelated job ${job.id}; stopping benchmark.`,
            );
          }

          const claimedAt = performance.now();
          const claimedAtWallClock = Date.now();

          queueWaitFromEnqueueMs.push(
            claimedAt - insertedAt.get(job.id)!,
          );

          queueWaitFromProcessingStartMs.push(
            claimedAt - processingStart,
          );

          const completion = await completeJob(
            job.id,
            { benchmark: true, benchmarkRunId: runId },
            workerId,
          );

          if (!completion) {
            throw new Error(`Failed to complete benchmark job ${job.id}.`);
          }

          processingMs.push(Date.now() - claimedAtWallClock);
          completedCount++;
        } catch (error) {
          failure = error;
          return;
        }
      }
    }

    await Promise.all(
      Array.from({ length: workerCount }, (_, i) => consume(i)),
    );

    if (failure) throw failure;

    if (completedCount !== jobCount) {
      throw new Error(
        `Expected ${jobCount} completions; got ${completedCount}.`,
      );
    }

    const processingEnd = performance.now();
    const durationMs = processingEnd - processingStart;

    const result = {
      runId,
      startedAt: runStartedAt,
      processingStartedAt,
      finishedAt: new Date().toISOString(),
      database: db.rows[0].current_database,
      jobs: jobCount,
      workers: workerCount,
      completed: completedCount,
      insertionDurationMs: Number((insertionEnd - insertionStart).toFixed(2)),
      processingDurationMs: Number(durationMs.toFixed(2)),
      throughputJobsPerSecond: Number(
        (completedCount / (durationMs / 1000)).toFixed(2),
      ),
      queueWaitFromEnqueueMs: {
        p50: percentile(queueWaitFromEnqueueMs, 50),
        p95: percentile(queueWaitFromEnqueueMs, 95),
        p99: percentile(queueWaitFromEnqueueMs, 99),
      },
      queueWaitFromProcessingStartMs: {
        p50: percentile(queueWaitFromProcessingStartMs, 50),
        p95: percentile(queueWaitFromProcessingStartMs, 95),
        p99: percentile(queueWaitFromProcessingStartMs, 99),
      },
      processingMs: {
        p50: percentile(processingMs, 50),
        p95: percentile(processingMs, 95),
        p99: percentile(processingMs, 99),
      },
    };

    const outputDir = path.resolve("benchmarks", "results");
    await mkdir(outputDir, { recursive: true });

    const outputPath = path.join(
      outputDir,
      `benchmark-${workerCount}w-${jobCount}j-${runId}.json`,
    );

    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

    console.log(JSON.stringify(result, null, 2));
    console.log(`Saved results to ${outputPath}`);
  } finally {
    if (ids.length) {
      await pool.query("DELETE FROM jobs WHERE id = ANY($1::uuid[])", [ids]);
    }

    await pool.end();
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
