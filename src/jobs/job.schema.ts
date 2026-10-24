
import { z } from "zod";

export const createJobSchema = z.object({
  type: z.string().trim().min(1).max(100),

  payload: z.record(z.string(), z.unknown()),

  priority: z.number().int().min(0).max(10).default(0),

  maxAttempts: z.number().int().min(1).max(10).default(3),

  runAt: z.iso.datetime({ offset: true }).optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
