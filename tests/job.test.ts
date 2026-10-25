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

  it("rejects reuse of an idempotency key with different data", async () => {
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

  it("recovers jobs with expired worker leases", async () => {
    const inserted = await pool.query(
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
  });

  it("marks an expired job dead when max attempts are exhausted", async () => {
    const inserted = await pool.query(
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
});
