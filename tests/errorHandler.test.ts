import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiErrorHandler } from "../src/middleware/errorHandler.js";

describe("API error handler", () => {
  function createTestApp() {
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    app.post("/test", (_req, res) => res.status(200).json({ ok: true }));
    app.use(apiErrorHandler);
    return app;
  }

  it("returns 413 for a request body that exceeds the configured limit", async () => {
    const response = await request(createTestApp())
      .post("/test")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ value: "x".repeat(2_048) }));

    expect(response.status).toBe(413);
    expect(response.body.error).toBe("Request body too large");
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await request(createTestApp())
      .post("/test")
      .set("Content-Type", "application/json")
      .send('{"incomplete":');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Malformed JSON request");
  });
});
