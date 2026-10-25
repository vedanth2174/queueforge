import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { claimJob } from "../src/jobs/job.worker.js";

afterAll(async () => {
  await pool.end();
});

describe("Concurrent job claiming", () => {
  it("allows only one concurrent claim for a single queued job", async () => {
    const idempotencyKey = `concurrency-test-${randomUUID()}`;
    let jobId: string | undefined;

    try {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO jobs (
         type, payload, status, priority, max_attempts,
         idempotency_key, run_at
       )
       VALUES (
         'email',
         '{"to":"concurrency-test@example.com"}'::jsonb,
         'queued',
         10,
         3,
         $1,
         NOW() - INTERVAL '1 hour'
       )
       RETURNING id`,
        [idempotencyKey],
      );

      jobId = inserted.rows[0].id;

      // Make this test job the only eligible queued job.
      await pool.query(
        `UPDATE jobs
       SET status = 'cancelled', updated_at = NOW()
       WHERE status = 'queued' AND id <> $1`,
        [jobId],
      );

      const claims = await Promise.all([claimJob(), claimJob()]);

      const claimedIds = claims
        .filter((job) => job !== null && job.id === jobId)
        .map((job) => job!.id);

      expect(claimedIds).toHaveLength(1);

      const stored = await pool.query(
        `SELECT status, locked_by, locked_until
       FROM jobs
       WHERE id = $1`,
        [jobId],
      );

      expect(stored.rows[0].status).toBe("running");
      expect(stored.rows[0].locked_by).toBeTruthy();
      expect(stored.rows[0].locked_until).toBeTruthy();
    } finally {
      if (jobId) {
        await pool.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
      }
    }
  });
});
