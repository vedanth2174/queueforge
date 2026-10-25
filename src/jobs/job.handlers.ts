
export type Job = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

export type JobContext = {
  idempotencyKey: string;
};

export type JobHandler = (
  job: Job,
  context: JobContext,
) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

async function handleEmail(
  job: Job,
  context: JobContext,
): Promise<unknown> {
  const to = job.payload.to;

  if (typeof to !== "string" || to.trim().length === 0) {
    throw new Error("Email job requires a valid 'to' field");
  }

  // Simulated only; no real email is sent.
  // A real provider should receive context.idempotencyKey
  // if it supports idempotent requests.
  console.log(
    `Simulating email to: ${to} (key: ${context.idempotencyKey})`,
  );

  return {
    accepted: true,
    simulated: true,
    to,
    idempotencyKey: context.idempotencyKey,
  };
}

handlers.set("email", handleEmail);

export function registerJobHandler(
  type: string,
  handler: JobHandler,
): void {
  const normalizedType = type.trim();

  if (!normalizedType) {
    throw new Error("Job handler type cannot be empty");
  }

  if (handlers.has(normalizedType)) {
    throw new Error(
      `A handler is already registered for job type: ${normalizedType}`,
    );
  }

  handlers.set(normalizedType, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export async function executeJob(
  job: Job,
  context: JobContext,
): Promise<unknown> {
  const handler = getJobHandler(job.type);

  if (!handler) {
    throw new Error(`Unsupported job type: ${job.type}`);
  }

  return handler(job, context);
}
