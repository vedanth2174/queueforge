
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";
import { recoverExpiredJobs } from "../src/jobs/job.worker.js";

describe("QueueForge API", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("returns a successful liveness check", async () => {
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "queueforge",
    });
  });

  it("rejects an invalid job payload", async () => {
    const response = await request(app).post("/api/v1/jobs").send({
      type: "",
      payload: {},
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid job data");
  });

  it("returns 404 for a job that does not exist", async () => {
    const response = await request(app).get(
      "/api/v1/jobs/00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Job not found");
  });

  it("creates a job and deduplicates an identical request", async () => {
    const key = `test-${randomUUID()}`;

    const payload = {
      type: "email",
      payload: { to: "test@example.com" },
      priority: 5,
    };

    const first = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send(payload);

    expect(first.status).toBe(201);
    expect(first.body.job.id).toBeDefined();
    expect(first.body.deduplicated).toBe(false);

    const second = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send(payload);

    expect(second.status).toBe(200);
    expect(second.body.job.id).toBe(first.body.job.id);
    expect(second.body.deduplicated).toBe(true);
  });

  it("deduplicates equivalent JSON payloads with reordered keys", async () => {
    const key = `test-${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: {
          to: "test@example.com",
          metadata: { source: "test", version: 1 },
        },
        priority: 5,
      });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        priority: 5,
        payload: {
          metadata: { version: 1, source: "test" },
          to: "test@example.com",
        },
        type: "email",
      });

    expect(second.status).toBe(200);
    expect(second.body.job.id).toBe(first.body.job.id);
    expect(second.body.deduplicated).toBe(true);
  });

  it("rejects reuse of an idempotency key with different payload data", async () => {
    const key = `test-${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: { to: "first@example.com" },
        priority: 5,
      });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: { to: "different@example.com" },
        priority: 5,
      });

    expect(second.status).toBe(409);
  });

  it("rejects reuse of an idempotency key with a different runAt", async () => {
    const key = `test-${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: { to: "schedule@example.com" },
        priority: 5,
        runAt: "2030-01-01T10:00:00.000Z",
      });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: { to: "schedule@example.com" },
        priority: 5,
        runAt: "2030-01-02T10:00:00.000Z",
      });

    expect(second.status).toBe(409);
  });

  it("rejects reuse when runAt is omitted from a previously scheduled request", async () => {
    const key = `test-${randomUUID()}`;

    const first = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: { to: "schedule@example.com" },
        priority: 5,
        runAt: "2030-01-01T10:00:00.000Z",
      });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", key)
      .send({
        type: "email",
        payload: { to: "schedule@example.com" },
        priority: 5,
      });

    expect(second.status).toBe(409);
  });

  it("creates only one job for concurrent requests with the same key", async () => {
    const key = `test-${randomUUID()}`;

    const payload = {
      type: "email",
      payload: { to: "concurrent@example.com" },
      priority: 5,
    };

    const [first, second] = await Promise.all([
      request(app)
        .post("/api/v1/jobs")
        .set("Idempotency-Key", key)
        .send(payload),
      request(app)
        .post("/api/v1/jobs")
        .set("Idempotency-Key", key)
        .send(payload),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.job.id).toBe(second.body.job.id);

    const count = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM jobs
       WHERE idempotency_key = $1`,
      [key],
    );

    expect(count.rows[0].count).toBe(1);
  });

  it("rejects an empty idempotency key", async () => {
    const response = await request(app)
      .post("/api/v1/jobs")
      .set("Idempotency-Key", "   ")
      .send({
        type: "email",
        payload: { to: "test@example.com" },
        priority: 5,
      });

    expect(response.status).toBe(400);
  });

  it("recovers jobs with expired worker leases", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO jobs (
         type, payload, status, attempts, max_attempts,
         locked_by, locked_until
       )
       VALUES (
         'email', '{"to":"recovery-test@example.com"}'::jsonb,
         'running', 1, 3, 'crashed-worker',
         NOW() - INTERVAL '10 seconds'
       )
       RETURNING id`,
    );

    const jobId = inserted.rows[0].id;

    try {
      const recoveredCount = await recoverExpiredJobs();

      const result = await pool.query(
        `SELECT status, locked_by, locked_until, last_error
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      expect(recoveredCount).toBeGreaterThanOrEqual(1);
      expect(result.rows[0].status).toBe("queued");
      expect(result.rows[0].locked_by).toBeNull();
      expect(result.rows[0].locked_until).toBeNull();
      expect(result.rows[0].last_error).toContain("lease expired");
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });

  it("marks an expired job dead when max attempts are exhausted", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO jobs (
         type, payload, status, attempts, max_attempts,
         locked_by, locked_until
       )
       VALUES (
         'email', '{"to":"dead-test@example.com"}'::jsonb,
         'running', 3, 3, 'crashed-worker',
         NOW() - INTERVAL '10 seconds'
       )
       RETURNING id`,
    );

    const jobId = inserted.rows[0].id;

    try {
      await recoverExpiredJobs();

      const result = await pool.query(
        `SELECT status, locked_by, locked_until
         FROM jobs
         WHERE id = $1`,
        [jobId],
      );

      expect(result.rows[0].status).toBe("dead");
      expect(result.rows[0].locked_by).toBeNull();
      expect(result.rows[0].locked_until).toBeNull();
    } finally {
      await pool.query("DELETE FROM jobs WHERE id = $1", [jobId]);
    }
  });

  it("returns job counts from the metrics endpoint", async () => {
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.body.service).toBe("queueforge");
    expect(response.body.jobs).toEqual(
      expect.objectContaining({
        queued: expect.any(Number),
        running: expect.any(Number),
        completed: expect.any(Number),
        dead: expect.any(Number),
      }),
    );
  });
  
  it("returns ready when the database is available", async () => {
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ready",
      database: "connected",
    });
  });

  it("rejects malformed JSON with a 400 response", async () => {
    const response = await request(app)
      .post("/api/v1/jobs")
      .set("Content-Type", "application/json")
      .send('{"type":');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Malformed JSON request");
  });

});
