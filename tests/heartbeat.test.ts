
import { describe, expect, it, vi } from "vitest";
import { renewLeaseSafely } from "../src/jobs/job.heartbeat.js";

describe("renewLeaseSafely", () => {
  it("reports a successful renewal", async () => {
    await expect(
      renewLeaseSafely(async () => true),
    ).resolves.toEqual({ status: "renewed" });
  });

  it("reports confirmed lease loss", async () => {
    await expect(
      renewLeaseSafely(async () => false),
    ).resolves.toEqual({ status: "lease-lost" });
  });

  it("reports a database error as uncertain ownership", async () => {
    const error = new Error("Database unavailable");
    const renew = vi.fn().mockRejectedValue(error);

    await expect(renewLeaseSafely(renew)).resolves.toEqual({
      status: "uncertain",
      error,
    });

    expect(renew).toHaveBeenCalledOnce();
  });
});
