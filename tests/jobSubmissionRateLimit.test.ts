import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createIpRateLimiter } from "../src/middleware/jobSubmissionRateLimit.js";

describe("job submission rate limiter", () => {
  it("returns 429 after the per-IP limit and resets after the window", async () => {
    let currentTime = 1_000;
    const app = express();
    app.post(
      "/jobs",
      createIpRateLimiter({
        windowMs: 60_000,
        max: 2,
        now: () => currentTime,
      }),
      (_req, res) => res.status(201).json({ created: true }),
    );

    expect((await request(app).post("/jobs")).status).toBe(201);
    expect((await request(app).post("/jobs")).status).toBe(201);

    const limited = await request(app).post("/jobs");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain("Too many job submissions");
    expect(limited.headers["retry-after"]).toBeDefined();

    currentTime += 60_000;
    expect((await request(app).post("/jobs")).status).toBe(201);
  });
});
