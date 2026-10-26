import type { RequestHandler } from "express";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  now?: () => number;
};

type WindowCounter = {
  windowStartedAt: number;
  count: number;
};

/**
 * Small process-local fixed-window rate limiter. Use a shared store for
 * multi-instance production deployments; this is a lightweight API guardrail.
 */
export function createIpRateLimiter({
  windowMs,
  max,
  now = Date.now,
}: RateLimitOptions): RequestHandler {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("Rate-limit windowMs must be a positive integer");
  }
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error("Rate-limit max must be a positive integer");
  }

  const counters = new Map<string, WindowCounter>();

  return (req, res, next) => {
    const currentTime = now();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let counter = counters.get(key);

    if (!counter || currentTime - counter.windowStartedAt >= windowMs) {
      counter = { windowStartedAt: currentTime, count: 0 };
      counters.set(key, counter);
    }

    counter.count += 1;
    const remaining = Math.max(0, max - counter.count);
    const resetAfterSeconds = Math.max(
      1,
      Math.ceil((counter.windowStartedAt + windowMs - currentTime) / 1000),
    );

    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetAfterSeconds));

    if (counter.count > max) {
      res.setHeader("Retry-After", String(resetAfterSeconds));
      res.status(429).json({
        error: "Too many job submissions. Please retry later.",
      });
      return;
    }

    // Bound stale key retention if a large number of client IPs hit the API.
    if (counters.size > 5_000) {
      for (const [clientIp, clientCounter] of counters) {
        if (currentTime - clientCounter.windowStartedAt >= windowMs) {
          counters.delete(clientIp);
        }
      }
    }

    next();
  };
}

function configuredSubmissionLimit(): number {
  const configured = Number(process.env.JOB_SUBMISSION_RATE_LIMIT ?? "60");
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 60;
}

export const jobSubmissionRateLimit = createIpRateLimiter({
  windowMs: 60_000,
  max: configuredSubmissionLimit(),
});
