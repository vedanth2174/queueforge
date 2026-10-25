
import { describe, expect, it } from "vitest";
import {
  executeJob,
  getJobHandler,
  registerJobHandler,
} from "../src/jobs/job.handlers.js";

describe("Job handler registry", () => {
  it("registers the email handler", () => {
    expect(getJobHandler("email")).toBeTypeOf("function");
  });

  it("executes an email job", async () => {
    const result = await executeJob(
      {
        id: "test-email",
        type: "email",
        payload: { to: "test@example.com" },
      },
      {
        idempotencyKey: "queueforge:test-email",
      },
    );

    expect(result).toEqual({
      accepted: true,
      simulated: true,
      to: "test@example.com",
      idempotencyKey: "queueforge:test-email",
    });
  });

  it("rejects an email job without a valid recipient", async () => {
    await expect(
      executeJob(
        {
          id: "invalid-email",
          type: "email",
          payload: {},
        },
        {
          idempotencyKey: "queueforge:invalid-email",
        },
      ),
    ).rejects.toThrow("Email job requires a valid 'to' field");
  });

  it("executes a custom registered handler", async () => {
    const type = "test-custom-handler";

    registerJobHandler(type, async (job) => ({
      processed: true,
      id: job.id,
    }));

    await expect(
      executeJob(
        {
          id: "custom-1",
          type,
          payload: {},
        },
        {
          idempotencyKey: "queueforge:custom-1",
        },
      ),
    ).resolves.toEqual({
      processed: true,
      id: "custom-1",
    });
  });

  it("passes the same idempotency key on repeated executions", async () => {
    const type = "test-idempotency-key";
    const receivedKeys: string[] = [];

    registerJobHandler(type, async (_job, context) => {
      receivedKeys.push(context.idempotencyKey);
      return { processed: true };
    });

    const job = {
      id: "retry-job-1",
      type,
      payload: {},
    };

    const context = {
      idempotencyKey: `queueforge:${job.id}`,
    };

    await executeJob(job, context);
    await executeJob(job, context);

    expect(receivedKeys).toEqual([
      "queueforge:retry-job-1",
      "queueforge:retry-job-1",
    ]);
  });

  it("rejects duplicate handler registration", () => {
    const type = "test-duplicate-handler";

    registerJobHandler(type, async () => null);

    expect(() => registerJobHandler(type, async () => null)).toThrow(
      `A handler is already registered for job type: ${type}`,
    );
  });

  it("rejects an empty handler type", () => {
    expect(() => registerJobHandler("   ", async () => null)).toThrow(
      "Job handler type cannot be empty",
    );
  });

  it("rejects unsupported job types", async () => {
    await expect(
      executeJob(
        {
          id: "unknown-job",
          type: "unknown",
          payload: {},
        },
        {
          idempotencyKey: "queueforge:unknown-job",
        },
      ),
    ).rejects.toThrow("Unsupported job type: unknown");
  });
});
