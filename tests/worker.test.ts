
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db/pool.js";
import {
  claimJob,
  failJob,
  renewJobLease,
  releaseClaimedJob,
} from "../src/jobs/job.worker.js";

const TEST_WORKER_ID = `test-worker-${randomUUID()}`;

afterAll(async () => {
  await pool.end();
});

async function insertQueuedJob(prefix: string): Promise<string> {
  const key = `${prefix}-${randomUUID()}`;

  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs (
       type, payload, status, priority, max_attempts,
       idempotency_key, run_at
     )
     VALUES (
       'email',
       '{"to":"worker-test@example.com"}'::jsonb,
       'queued',
       10,
       3,
       $1,
       NOW() - INTERVAL '1 hour'
     )
     RETURNING id`,
    [key],
  );

  return result.rows[0].id;
}

async function claimSpecificTestJob(jobId: string, workerId: string) {
  const result = await pool.query(
    `WITH target_job AS (
       SELECT id
       FROM jobs
       WHERE id = $1
         AND status = 'queued'
         AND run_at <= NOW()
       FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs AS j
     SET status = 'running',
         locked_by = $2,
         locked_until = NOW() + INTERVAL '30 seconds',
         attempts = j.attempts + 1,
         started_at = COALESCE(j.started_at, NOW()),
         updated_at = NOW()
     FROM target_job
     WHERE j.id = target_job.id
     RETURNING j.*`,
    [jobId, workerId],
  );

  return result.rows[0] ?? null;
}

describe("Concurrent job claiming", () => {
  it("allows only one concurrent claim for a single queued job", async () => {
    const jobId = await insertQueuedJob("concurrency-test");

    try {
      const workerA = `worker-a-${randomUUID()}`;
      const workerB = `worker-b-${randomUUID()}`;

      const claims = await Promise.all([
        claimSpecificTestJob(jobId, workerA),
        claimSpecificTestJob(jobId, workerB),
      ]);

      const claimsForTestJob = claims.filter(
        (job) => job?.id === jobId,
      );

      expect(claimsForTestJob).toHaveLength(1);

      const stored = await pool.query<{
        status: string;
        locked_by: string | null;
        locked_until: Date | null;
      }>(
        `SELECT status, locked_by, locked_until
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      expect(stored.rows[0].status).toBe("running");
      expect([workerA, workerB]).toContain(stored.rows[0].locked_by);
      expect(stored.rows[0].locked_until).toBeTruthy();
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });

  it("does not let the production claim function claim the same job twice", async () => {
    const jobId = await insertQueuedJob("production-claim-test");

    try {
      const claims = await Promise.all([
        claimJob(`production-worker-a-${randomUUID()}`),
        claimJob(`production-worker-b-${randomUUID()}`),
      ]);

      const claimsForTestJob = claims.filter(
        (job) => job?.id === jobId,
      );

      // The production function may claim other eligible jobs, but it
      // must not return the same target job to two workers.
      expect(claimsForTestJob.length).toBeLessThanOrEqual(1);

      const stored = await pool.query<{ status: string; locked_by: string | null }>(
        `SELECT status, locked_by
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      if (claimsForTestJob.length === 1) {
        expect(stored.rows[0].status).toBe("running");
        expect(stored.rows[0].locked_by).toBeTruthy();
      } else {
        // Another eligible job may have been selected first.
        expect(["queued", "running"]).toContain(stored.rows[0].status);
      }
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });
});

describe("Worker lease renewal and failure handling", () => {
  async function createClaimedJob() {
    const jobId = await insertQueuedJob("lease-test");

    try {
      const claimed = await claimSpecificTestJob(jobId, TEST_WORKER_ID);

      if (!claimed || claimed.id !== jobId) {
        throw new Error("Could not claim the test job.");
      }

      return claimed;
    } catch (error) {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
      throw error;
    }
  }

  it("renews an active lease", async () => {
    const job = await createClaimedJob();

    try {
      const before = await pool.query<{ locked_until: Date }>(
        `SELECT locked_until FROM jobs WHERE id = $1`,
        [job.id],
      );

      expect(await renewJobLease(job.id, TEST_WORKER_ID)).toBe(true);

      const after = await pool.query<{ locked_until: Date }>(
        `SELECT locked_until FROM jobs WHERE id = $1`,
        [job.id],
      );

      expect(
        new Date(after.rows[0].locked_until).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(before.rows[0].locked_until).getTime(),
      );
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  });

  it("does not renew an expired lease", async () => {
    const job = await createClaimedJob();

    try {
      await pool.query(
        `UPDATE jobs
         SET locked_until = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [job.id],
      );

      await expect(
        renewJobLease(job.id, TEST_WORKER_ID),
      ).resolves.toBe(false);
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  });

  it("does not renew a job owned by another worker", async () => {
    const job = await createClaimedJob();

    try {
      await pool.query(
        `UPDATE jobs
         SET locked_by = 'another-worker'
         WHERE id = $1`,
        [job.id],
      );

      await expect(
        renewJobLease(job.id, TEST_WORKER_ID),
      ).resolves.toBe(false);
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  });

  it("requeues a failed job when attempts remain", async () => {
    const job = await createClaimedJob();

    try {
      const failed = await failJob(
        job.id,
        new Error("Temporary failure"),
        TEST_WORKER_ID,
      );

      expect(failed).not.toBeNull();
      expect(failed.status).toBe("queued");
      expect(failed.attempts).toBeLessThan(failed.max_attempts);
      expect(failed.last_error).toBe("Temporary failure");
      expect(failed.run_at).toBeTruthy();

      const stored = await pool.query<{
        locked_by: string | null;
        locked_until: Date | null;
      }>(
        `SELECT locked_by, locked_until
         FROM jobs
         WHERE id = $1`,
        [job.id],
      );

      expect(stored.rows[0].locked_by).toBeNull();
      expect(stored.rows[0].locked_until).toBeNull();
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  });

  it("marks a failed job dead when attempts are exhausted", async () => {
    const job = await createClaimedJob();

    try {
      await pool.query(
        `UPDATE jobs
         SET attempts = max_attempts
         WHERE id = $1`,
        [job.id],
      );

      const failed = await failJob(
        job.id,
        "Permanent failure",
        TEST_WORKER_ID,
      );

      expect(failed).not.toBeNull();
      expect(failed.status).toBe("dead");
      expect(failed.last_error).toBe("Permanent failure");
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  });

  it("does not fail a job after ownership changes", async () => {
    const job = await createClaimedJob();

    try {
      await pool.query(
        `UPDATE jobs
         SET locked_by = 'another-worker'
         WHERE id = $1`,
        [job.id],
      );

      await expect(
        failJob(
          job.id,
          new Error("Stale worker failure"),
          TEST_WORKER_ID,
        ),
      ).resolves.toBeNull();

      const stored = await pool.query<{
        status: string;
        locked_by: string;
      }>(
        `SELECT status, locked_by
         FROM jobs
         WHERE id = $1`,
        [job.id],
      );

      expect(stored.rows[0].status).toBe("running");
      expect(stored.rows[0].locked_by).toBe("another-worker");
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    }
  });
});

describe("Worker shutdown claim release", () => {
  async function createClaimedJobForRelease() {
    const jobId = await insertQueuedJob("shutdown-release-test");

    try {
      const claimed = await claimSpecificTestJob(jobId, TEST_WORKER_ID);

      if (!claimed || claimed.id !== jobId) {
        throw new Error("Could not claim the shutdown test job.");
      }

      return jobId;
    } catch (error) {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
      throw error;
    }
  }

  it("releases a valid claim back to the queue", async () => {
    const jobId = await createClaimedJobForRelease();

    try {
      expect(
        await releaseClaimedJob(jobId, TEST_WORKER_ID),
      ).toBe(true);

      const stored = await pool.query<{
        status: string;
        locked_by: string | null;
        locked_until: Date | null;
      }>(
        `SELECT status, locked_by, locked_until
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      expect(stored.rows[0].status).toBe("queued");
      expect(stored.rows[0].locked_by).toBeNull();
      expect(stored.rows[0].locked_until).toBeNull();
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });

  it("does not release a job owned by another worker", async () => {
    const jobId = await createClaimedJobForRelease();

    try {
      await pool.query(
        `UPDATE jobs
         SET locked_by = 'another-worker'
         WHERE id = $1`,
        [jobId],
      );

      expect(
        await releaseClaimedJob(jobId, TEST_WORKER_ID),
      ).toBe(false);

      const stored = await pool.query<{
        status: string;
        locked_by: string;
      }>(
        `SELECT status, locked_by
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      expect(stored.rows[0].status).toBe("running");
      expect(stored.rows[0].locked_by).toBe("another-worker");
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });

  it("does not release an expired lease", async () => {
    const jobId = await createClaimedJobForRelease();

    try {
      await pool.query(
        `UPDATE jobs
         SET locked_until = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [jobId],
      );

      expect(
        await releaseClaimedJob(jobId, TEST_WORKER_ID),
      ).toBe(false);

      const stored = await pool.query<{ status: string }>(
        `SELECT status
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      expect(stored.rows[0].status).toBe("running");
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });
});
